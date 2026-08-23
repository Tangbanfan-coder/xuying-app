// 章节序号由应用统一拼接与展示，章节标题本身只存纯文本，不包含“第N章”前缀。
// 模型常模仿上下文里的展示格式把序号写进标题返回，且污染过的标题会随轮次滚雪球
// （“第一章 第一章 …”），因此入库与迁移前都要剥掉全部连续前缀；分隔符允许缺省，
// 覆盖模型逐字复述污染标题的粘连形式。
const LEADING_CHAPTER_ORDER_PREFIXES = /^(?:第[0-9〇零一二两三四五六七八九十百千]+章[\s·・:：、.。\-—]*)+/

export function stripChapterOrderPrefixes(rawTitle: string): string {
  return rawTitle.replace(LEADING_CHAPTER_ORDER_PREFIXES, '').trim()
}

const CHINESE_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 章节号用汉字数字展示（第一章、第二十三章）；超出可读范围或非法时回退阿拉伯数字。 */
export function chineseChapterNumber(order: number): string {
  if (!Number.isInteger(order) || order <= 0 || order > 9999) return String(order)
  const thousands = Math.floor(order / 1000)
  const hundreds = Math.floor((order % 1000) / 100)
  const tens = Math.floor((order % 100) / 10)
  const ones = order % 10
  let label = ''
  if (thousands) label += CHINESE_DIGITS[thousands] + '千'
  if (hundreds) label += CHINESE_DIGITS[hundreds] + '百'
  if (tens) {
    if (!hundreds && thousands) label += '零'
    label += (tens === 1 && !label ? '' : CHINESE_DIGITS[tens]) + '十'
    if (ones) label += CHINESE_DIGITS[ones]
  } else if (ones) {
    if (hundreds || thousands) label += '零'
    label += CHINESE_DIGITS[ones]
  }
  return label
}

// 展示层统一以“第N章 · 标题”呈现带序号的章节名；标题只存纯文本，序号由这里按 order 拼接。
export function formatOrderedChapterTitle(order: number, rawTitle: string): string {
  return `第${chineseChapterNumber(order)}章 · ${rawTitle.trim() || '未命名章节'}`
}
