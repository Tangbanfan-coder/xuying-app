// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { loadProviderSettings, savedModelPatch, syncActiveModelIntoSaved } from './config'
import type { ProviderConfig } from './types'

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
