import { describe, expect, it } from 'vitest'
import { chineseChapterNumber, formatOrderedChapterTitle, stripChapterOrderPrefixes } from './chapterTitle'

describe('stripChapterOrderPrefixes', () => {
  it('剥掉全部连续的章节序号前缀，含粘连形式', () => {
    expect(stripChapterOrderPrefixes('第一章 雾港')).toBe('雾港')
    expect(stripChapterOrderPrefixes('第12章：雾港')).toBe('雾港')
    expect(stripChapterOrderPrefixes('第十二章·雾港')).toBe('雾港')
    expect(stripChapterOrderPrefixes('第一章 第一章 雾港')).toBe('雾港')
    expect(stripChapterOrderPrefixes('第一章第一章 雾港')).toBe('雾港')
    expect(stripChapterOrderPrefixes('雨夜')).toBe('雨夜')
  })

  it('纯序号剥完为空', () => {
    expect(stripChapterOrderPrefixes('第一章')).toBe('')
    expect(stripChapterOrderPrefixes('第3章：')).toBe('')
  })
})

describe('chineseChapterNumber', () => {
  it.each([
    [1, '一'],
    [9, '九'],
    [10, '十'],
    [11, '十一'],
    [20, '二十'],
    [23, '二十三'],
    [100, '一百'],
    [105, '一百零五'],
    [110, '一百一十'],
    [123, '一百二十三'],
    [1000, '一千'],
    [1010, '一千零一十'],
    [2005, '二千零五'],
  ])('%i 转为 %s', (order, expected) => {
    expect(chineseChapterNumber(order)).toBe(expected)
  })

  it('非法或超范围值回退阿拉伯数字', () => {
    expect(chineseChapterNumber(0)).toBe('0')
    expect(chineseChapterNumber(-1)).toBe('-1')
    expect(chineseChapterNumber(10000)).toBe('10000')
    expect(chineseChapterNumber(1.5)).toBe('1.5')
  })
})

describe('formatOrderedChapterTitle', () => {
  it('以“第N章 · 标题”拼接，空标题回退未命名章节', () => {
    expect(formatOrderedChapterTitle(12, '雾港')).toBe('第十二章 · 雾港')
    expect(formatOrderedChapterTitle(3, '  ')).toBe('第三章 · 未命名章节')
  })
})
