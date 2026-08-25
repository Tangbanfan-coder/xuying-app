import { describe, expect, it } from 'vitest'
import { detectProseStyleIssues, PROSE_STYLE_RULES, rewritePreferenceForRule } from './proseStyle'

describe('rewritePreferenceForRule', () => {
  it('covers every local rule with a valid generation-side instruction', () => {
    const dimensions = new Set(['plot', 'character', 'dialogue', 'pace', 'description', 'rhetoric', 'emotion', 'ending'])
    for (const rule of PROSE_STYLE_RULES) {
      const preference = rewritePreferenceForRule(rule.id)
      expect(preference, `missing rewrite preference for ${rule.id}`).toBeDefined()
      expect(dimensions.has(preference!.dimension)).toBe(true)
      expect(/^(?:后续|继续|避免|少用|多用|保持|让)/.test(preference!.instruction)).toBe(true)
      expect(preference!.instruction.length).toBeLessThanOrEqual(180)
    }
    expect(rewritePreferenceForRule('unknown-rule')).toBeUndefined()
  })

  it('bans template pairings without banning the rhetorical device itself', () => {
    expect(rewritePreferenceForRule('generic-animal-simile')?.instruction).toContain('新颖喻体')
    for (const preference of ['generic-animal-simile', 'template-calm-as-everyday'].map((id) => rewritePreferenceForRule(id)!)) {
      expect(preference.instruction).not.toMatch(/不得使用比喻|禁止比喻|不要用比喻/)
    }
  })
})

describe('detectProseStyleIssues', () => {
  it('uses stable rule ids for representative novel style patterns', () => {
    const paragraphs = [
      '他说得非常平静，好像只是在讨论今天吃什么。',
      '她像一只警觉的猫一样退开，一种复杂的情绪涌上心头。',
      '“不用了。”他说，语气里带着不容拒绝的坚定。',
      '这一刻，他终于明白了人生真正的意义。',
    ]
    expect(detectProseStyleIssues(paragraphs).map((issues) => issues.map((issue) => issue.ruleId))).toEqual([
      ['template-calm-as-everyday'],
      ['generic-animal-simile', 'abstract-emotion-telling'],
      ['dialogue-explained-afterward'],
      ['generic-elevated-ending'],
    ])
    expect(new Set(PROSE_STYLE_RULES.map((rule) => rule.id)).size).toBe(PROSE_STYLE_RULES.length)
  })

  it('flags every contrast construction, including single concrete corrections', () => {
    expect(detectProseStyleIssues(['这不是钥匙，而是一枚旧徽章。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['“不是我。”她说，“是门外的人。”'])[0]).toEqual([])
    expect(detectProseStyleIssues(['那不是迟疑，而是恐惧；不是退缩，而是等待。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['她呼吸一滞，随即关上窗。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['她呼吸一滞，眸光一闪，指节泛白。'])[0].map((issue) => issue.ruleId)).toContain('stock-physical-reaction')
  })

  it('covers contrast variants beyond the literal 不是…而是 form', () => {
    for (const text of ['那不像是拒绝，更像是疲惫。', '这并非失败，而是一次校准。', '那不再是等待，就是放弃。']) {
      expect(detectProseStyleIssues([text])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    }
    const two = detectProseStyleIssues(['窗台上的不是灰尘，而是一层薄霜。', '他摇摇头，那不是敷衍，就是默许。'])
    expect(two[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(two[1].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
  })

  it('does not flag concrete prose without the targeted patterns', () => {
    const result = detectProseStyleIssues(['她把钥匙压进掌心，等脚步越过楼梯口才开门。', '门缝里没有光。'])
    expect(result).toEqual([[], []])
  })

  it('covers free-form animal similes and dialogue-only template warnings', () => {
    expect(detectProseStyleIssues(['她好像一只偷腥成功的猫，悄悄把糖纸塞进口袋。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['他像只偷腥的狐狸，笑着避开她的眼睛。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['她像一只小鹿般缩到窗边。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['门口好像有一只猫，正在啃鱼骨。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['“不是我，而是他拿走了信。”她说。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['这不是钥匙，而是一枚旧徽章。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['那不是笑意，而是一种无声的警告。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['那不是门响，而是风吹动了插销。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['这不是迟疑，而是等待。', '那不是拒绝，而是试探。', '门后的声音不是哭声，而是水管在响。']).every((issues) => issues.some((issue) => issue.ruleId === 'contrast-not-but-density'))).toBe(true)
    expect(detectProseStyleIssues(['“如果你再骗我，以后我就不见你了。”'])[0].map((issue) => issue.ruleId)).toContain('conditional-dialogue-ultimatum')
  })

  it('covers the widened vocabulary added after real-world misses', () => {
    expect(detectProseStyleIssues(['他说得很平静，像是在聊今天的天气。'])[0].map((issue) => issue.ruleId)).toContain('template-calm-as-everyday')
    expect(detectProseStyleIssues(['她像一只受惊的雀，扑棱着退到墙角。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['“那才叫真正的强大。”'])[0].map((issue) => issue.ruleId)).toContain('concept-label-this-is-called')
    expect(detectProseStyleIssues(['“你这不是批评，我这是在帮你争取机会。”'])[0].map((issue) => issue.ruleId)).toContain('defensive-benefactive-reframing')
    expect(detectProseStyleIssues(['一种说不清道不明的心绪袭来。'])[0].map((issue) => issue.ruleId)).toContain('abstract-emotion-telling')
    expect(detectProseStyleIssues(['他后背发凉，喉咙发紧。'])[0].map((issue) => issue.ruleId)).toContain('stock-physical-reaction')
    expect(detectProseStyleIssues(['“行了。”话中藏着一丝不耐。'])[0].map((issue) => issue.ruleId)).toContain('dialogue-explained-afterward')
    expect(detectProseStyleIssues(['尾声：一切都将改变。'])[0].map((issue) => issue.ruleId)).toContain('generic-elevated-ending')
  })

  it('flags rhetorical “this is called” labels without rewriting or mistaking ordinary language for one', () => {
    const flagged = detectProseStyleIssues(['“这叫审美共享。”林晚理直气壮地摊开手。', '这就叫懂得分寸。', '这才叫真正的默契。'])
    expect(flagged.every((issues) => issues.some((issue) => issue.ruleId === 'concept-label-this-is-called'))).toBe(true)
    expect(detectProseStyleIssues(['这叫什么名字？', '这叫我怎么办。', '这里叫青石巷。', '这叫林晚。']).every((issues) => issues.length === 0)).toBe(true)
  })

  it('flags defensive reframing without treating ordinary “我这是” statements as a template', () => {
    const flagged = detectProseStyleIssues(['“什么破坏公物，我这是提前帮你打理好出场形象。”', '“我这不是管你，是替你挡麻烦。”'])
    expect(flagged.every((issues) => issues.some((issue) => issue.ruleId === 'defensive-benefactive-reframing'))).toBe(true)
    expect(detectProseStyleIssues(['我这是第一次来，不认识路。', '我这是在帮你拿书。']).every((issues) => issues.length === 0)).toBe(true)
  })

  it('flags statistically even sentence rhythm without any lexical whitelist', () => {
    const uniform = '他沿着走廊一直往前走，脚步声在身后慢慢散开。走廊两侧挂着几幅泛黄的旧画。画框边缘落了薄薄的一层灰。尽头的窗户透进来一小片发白的光。'
    const issue = detectProseStyleIssues([uniform])[0].find((item) => item.ruleId === 'uniform-sentence-rhythm')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('hint')
    expect(issue?.matchedText).toMatch(/^句长 \d+(\/\d+){3}$/)
  })

  it('keeps varied or short prose out of the rhythm rule', () => {
    const varied = '他推开房门。空的。桌上一只杯子里插着一支早就干透的花，花瓣碰一下就掉了下来。他在门口站了很久，最后还是把门轻轻带上了，像什么都没有看见一样。'
    expect(detectProseStyleIssues([varied])[0].some((issue) => issue.ruleId === 'uniform-sentence-rhythm')).toBe(false)
    expect(detectProseStyleIssues(['他停下脚步。目光落在桌上。那里放着一封信。信封没有封口。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['他沿着走廊一直往前走，脚步声在身后慢慢散开。走廊两侧挂着几幅泛黄的旧画。'])[0]).toEqual([])
  })
})
