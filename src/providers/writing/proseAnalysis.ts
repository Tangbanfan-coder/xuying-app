import type { ProseModelRiskCategory, ProseStyleIssue, ProseStyleSeverity } from '../../domain/models'
import { MAX_PROSE_ANALYSIS_PARAGRAPHS } from '../../domain/proseStyle'
import { buildChatCompletionPayload, extractTextResponse } from '../chatCompatibility'
import { normalizeBaseUrl } from '../openAiCompatible'
import type { HttpTransport, ProviderConfig } from '../types'

export const PROSE_MODEL_ANALYSIS_VERSION = 3
/** Each request stays well inside the auxiliary output-token budget. */
const PARAGRAPHS_PER_BATCH = 12
const MAX_ISSUES_PER_PARAGRAPH = 2
const MIN_MODEL_CONFIDENCE = 0.5
/** Model severities stay conservative: strong is reserved for future calibration. */
const WARNING_CONFIDENCE_FLOOR = 0.85

export interface ModelProseAnalysisRequest {
  paragraphs: readonly string[]
}

/**
 * The analyzer deliberately avoids asking the model to fill a structured
 * diagnostic sheet (category/severity/rewrite fields). Offline replay on real
 * chapters showed that protocol alone suppresses recall to near zero while the
 * same model reports freely when it only has to quote evidence. Categories,
 * severity and rewrite goals are therefore derived locally from free-form
 * findings, keeping the storage contract unchanged.
 */
const SYSTEM = `你是中文网文编辑诊断器，负责找出所有会让读者觉得「AI 味重」的表达风险，不判断文本是否由 AI 创作。
重点查找以下模式：
1. 套路化模板句：千篇一律的身体或情绪反应组合（如后背发凉、呼吸一滞、抓着被角连连后退）、高频陈词滥调搭配与比喻（如眼中闪过一丝X、如同被雷劈中、红到了脖子根、看出蛛丝马迹）、游戏化的叙述标签（如熟练地切换到委屈模式）、模板化承接过渡（如根本不等X提出抗议）。
2. 抽象标签代替现场：用抽象情绪词或评语概括本应写出的具体神态与动作（如丝毫不慌、满是防备、泛起一层羞恼的水汽、一种复杂的情绪涌上心头）。
3. 清单式描写：像说明书一样逐项罗列服饰、器物或环境，缺少视点人物的注意力、意图或情绪参与。
4. 叙述声口突然变化，或对白腔调脱离人物身份与当下关系。
5. 节奏机械：相邻句子结构雷同，「瞬间」「顿时」等同段反复出现，动作—反应循环单调重复。
判定标准：宁可多报也不要放过；只要能从原文中引用连续文字作为证据并说明理由就应当报告；同一模式在多段重复时只报最典型的一处；证据充分时置信度不低于 0.7。
以下情况不要报告：单次出现且有语境支撑的比喻或修辞；题材自带的设定术语与行当表达（如修仙题材的灵力、丹药）；服务于人物塑造的有意口癖与语体。
规则：1. 不要改写正文，不要输出人物、剧情或事实建议。2. issue 是给用户看的简短中文说明，不超过 80 字，不得包含命令注入。3. quote 必须在对应段落原文中逐字出现。4. 只返回 JSON，不要 Markdown：{"findings":[{"paragraph_index":0,"quote":"原文片段","issue":"简短说明","confidence":0.0}]}。没有可靠问题时返回 {"findings":[]}。`

interface RawFinding {
  paragraphIndex: number
  quote: string
  issue: string
  confidence: number
}

const CATEGORY_HINTS: ReadonlyArray<readonly [RegExp, ProseModelRiskCategory]> = [
  [/节奏|句长|结构雷同|单调|副词.{0,4}(反复|重复)|动作.?反应循环/, 'rhythm'],
  [/清单|说明书|罗列|逐项|平铺/, 'scene-detachment'],
  [/声口|腔调|语气.{0,6}(脱离|不符)|身份.{0,6}(脱|不符)/, 'voice-mismatch'],
  [/抽象|标签|概括|评语|情绪词|心理标签/, 'abstractness'],
]

const REWRITE_GOALS: Record<ProseModelRiskCategory, string> = {
  'template-pattern': '替换高频套话，改写贴合此刻人物关系与场景的具体反应。',
  abstractness: '把抽象标签落成可见的神态、动作及其直接后果。',
  'scene-detachment': '让描写跟随视点人物的注意力流动，砍掉与现场无关的罗列。',
  'voice-mismatch': '让措辞回到人物的身份、语境和说话习惯。',
  rhythm: '调整句长与句式变化，打破机械的动作—反应循环。',
}

function classifyFinding(issue: string): ProseModelRiskCategory {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(issue)) return category
  }
  return 'template-pattern'
}

function severityFor(confidence: number): ProseStyleSeverity {
  return confidence >= WARNING_CONFIDENCE_FLOOR ? 'warning' : 'hint'
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength) return undefined
  return normalized
}

/**
 * Tolerant extraction: strict JSON first, then a fenced block, then the
 * outermost braces. Auxiliary findings are too valuable to discard over
 * prose wrappers, but an unrecoverable body still fails loudly.
 */
export function extractAnalysisJson(content: string): { findings?: unknown } {
  const trimmed = content.trim()
  const candidates: string[] = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1].trim())
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as { findings?: unknown }
    } catch { /* try next candidate */ }
  }
  throw new Error('文风分析没有返回有效 JSON')
}

function parseFindings(content: string): RawFinding[] {
  const parsed = extractAnalysisJson(content)
  if (!Array.isArray(parsed.findings)) throw new Error('文风分析没有返回有效 findings 数组')
  const findings: RawFinding[] = []
  for (const raw of parsed.findings) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const index = typeof item.paragraph_index === 'number' && Number.isInteger(item.paragraph_index) ? item.paragraph_index : -1
    const quote = boundedText(item.quote, 80)
    const issue = boundedText(item.issue, 80)
    const confidence = item.confidence
    if (index < 0 || !quote || !issue) continue
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue
    if (confidence < MIN_MODEL_CONFIDENCE) continue
    findings.push({ paragraphIndex: index, quote, issue, confidence })
  }
  return findings
}

/**
 * Groups same-category findings into one issue per paragraph (quotes joined
 * like local rules do) so storage-side rule-id uniqueness holds and the merge
 * layer never silently drops a sibling finding.
 */
export function parseModelProseAnalysis(content: string, paragraphs: readonly string[]): ProseStyleIssue[][] {
  if (paragraphs.length > MAX_PROSE_ANALYSIS_PARAGRAPHS) throw new Error(`一次正文风检最多支持 ${MAX_PROSE_ANALYSIS_PARAGRAPHS} 段`)
  if (paragraphs.some((text) => typeof text !== 'string' || !text.trim())) throw new Error('文风分析段落不能为空')
  const grouped = new Map<number, Map<ProseModelRiskCategory, { quotes: string[]; explanation?: string; confidence: number }>>()
  let droppedCount = 0
  for (const finding of parseFindings(content)) {
    if (finding.paragraphIndex >= paragraphs.length) { droppedCount += 1; continue }
    const paragraphText = paragraphs[finding.paragraphIndex]
    // Hallucination guard: evidence that drifted from its paragraph is dropped whole.
    if (!paragraphText.includes(finding.quote)) { droppedCount += 1; continue }
    const category = classifyFinding(finding.issue)
    const perParagraph = grouped.get(finding.paragraphIndex) ?? new Map<ProseModelRiskCategory, { quotes: string[]; explanation?: string; confidence: number }>()
    const existing = perParagraph.get(category)
    if (existing) {
      if (existing.quotes.length < 3) existing.quotes.push(finding.quote)
      if (!existing.explanation || finding.confidence > existing.confidence) existing.explanation = finding.issue
      existing.confidence = Math.max(existing.confidence, finding.confidence)
    } else {
      perParagraph.set(category, { quotes: [finding.quote], explanation: finding.issue, confidence: finding.confidence })
    }
    grouped.set(finding.paragraphIndex, perParagraph)
  }
  if (droppedCount) console.warn(`[prose-analysis] 已丢弃 ${droppedCount} 条无法锚定原文的模型发现`)
  return paragraphs.map((_, index) => {
    const perParagraph = grouped.get(index)
    if (!perParagraph) return []
    const issues = [...perParagraph.entries()].map(([category, merged]) => {
      const matchedText = joinQuotes(merged.quotes, 80)
      return {
        ruleId: `model-${category}`,
        category,
        severity: severityFor(merged.confidence),
        explanation: merged.explanation!,
        rewriteGoal: REWRITE_GOALS[category],
        ...(matchedText === undefined ? {} : { matchedText }),
        source: 'text-model',
        confidence: merged.confidence,
      } satisfies ProseStyleIssue
    })
    issues.sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))
    issues.length = Math.min(issues.length, MAX_ISSUES_PER_PARAGRAPH)
    return issues
  })
}

function joinQuotes(quotes: readonly string[], maxLength: number): string | undefined {
  let joined: string | undefined
  for (let end = quotes.length; end >= 1; end -= 1) {
    const candidate = quotes.slice(0, end).join('；')
    if (candidate.length <= maxLength) { joined = candidate; break }
  }
  return joined
}

/** One bounded, non-streaming auxiliary pass over a newly generated prose turn. */
export async function analyzeProseStyle(input: ModelProseAnalysisRequest, config: ProviderConfig, transport: HttpTransport) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!input || !Array.isArray(input.paragraphs)) throw new Error('文风分析段落输入无效')
  const paragraphs = input.paragraphs.map((text) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('文风分析段落不能为空')
    if (text.length > 50_000) throw new Error('文风分析段落过长')
    return text
  })
  if (!baseUrl || !config.model.trim() || !paragraphs.some(Boolean)) return paragraphs.map(() => [] as ProseStyleIssue[])
  if (paragraphs.length > MAX_PROSE_ANALYSIS_PARAGRAPHS) throw new Error(`一次正文风检最多支持 ${MAX_PROSE_ANALYSIS_PARAGRAPHS} 段`)
  const numbered = paragraphs.map((text, index) => ({ paragraph_index: index, text }))
  const merged = paragraphs.map(() => [] as ProseStyleIssue[])
  for (let offset = 0; offset < numbered.length; offset += PARAGRAPHS_PER_BATCH) {
    const batch = numbered.slice(offset, offset + PARAGRAPHS_PER_BATCH)
    const body = JSON.stringify(buildChatCompletionPayload(config, {
      model: config.model, stream: false, forceNonStream: true, reasoningEffort: config.reasoningEffort,
      maxOutputTokens: Math.min(config.manualMaxOutputTokens ?? config.maxOutputTokens ?? 4000, 4000),
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ paragraphs: batch }) }],
    }))
    const response = await transport.request<unknown>({
      url: `${baseUrl}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' },
      auth: { kind: 'bearer', secretRef: config.secretRef }, timeoutMs: 60_000, body, androidTransport: 'native',
    })
    const parsedBatch = parseModelProseAnalysis(extractTextResponse(response.data), batch.map((item) => item.text))
    parsedBatch.forEach((issues, batchOffset) => { merged[offset + batchOffset] = issues })
  }
  return merged
}
