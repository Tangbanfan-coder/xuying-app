// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { loadProviderSettings, providersFor, savedModelPatch, switchActiveProvider, syncActiveModelIntoSaved } from './config'
import type { ProviderConfig, ProviderSettings } from './types'

const SETTINGS_KEY = 'illustrated-story-chat.provider-settings.v1'

function providerWith(savedModels: unknown): ProviderConfig {
  return {
    id: 'text-provider',
    name: '文本服务',
    baseUrl: 'https://api.test/v1',
    model: 'model-a',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
    contextLength: 8000,
    savedModels,
  } as ProviderConfig
}

describe('loadProviderSettings savedModels normalization', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('drops invalid and duplicate entries while keeping valid ones', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      text: providerWith([
        { id: 'model-a', contextLength: 8000 },
        { id: 'model-a', contextLength: 999 },
        { nope: true },
        { id: '' },
      ]),
    }))
    const settings = loadProviderSettings()
    expect(settings.text.savedModels).toEqual([{ id: 'model-a', contextLength: 8000 }])
  })

  it('normalizes savedModels inside the provider lists too', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      text: providerWith(undefined),
      textProviders: [providerWith([{ id: 'kept' }, 'bad'])],
    }))
    const settings = loadProviderSettings()
    expect(settings.textProviders[0].savedModels).toEqual([{ id: 'kept' }])
  })
})

describe('savedModelPatch', () => {
  it('restores every per-model field from the entry', () => {
    expect(savedModelPatch({
      id: 'model-b',
      contextLength: 128000,
      maxOutputTokens: 4096,
      manualContextLength: 222,
      manualMaxOutputTokens: 333,
      reasoningEffort: 'high',
    })).toEqual({
      model: 'model-b',
      contextLength: 128000,
      maxOutputTokens: 4096,
      manualContextLength: 222,
      manualMaxOutputTokens: 333,
      reasoningEffort: 'high',
    })
  })
})

describe('syncActiveModelIntoSaved', () => {
  it('writes top-level per-model state back into the matching entry', () => {
    const provider = syncActiveModelIntoSaved({
      ...providerWith([{ id: 'model-a' }, { id: 'model-b' }]),
      manualContextLength: 555,
      reasoningEffort: 'low',
    })
    expect(provider.savedModels).toEqual([
      { id: 'model-a', contextLength: 8000, manualContextLength: 555, reasoningEffort: 'low' },
      { id: 'model-b' },
    ])
  })

  it('keeps the provider untouched when the active model is not saved or nothing is saved', () => {
    const unsaved = syncActiveModelIntoSaved({ ...providerWith([{ id: 'other' }]), manualContextLength: 1 })
    expect(unsaved.savedModels).toEqual([{ id: 'other' }])
    const empty = syncActiveModelIntoSaved(providerWith(undefined))
    expect(empty.savedModels).toBeUndefined()
  })
})

describe('switchActiveProvider', () => {
  function settingsWith(): ProviderSettings {
    const active: ProviderConfig = {
      id: 'text-a',
      name: '供应商 A',
      baseUrl: 'https://a.test/v1',
      model: 'model-a',
      protocol: 'openai-compatible',
      secretRef: 'provider:text:a',
      capabilities: { structuredOutput: 'json_object' },
    }
    const other: ProviderConfig = {
      id: 'text-b',
      name: '供应商 B',
      baseUrl: 'https://b.test/v1',
      model: 'model-b',
      protocol: 'openai-compatible',
      secretRef: 'provider:text:b',
      capabilities: { structuredOutput: 'json_schema' },
    }
    const image: ProviderConfig = {
      id: 'image-a',
      name: '图片供应商',
      baseUrl: 'https://img.test/v1',
      model: '',
      protocol: 'openai-compatible',
      secretRef: 'provider:image',
    }
    return {
      text: active,
      image,
      textProviders: [active, other],
      imageProviders: [image],
    }
  }

  it('activates the target provider and keeps top-level and list entries sharing one copy', () => {
    const next = switchActiveProvider(settingsWith(), 'text', 'text-b')
    expect(next).not.toBeNull()
    expect(next!.text.id).toBe('text-b')
    expect(next!.textProviders.map((provider) => provider.id)).toEqual(['text-a', 'text-b'])
    // 顶层与列表条目指向同一份对象：后续编辑替换时两处一起更新
    expect(next!.text).toBe(next!.textProviders[1])
    expect(next!.text.model).toBe('model-b')
    expect(next!.image.id).toBe('image-a')
  })

  it('deep-copies capabilities so the activated entry cannot mutate the source list item', () => {
    const source = settingsWith()
    const next = switchActiveProvider(source, 'text', 'text-b')!
    expect(next.text.capabilities).not.toBe(source.textProviders[1].capabilities)
    expect(next.text.capabilities).toEqual(source.textProviders[1].capabilities)
  })

  it('returns null when the target is missing or already active and leaves settings untouched', () => {
    const source = settingsWith()
    expect(switchActiveProvider(source, 'text', 'nope')).toBeNull()
    expect(switchActiveProvider(source, 'text', 'text-a')).toBeNull()
    expect(source.text.id).toBe('text-a')
  })

  it('falls back to the active provider when the slot list is empty', () => {
    const source = { ...settingsWith(), textProviders: [] }
    expect(providersFor(source, 'text').map((provider) => provider.id)).toEqual(['text-a'])
  })
})
