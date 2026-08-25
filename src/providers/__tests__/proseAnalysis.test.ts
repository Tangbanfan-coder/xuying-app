import { describe, expect, it, vi } from 'vitest'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'
import { analyzeProseStyle, extractAnalysisJson, parseModelProseAnalysis } from '../writing/proseAnalysis'

const config: ProviderConfig = { id: 'text', name: '文本', baseUrl: 'https://example.com/v1', model: 'model', protocol: 'openai-compatible', secretRef: 'secret' }

function transportWith(responses: string | string[]) {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const requests: TransportRequest[] = []
  const transport = {
    request: vi.fn(async (input: TransportRequest) => {
      requests.push(input)
      const content = queue.shift() ?? queue[queue.length - 1]
      return { status: 200, data: { choices: [{ message: { content } }] } }
    }),
    stream: vi.fn(),
  } as unknown as HttpTransport
  return { transport, getRequests: () => requests }
}

const finding = (overrides: Partial<Record<string, unknown>> = {}) => ({
  paragraph_index: 0, quote: '她呼吸一滞', issue: '套路化身体反应', confidence: 0.8, ...overrides,
})

describe('prose model analysis parsing', () => {
  it('parses empty model output without inventing issues', () => {
    expect(parseModelProseAnalysis('{"findings":[]}', ['具体动作。'])).toEqual([[]])
  })

  it('derives category, severity and goal locally from a free-form finding', () => {
    const result = parseModelProseAnalysis(JSON.stringify({ findings: [finding({ quote: '一种说不清的感觉', issue: '抽象情绪标签代替具体场景描写' })] }), ['一种说不清的感觉漫上心头。'])
    expect(result[0][0]).toMatchObject({ ruleId: 'model-abstractness', category: 'abstractness', source: 'text-model', confidence: 0.8, matchedText: '一种说不清的感觉' })
    expect(result[0][0].rewriteGoal).not.toContain('undefined')
  })

  it('keeps valid findings and drops malformed ones instead of discarding the batch', () => {
    const payload = { findings: [
      finding({ paragraph_index: 9 }), // invalid index -> dropped
      finding({ quote: '' }), // empty quote -> dropped
      finding({ confidence: 1.5 }), // out-of-range confidence -> dropped
      finding({ issue: '' }), // missing explanation -> dropped
      finding({ confidence: 0.4 }), // below calibrated floor -> dropped
      finding(), // fully valid
      finding({ paragraph_index: 1, quote: '第二段内容', extra: true }), // unknown fields are ignored, finding kept
      finding({ paragraph_index: 2, quote: '不存在于段落', issue: 'x2' }), // hallucinated evidence -> dropped
    ] }
    const result = parseModelProseAnalysis(JSON.stringify(payload), ['第一段内容。她呼吸一滞。', '第二段内容。', '第三段内容。'])
    expect(result[0]).toHaveLength(1)
    expect(result[1][0].ruleId).toBe('model-template-pattern')
    expect(result[2]).toEqual([])
  })

  it('merges same-category findings of one paragraph into a single issue with joined quotes', () => {
    const payload = { findings: [
      finding({ quote: '她呼吸一滞', issue: '套路化身体反应模板', confidence: 0.8 }),
      finding({ quote: '眸光一闪', issue: '高频陈词滥调搭配', confidence: 0.9 }),
    ] }
    const result = parseModelProseAnalysis(JSON.stringify(payload), ['她呼吸一滞，眸光一闪。'])
    expect(result[0]).toHaveLength(1)
    expect(result[0][0]).toMatchObject({ ruleId: 'model-template-pattern', confidence: 0.9, matchedText: '她呼吸一滞；眸光一闪' })
  })

  it('keeps at most two categories per paragraph ranked by confidence', () => {
    const paragraphs = ['她呼吸一滞。', '清单式罗列了服饰。', '对白腔调脱离身份。']
    const payload = { findings: [
      finding({ paragraph_index: 0, quote: '她呼吸一滞', issue: '套路化身体反应模板', confidence: 0.6 }),
      finding({ paragraph_index: 1, quote: '清单式罗列', issue: '说明书式罗列服饰', confidence: 0.9 }),
      finding({ paragraph_index: 2, quote: '腔调脱离身份', issue: '对白腔调脱离人物身份', confidence: 0.75 }),
    ] }
    const result = parseModelProseAnalysis(JSON.stringify(payload), paragraphs)
    expect(result.map((issues) => issues[0]?.category)).toEqual(['template-pattern', 'scene-detachment', 'voice-mismatch'])
    expect(result.map((issues) => issues[0]?.severity)).toEqual(['hint', 'warning', 'hint'])
  })

  it('tolerates fenced or wrapped JSON around the findings object', () => {
    const body = JSON.stringify({ findings: [finding()] })
    for (const wrapped of [`\`\`\`json\n${body}\n\`\`\``, `前置说明\n${body}\n后置说明`]) {
      const result = parseModelProseAnalysis(wrapped, ['她呼吸一滞。'])
      expect(result[0]).toHaveLength(1)
    }
  })

  it('still rejects unrecoverable protocol violations', () => {
    expect(() => parseModelProseAnalysis('not json at all', ['段落。'])).toThrow('有效 JSON')
    expect(() => parseModelProseAnalysis('{"no_findings":[]}', ['段落。'])).toThrow('findings 数组')
  })

  it('extracts the outermost object when prose surrounds strict JSON', () => {
    expect(extractAnalysisJson('结果如下 {"findings":[]} 请参考').findings).toEqual([])
  })

  it('accepts chapter-length inputs beyond the old 24-paragraph cap', () => {
    const paragraphs = Array.from({ length: 40 }, () => '段落。')
    expect(parseModelProseAnalysis('{"findings":[]}', paragraphs)).toHaveLength(40)
  })
})

describe('prose model analysis request shape', () => {
  it('uses non-streaming auxiliary requests and preserves paragraph indexing within one batch', async () => {
    const { transport, getRequests } = transportWith('{"findings":[{"paragraph_index":1,"quote":"第二段","issue":"节奏过于均匀。","confidence":0.8}]}')
    const result = await analyzeProseStyle({ paragraphs: ['第一段。', '第二段。'] }, config, transport)
    expect(result).toEqual([[], [expect.objectContaining({ ruleId: 'model-rhythm' })]])
    const body = JSON.parse(String(getRequests()[0]?.body))
    expect(body.stream).toBe(false)
    expect(body.messages[0].content).toContain('只返回 JSON')
    expect(getRequests()[0]?.androidTransport).toBe('native')
  })

  it('never sends a structured-output schema so recall stays unconstrained', async () => {
    const { transport, getRequests } = transportWith(['{"findings":[]}', '{"findings":[]}'])
    await analyzeProseStyle({ paragraphs: ['第一段。'] }, config, transport)
    const body = JSON.parse(String(getRequests()[0]?.body))
    expect(body.response_format).toBeUndefined()
    await analyzeProseStyle({ paragraphs: ['第一段。'] }, { ...config, capabilities: { structuredOutput: 'json_schema' } }, transport)
    expect(JSON.parse(String(getRequests()[1]?.body)).response_format).toBeUndefined()
  })

  it('sends more than twelve paragraphs as sequential batches with re-anchored indices', async () => {
    const paragraphs = Array.from({ length: 13 }, (_, index) => `第${index}段正文内容。`)
    const firstBatch = { findings: [{ paragraph_index: 0, quote: '第0段正文内容', issue: 'batch-one', confidence: 0.8 }] }
    const secondBatch = { findings: [{ paragraph_index: 0, quote: '第12段正文内容', issue: 'batch-two', confidence: 0.7 }] }
    const { transport, getRequests } = transportWith([JSON.stringify(firstBatch), JSON.stringify(secondBatch)])
    const result = await analyzeProseStyle({ paragraphs }, config, transport)
    expect(getRequests()).toHaveLength(2)
    expect(JSON.parse(String(getRequests()[0]?.body)).messages[1].content).toContain('第0段')
    expect(JSON.parse(String(getRequests()[1]?.body)).messages[1].content).toContain('第12段')
    expect(result[0][0]).toMatchObject({ ruleId: 'model-template-pattern', explanation: 'batch-one' })
    expect(result[12][0]).toMatchObject({ ruleId: 'model-template-pattern', confidence: 0.7 })
  })

  it('fails the whole analysis when a later batch errors so results never half-land silently', async () => {
    const paragraphs = Array.from({ length: 13 }, (_, index) => `第${index}段。`)
    const failing = {
      request: vi.fn(async (input: TransportRequest) => {
        if (String(input.body).includes('第12段')) throw new Error('provider down')
        return { status: 200, data: { choices: [{ message: { content: '{"findings":[]}' } }] } }
      }),
      stream: vi.fn(),
    } as unknown as HttpTransport
    await expect(analyzeProseStyle({ paragraphs }, config, failing)).rejects.toThrow('provider down')
  })

  it('analyzes a full generated chapter in sequential batches without a paragraph-count cap', async () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `第${index}段正文内容，包含足够的细节。`)
    const { transport, getRequests } = transportWith(['{"findings":[]}', '{"findings":[]}', '{"findings":[]}'])
    const result = await analyzeProseStyle({ paragraphs }, config, transport)
    expect(getRequests()).toHaveLength(3)
    expect(result).toHaveLength(30)
    expect(JSON.parse(String(getRequests()[2]?.body)).messages[1].content).toContain('第24段')
  })
})
