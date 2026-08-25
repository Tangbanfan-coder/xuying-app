import type { ProviderConfig, ProviderSettings, ProviderSlot, SavedModelEntry } from './types'

const SETTINGS_KEY = 'illustrated-story-chat.provider-settings.v1'
const GLOBAL_WRITING_INSTRUCTIONS_KEY = 'illustrated-story-chat.global-writing-instructions.v1'

const DEFAULT_TEXT_PROVIDER: ProviderConfig = {
  id: 'custom-text',
  name: '自定义文本接口',
  baseUrl: '',
  model: '',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
}

const DEFAULT_IMAGE_PROVIDER: ProviderConfig = {
  id: 'custom-image',
  name: '自定义图片接口',
  baseUrl: '',
  model: '',
  protocol: 'openai-compatible',
  secretRef: 'provider:image',
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  text: DEFAULT_TEXT_PROVIDER,
  image: DEFAULT_IMAGE_PROVIDER,
  textProviders: [DEFAULT_TEXT_PROVIDER],
  imageProviders: [DEFAULT_IMAGE_PROVIDER],
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  // Deep-copy capabilities so an in-draft edit of one provider can never
  // mutate another provider that shared the same object.
  return {
    ...provider,
    ...(provider.capabilities ? { capabilities: { ...provider.capabilities } } : {}),
  }
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<ProviderConfig>
  return typeof provider.id === 'string' && typeof provider.name === 'string' && typeof provider.baseUrl === 'string'
    && typeof provider.model === 'string' && typeof provider.secretRef === 'string'
}

function normalizeProviderList(value: unknown, active: ProviderConfig) {
  const list = Array.isArray(value) ? value.filter(isProviderConfig).map(cloneProvider) : []
  if (!list.some((provider) => provider.id === active.id)) list.unshift(cloneProvider(active))
  return list.length ? list : [cloneProvider(active)]
}

function isSavedModelEntry(value: unknown): value is SavedModelEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<SavedModelEntry>
  return typeof entry.id === 'string' && entry.id.trim().length > 0
    && (entry.contextLength === undefined || typeof entry.contextLength === 'number')
    && (entry.maxOutputTokens === undefined || typeof entry.maxOutputTokens === 'number')
    && (entry.manualContextLength === undefined || typeof entry.manualContextLength === 'number')
    && (entry.manualMaxOutputTokens === undefined || typeof entry.manualMaxOutputTokens === 'number')
    && (entry.reasoningEffort === undefined || typeof entry.reasoningEffort === 'string')
}

function normalizeSavedModels(value: unknown): SavedModelEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const entries: SavedModelEntry[] = []
  for (const item of value) {
    if (!isSavedModelEntry(item) || seen.has(item.id)) continue
    seen.add(item.id)
    entries.push({ ...item })
  }
  return entries.length ? entries : undefined
}

export function loadProviderSettings(): ProviderSettings {
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (!raw) return {
    text: cloneProvider(DEFAULT_TEXT_PROVIDER),
    image: cloneProvider(DEFAULT_IMAGE_PROVIDER),
    textProviders: [cloneProvider(DEFAULT_TEXT_PROVIDER)],
    imageProviders: [cloneProvider(DEFAULT_IMAGE_PROVIDER)],
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ProviderSettings>
    const text = isProviderConfig(parsed.text) ? { ...DEFAULT_TEXT_PROVIDER, ...parsed.text } : cloneProvider(DEFAULT_TEXT_PROVIDER)
    const image = isProviderConfig(parsed.image) ? { ...DEFAULT_IMAGE_PROVIDER, ...parsed.image } : cloneProvider(DEFAULT_IMAGE_PROVIDER)
    return {
      text: { ...text, savedModels: normalizeSavedModels(text.savedModels) },
      image: { ...image, savedModels: normalizeSavedModels(image.savedModels) },
      textProviders: normalizeProviderList(parsed.textProviders, text).map((provider) => ({ ...provider, savedModels: normalizeSavedModels(provider.savedModels) })),
      imageProviders: normalizeProviderList(parsed.imageProviders, image).map((provider) => ({ ...provider, savedModels: normalizeSavedModels(provider.savedModels) })),
    }
  } catch {
    return {
      text: cloneProvider(DEFAULT_TEXT_PROVIDER),
      image: cloneProvider(DEFAULT_IMAGE_PROVIDER),
      textProviders: [cloneProvider(DEFAULT_TEXT_PROVIDER)],
      imageProviders: [cloneProvider(DEFAULT_IMAGE_PROVIDER)],
    }
  }
}

export function saveProviderSettings(settings: ProviderSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadGlobalWritingInstructions() {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(GLOBAL_WRITING_INSTRUCTIONS_KEY) ?? ''
}

export function saveGlobalWritingInstructions(value: string) {
  const normalized = value.trim()
  if (normalized.length > 50_000) throw new Error('全局创作设定不能超过 50000 字')
  if (typeof localStorage !== 'undefined') {
    if (normalized) localStorage.setItem(GLOBAL_WRITING_INSTRUCTIONS_KEY, normalized)
    else localStorage.removeItem(GLOBAL_WRITING_INSTRUCTIONS_KEY)
  }
  return normalized
}

export function createProviderConfig(slot: ProviderSlot): ProviderConfig {
  const id = crypto.randomUUID()
  return {
    id: `custom-${slot}-${id}`,
    name: slot === 'text' ? '新的文本供应商' : '新的图片供应商',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: `provider:${slot}:${id}`,
  }
}

export type ProviderListKey = 'textProviders' | 'imageProviders'

export function providerListKey(slot: ProviderSlot): ProviderListKey {
  return slot === 'text' ? 'textProviders' : 'imageProviders'
}

/** 槽位的候选供应商；列表异常为空时用当前激活配置兜底，保证切换入口永远有选项。 */
export function providersFor(settings: ProviderSettings, slot: ProviderSlot): ProviderConfig[] {
  const list = settings[providerListKey(slot)]
  return list?.length ? list : [settings[slot]]
}

/**
 * 把槽位激活供应商切到列表中的另一家。返回新设置对象；
 * 目标不存在或已是激活项时返回 null（无需变更）。
 * 顶层与列表条目同步指向同一份深拷贝，避免共享引用被就地修改。
 */
export function switchActiveProvider(settings: ProviderSettings, slot: ProviderSlot, providerId: string): ProviderSettings | null {
  if (settings[slot].id === providerId) return null
  const key = providerListKey(slot)
  const target = settings[key].find((provider) => provider.id === providerId)
  if (!target) return null
  const next = cloneProvider(target)
  return { ...settings, [slot]: next, [key]: settings[key].map((provider) => provider.id === providerId ? next : provider) }
}

/** 切换模型时跟随模型一起恢复的字段；savedModels 条目是这些值的权威存储。 */
const PER_MODEL_PATCH_KEYS = ['model', 'contextLength', 'maxOutputTokens', 'manualContextLength', 'manualMaxOutputTokens', 'reasoningEffort'] as const

export type PerModelPatch = Pick<ProviderConfig, typeof PER_MODEL_PATCH_KEYS[number]>

export function savedModelPatch(entry: SavedModelEntry): PerModelPatch {
  return {
    model: entry.id,
    contextLength: entry.contextLength,
    maxOutputTokens: entry.maxOutputTokens,
    manualContextLength: entry.manualContextLength,
    manualMaxOutputTokens: entry.manualMaxOutputTokens,
    reasoningEffort: entry.reasoningEffort,
  }
}

/**
 * 把顶层"当前模型"的 per-model 字段回写进 savedModels 中匹配的条目，
 * 保证编辑手动窗口、思考等级等值时收藏条目与激活状态不会出现两份事实。
 */
export function syncActiveModelIntoSaved(provider: ProviderConfig): ProviderConfig {
  if (!provider.savedModels?.length) return provider
  const index = provider.savedModels.findIndex((entry) => entry.id === provider.model)
  if (index < 0) return provider
  const state = pickPerModelState(provider)
  const savedModels = [...provider.savedModels]
  savedModels[index] = { ...savedModels[index], ...state }
  return { ...provider, savedModels }
}

function pickPerModelState(provider: ProviderConfig): Pick<SavedModelEntry, 'contextLength' | 'maxOutputTokens' | 'manualContextLength' | 'manualMaxOutputTokens' | 'reasoningEffort'> {
  return {
    contextLength: provider.contextLength,
    maxOutputTokens: provider.maxOutputTokens,
    manualContextLength: provider.manualContextLength,
    manualMaxOutputTokens: provider.manualMaxOutputTokens,
    reasoningEffort: provider.reasoningEffort,
  }
}
