import { describe, expect, it, vi } from 'vitest'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'
import { analyzeProseStyle, parseModelProseAnalysis } from '../writing/proseAnalysis'

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

const issue = (overrides: Partial<Record<string, unknown>> = {}) => ({
  paragraph_index: 0, category: 'rhythm', severity: 'hint', confidence: 0.8, explanation: 'x', rewrite_goal: 'y', ...overrides,
})

describe('prose model analysis parsing', () => {
  it('parses empty model output without inventing issues', () => {
    expect(parseModelProseAnalysis('{"issues":[]}', ['具体动作。'])).toEqual([[]])
  })

  it('parses an open risk category not represented by a local rule', () => {
    const result = parseModelProseAnalysis(JSON.stringify({ issues: [{ paragraph_index: 0, category: 'scene-detachment', severity: 'warning', confidence: 0.84, explanation: '抽象判断替代了现场动作。', rewrite_goal: '补出人物此刻可观察的动作或物件变化。', matched_text: '一种说不清的感觉' }] }), ['一种说不清的感觉漫上心头。'])
    expect(result[0][0]).toMatchObject({ ruleId: 'model-scene-detachment', category: 'scene-detachment', source: 'text-model', confidence: 0.84, matchedText: '一种说不清的感觉' })
  })

  it('keeps valid findings and drops malformed ones instead of discarding the batch', () => {
    const payload = { issues: [
      issue({ paragraph_index: 9 }), // invalid index -> dropped
      issue({ category: 'unknown' }), // unknown category -> dropped
      issue({ confidence: 1.5 }), // out-of-range confidence -> dropped
      issue({ explanation: '' }), // missing explanation -> dropped
      issue({ confidence: 0.4 }), // below calibrated floor -> dropped
      issue(), // fully valid
      issue({ paragraph_index: 1, extra: true }), // unknown fields are ignored, finding kept
      issue({ paragraph_index: 2, category: 'abstractness', matched_text: '不存在于段落', explanation: 'x2', rewrite_goal: 'y2' }), // drifted evidence degrades to none
    ] }
    const result = parseModelProseAnalysis(JSON.stringify(payload), ['第一段内容。', '第二段内容。', '第三段内容。'])
    expect(result[0]).toHaveLength(1)
    expect(result[1][0].ruleId).toBe('model-rhythm')
    expect(result[2][0]).toMatchObject({ ruleId: 'model-abstractness' })
    expect(result[2][0].matchedText).toBeUndefined()
  })

  it('keeps at most two findings per paragraph ranked by confidence', () => {
    const payload = { issues: [
      issue({ category: 'rhythm', confidence: 0.6, explanation: 'x1', rewrite_goal: 'y1' }),
      issue({ category: 'abstractness', confidence: 0.9, explanation: 'x2', rewrite_goal: 'y2' }),
      issue({ category: 'voice-mismatch', confidence: 0.75, explanation: 'x3', rewrite_goal: 'y3' }),
    ] }
    const result = parseModelProseAnalysis(JSON.stringify(payload), ['段落。'])
    expect(result[0].map((item) => item.confidence)).toEqual([0.9, 0.75])
  })

  it('still rejects global protocol violations', () => {
    expect(() => parseModelProseAnalysis('```json\n{"issues":[]}\n```', ['段落。'])).toThrow('严格 JSON')
    expect(() => parseModelProseAnalysis('{"no_issues":[]}', ['段落。'])).toThrow('有效 issues 数组')
    expect(() => parseModelProseAnalysis('{"issues":[]}', Array.from({ length: 25 }, () => '段落。'))).toThrow('24 段')
    expect(() => parseModelProseAnalysis('not json', ['段落。'])).toThrow('严格 JSON')
  })
})

describe('prose model analysis request shape', () => {
  it('uses non-streaming auxiliary requests and preserves paragraph indexing within one batch', async () => {
    const { transport, getRequests } = transportWith('{"issues":[{"paragraph_index":1,"category":"rhythm","severity":"hint","confidence":0.8,"explanation":"节奏过于均匀。","rewrite_goal":"让句长和动作推进出现变化。"}]}')
    const result = await analyzeProseStyle({ paragraphs: ['第一段。', '第二段。'] }, config, transport)
    expect(result).toEqual([[], [expect.objectContaining({ ruleId: 'model-rhythm' })]])
    const body = JSON.parse(String(getRequests()[0]?.body))
    expect(body.stream).toBe(false)
    expect(body.messages[0].content).toContain('只返回 JSON')
    expect(getRequests()[0]?.androidTransport).toBe('native')
  })

  it('respects strict-relay prompt-only capability while retaining strict parser validation', async () => {
    const { transport, getRequests } = transportWith('{"issues":[]}')
    await analyzeProseStyle({ paragraphs: ['第一段。'] }, { ...config, capabilities: { structuredOutput: 'prompt_only' } }, transport)
    const body = JSON.parse(String(getRequests()[0]?.body))
    expect(body.stream).toBe(false)
    expect(body.response_format).toBeUndefined()
  })

  it('sends more than twelve paragraphs as sequential batches with re-anchored indices', async () => {
    const paragraphs = Array.from({ length: 13 }, (_, index) => `第${index}段正文内容。`)
    const firstBatch = { issues: [{ ...issue({ paragraph_index: 0 }), explanation: 'batch-one' }] }
    const secondBatch = { issues: [{ ...issue({ paragraph_index: 0, confidence: 0.7 }), explanation: 'batch-two' }] }
    const { transport, getRequests } = transportWith([JSON.stringify(firstBatch), JSON.stringify(secondBatch)])
    const result = await analyzeProseStyle({ paragraphs }, config, transport)
    expect(getRequests()).toHaveLength(2)
    expect(JSON.parse(String(getRequests()[0]?.body)).messages[1].content).toContain('第0段')
    expect(JSON.parse(String(getRequests()[1]?.body)).messages[1].content).toContain('第12段')
    expect(result[0][0]).toMatchObject({ ruleId: 'model-rhythm', explanation: 'batch-one' })
    expect(result[12][0]).toMatchObject({ ruleId: 'model-rhythm', confidence: 0.7 })
  })

  it('fails the whole analysis when a later batch errors so results never half-land silently', async () => {
    const paragraphs = Array.from({ length: 13 }, (_, index) => `第${index}段。`)
    const failing = {
      request: vi.fn(async (input: TransportRequest) => {
        if (String(input.body).includes('第12段')) throw new Error('provider down')
        return { status: 200, data: { choices: [{ message: { content: '{"issues":[]}' } }] } }
      }),
      stream: vi.fn(),
    } as unknown as HttpTransport
    await expect(analyzeProseStyle({ paragraphs }, config, failing)).rejects.toThrow('provider down')
  })
})
