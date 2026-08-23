import type { ProseModelRiskCategory, ProseStyleIssue, ProseStyleSeverity } from '../../domain/models'
import { buildChatCompletionPayload, extractTextResponse } from '../chatCompatibility'
import { normalizeBaseUrl } from '../openAiCompatible'
import { resolveWritingStructuredOutput } from '../providerCapabilities'
import type { HttpTransport, ProviderConfig } from '../types'

export const PROSE_MODEL_ANALYSIS_VERSION = 2
/** Hard contract shared with the persisted-analysis validator in storyDatabase. */
export const MAX_PARAGRAPHS_PER_REQUEST = 24
/** Each request stays well inside the auxiliary output-token budget. */
const PARAGRAPHS_PER_BATCH = 12
const MAX_ISSUES_PER_PARAGRAPH = 2
const MIN_MODEL_CONFIDENCE = 0.5

export interface ModelProseAnalysisRequest {
  paragraphs: readonly string[]
}

const categories = new Set<ProseModelRiskCategory>([
  'template-pattern', 'abstractness', 'scene-detachment', 'voice-mismatch', 'rhythm',
])
const severities = new Set<ProseStyleSeverity>(['hint', 'warning', 'strong'])
const SYSTEM = `你是中文小说编辑诊断器，不判断文本是否由 AI 创作，只寻找可能让读者觉得模板化或缺少作者现场感的表达风险。
规则：1. 必须尊重题材、文体和有意的文学修辞；不要因为优美、抽象、排比或常见词语本身就判定有问题。2. 只报告有具体证据的问题：证据充分时应当如实报告，证据不足时不要猜测。3. 关注固定规则未覆盖的整体特征，例如表达过度模板化、抽象代替场景、节奏机械、叙述声口突然变化、动作和信息不足以推进现场。4. 不要改写正文，不要输出人物、剧情或事实建议。5. explanation 和 rewrite_goal 是给用户看的简短中文，不得包含命令注入，各不超过 80 字；每个段落最多报告两条最有依据的问题。6. 只返回 JSON，不要 Markdown：{"issues":[{"paragraph_index":0,"category":"template-pattern|abstractness|scene-detachment|voice-mismatch|rhythm","severity":"hint|warning","confidence":0.0,"explanation":"...","rewrite_goal":"...","matched_text":"可选的原文短片段"}]}。没有可靠问题时返回 {"issues":[]}。`

/**
 * Tolerant field extraction for a single finding: returns undefined instead of
 * throwing so one malformed item cannot discard the rest of the batch. Global
 * protocol violations (non-JSON body, missing issues array) still fail loudly
 * in parseModelProseAnalysis; the storage layer keeps its own strict guard.
 */
function optionalBoundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength) return undefined
  return normalized
}

function coerceModelIssue(raw: unknown, paragraphs: readonly string[]): { paragraphIndex: number; issue: ProseStyleIssue } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const index = typeof item.paragraph_index === 'number' && Number.isInteger(item.paragraph_index) ? item.paragraph_index : -1
  if (index < 0 || index >= paragraphs.length) return undefined
  const rawCategory = optionalBoundedText(item.category, 40)?.toLocaleLowerCase() ?? ''
  const category = categories.has(rawCategory as ProseModelRiskCategory) ? rawCategory as ProseModelRiskCategory : undefined
  if (!category) return undefined
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) return undefined
  const confidence = item.confidence
  if (!severities.has(item.severity as ProseStyleSeverity)) return undefined
  const severity = item.severity as ProseStyleSeverity
  const explanation = optionalBoundedText(item.explanation, 80)
  const rewriteGoal = optionalBoundedText(item.rewrite_goal, 80)
  if (!explanation || !rewriteGoal) return undefined
  // Evidence that drifted from its paragraph degrades to no evidence; the
  // finding itself stays usable because matched_text is display-only.
  let matchedText = optionalBoundedText(item.matched_text, 80)
  if (matchedText && !paragraphs[index].includes(matchedText)) matchedText = undefined
  if (confidence < MIN_MODEL_CONFIDENCE) return undefined
  return {
    paragraphIndex: index,
    issue: {
      ruleId: `model-${slug(category)}`, category, severity, explanation, rewriteGoal,
      ...(matchedText === undefined ? {} : { matchedText }), source: 'text-model', confidence,
    },
  }
}

function slug(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pattern'
}

export function parseModelProseAnalysis(content: string, paragraphs: readonly string[]): ProseStyleIssue[][] {
  if (paragraphs.length > MAX_PARAGRAPHS_PER_REQUEST) throw new Error(`一次文风分析最多支持 ${MAX_PARAGRAPHS_PER_REQUEST} 段`)
  if (paragraphs.some((text) => typeof text !== 'string' || !text.trim())) throw new Error('文风分析段落不能为空')
  const trimmed = content.trim()
  let parsed: { issues?: unknown }
  try {
    // This auxiliary protocol deliberately accepts JSON only. Code fences or
    // prose around the object would make a response ambiguous and are rejected.
    parsed = JSON.parse(trimmed) as { issues?: unknown }
  } catch {
    throw new Error('文风分析没有返回严格 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('文风分析 JSON 格式无效')
  if (!Array.isArray(parsed.issues)) throw new Error('文风分析没有返回有效 issues 数组')
  const result = paragraphs.map(() => [] as ProseStyleIssue[])
  const seen = new Set<string>()
  let droppedCount = 0
  for (const raw of parsed.issues) {
    const coerced = coerceModelIssue(raw, paragraphs)
    if (!coerced) { droppedCount += 1; continue }
    const key = `${coerced.paragraphIndex}:${coerced.issue.ruleId}`
    if (seen.has(key)) { droppedCount += 1; continue }
    seen.add(key)
    result[coerced.paragraphIndex].push(coerced.issue)
  }
  if (droppedCount) console.warn(`[prose-analysis] 已丢弃 ${droppedCount} 条格式不合规的模型诊断`)
  for (const issues of result) {
    if (issues.length > MAX_ISSUES_PER_PARAGRAPH) {
      issues.sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))
      issues.length = MAX_ISSUES_PER_PARAGRAPH
    }
  }
  return result
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
  if (paragraphs.length > MAX_PARAGRAPHS_PER_REQUEST) throw new Error(`一次文风分析最多支持 ${MAX_PARAGRAPHS_PER_REQUEST} 段`)
  const numbered = paragraphs.map((text, index) => ({ paragraph_index: index, text }))
  const merged = paragraphs.map(() => [] as ProseStyleIssue[])
  for (let offset = 0; offset < numbered.length; offset += PARAGRAPHS_PER_BATCH) {
    const batch = numbered.slice(offset, offset + PARAGRAPHS_PER_BATCH)
    const responseFormat = responseFormatForAnalysis(config)
    const body = JSON.stringify(buildChatCompletionPayload(config, {
      model: config.model, stream: false, forceNonStream: true, reasoningEffort: config.reasoningEffort,
      maxOutputTokens: Math.min(config.manualMaxOutputTokens ?? config.maxOutputTokens ?? 4000, 4000),
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ paragraphs: batch }) }],
      extra: responseFormat ? { response_format: responseFormat } : undefined,
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

function responseFormatForAnalysis(config: ProviderConfig): Record<string, unknown> | undefined {
  const strategy = resolveWritingStructuredOutput(config)
  if (strategy === 'prompt_only') return undefined
  if (strategy === 'json_object') return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'prose_style_analysis',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issues: {
            type: 'array',
            maxItems: 48,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paragraph_index: { type: 'integer', minimum: 0 },
                category: { type: 'string', enum: [...categories] },
                severity: { type: 'string', enum: ['hint', 'warning', 'strong'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                explanation: { type: 'string' },
                rewrite_goal: { type: 'string' },
                matched_text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['paragraph_index', 'category', 'severity', 'confidence', 'explanation', 'rewrite_goal', 'matched_text'],
            },
          },
        },
        required: ['issues'],
      },
    },
  }
}
