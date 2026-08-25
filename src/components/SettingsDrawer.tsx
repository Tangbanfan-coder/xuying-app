import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookText, Brain, Brush, Check, ChevronDown, ChevronRight, FileText, Gauge, History, Image, Moon, PlugZap, ScrollText, Sun, X } from 'lucide-react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { contextUsageSummary, formatCompactTokens } from './ContextUsage'
import type { ContextUsageState } from '../domain/contextUsage'
import { ILLUSTRATION_STYLE_PRESETS, getIllustrationStylePreset } from '../domain/illustrationStyles'
import { THEME_PRESETS, getThemePreset } from '../domain/themes'
import type { AppearanceMode, ContextBudget, IllustrationStylePresetId, ThemePresetId } from '../domain/models'
import type { ProviderConfig, ProviderSettings, ProviderSlot } from '../providers/types'
import type { ContextBudgetPlan } from '../providers/writing'
import { CONTEXT_BUDGET_RATIOS } from '../providers/writing'
import { usePresence } from '../hooks/usePresence'
import { providersFor } from '../providers/config'
import { TokenEstimatorProbe } from './TokenEstimatorProbe'

interface Props {
  open: boolean
  suspended?: boolean
  projectTitle: string
  activeThemeId: ThemePresetId
  onClose: () => void
  onThemeChange: (themeId: ThemePresetId) => Promise<void>
  activeIllustrationStyleId: IllustrationStylePresetId
  activeCustomStylePrompt: string
  onIllustrationStyleChange: (styleId: IllustrationStylePresetId, customPrompt?: string) => Promise<void>
  activeWritingInstructions: string
  onEditWritingInstructions: () => void
  globalWritingInstructions?: string
  onEditGlobalWritingInstructions?: () => void
  styleCorpusSummary?: { sourceCount: number; fragmentCount: number }
  onOpenStyleCorpus?: () => void
  onOpenProseEvaluation?: () => void
  contextBudget: ContextBudget
  onContextBudgetChange: (budget: ContextBudget) => Promise<void>
  contextUsagePlan?: ContextBudgetPlan
  contextUsageState: ContextUsageState
  onOpenContextUsage: () => void
  onOpenSummaryHistory: () => void
  providerSettings: ProviderSettings
  onOpenProviderSettings: (slot: ProviderSlot) => void
  /** 从"我的模型"快速切换当前使用的模型；未提供时下拉只作展示。 */
  onSwitchProviderModel?: (slot: ProviderSlot, modelId: string) => void
  /** 快速切换该槽位当前使用的供应商；未提供时下拉只作展示。 */
  onSwitchSlotProvider?: (slot: ProviderSlot, providerId: string) => void
  appearanceMode: AppearanceMode
  onAppearanceChange: (mode: AppearanceMode) => void
}

type SettingsPage = 'home' | 'writing' | 'memory' | 'appearance' | 'providers'

const PAGE_TITLES: Record<SettingsPage, string> = {
  home: '设置',
  writing: '写作',
  memory: '记忆与上下文',
  appearance: '作品风格',
  providers: '模型服务',
}

const SELECT_SHEET_TITLES = {
  theme: '选择作品氛围',
  style: '选择插画画风',
  'model-text': '切换文本模型',
  'model-image': '切换图片模型',
  'provider-text': '切换文本供应商',
  'provider-image': '切换图片供应商',
} as const

function providerSummary(provider: ProviderConfig) {
  const name = provider.name.trim() || '未命名供应商'
  const model = provider.model.trim()
  return model ? `${name} · ${model}` : `${name} · 未选择模型`
}

/** 记忆档位小字：有估算计划时给出结果化的 token 数，否则回退为比例描述。 */
function memoryBudgetHint(plan: ContextBudgetPlan | undefined, budget: ContextBudget) {
  if (!plan || plan.contextCapacityTokens <= 0) {
    return `${Math.round(CONTEXT_BUDGET_RATIOS[budget] * 100)}% 可用额度`
  }
  const tokens = Math.max(0, Math.floor(plan.contextCapacityTokens * CONTEXT_BUDGET_RATIOS[budget] * plan.contextNarrowingFactor))
  return `约 ${formatCompactTokens(tokens)} 剧情记忆`
}

export default function SettingsDrawer({
  open,
  suspended = false,
  projectTitle,
  activeThemeId,
  onClose,
  onThemeChange,
  activeIllustrationStyleId,
  activeCustomStylePrompt,
  onIllustrationStyleChange,
  activeWritingInstructions,
  onEditWritingInstructions,
  globalWritingInstructions,
  onEditGlobalWritingInstructions,
  styleCorpusSummary,
  onOpenStyleCorpus,
  onOpenProseEvaluation,
  contextBudget,
  onContextBudgetChange,
  contextUsagePlan,
  contextUsageState,
  onOpenContextUsage,
  onOpenSummaryHistory,
  providerSettings,
  onOpenProviderSettings,
  onSwitchProviderModel,
  onSwitchSlotProvider,
  appearanceMode,
  onAppearanceChange,
}: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const [page, setPage] = useState<SettingsPage>('home')
  const [pageTransitionKey, setPageTransitionKey] = useState(0)
  const [pageExiting, setPageExiting] = useState(false)
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'back'>('forward')
  const [openSelect, setOpenSelect] = useState<'theme' | 'style' | 'model-text' | 'model-image' | 'provider-text' | 'provider-image' | null>(null)
  const [customStyleEditorOpen, setCustomStyleEditorOpen] = useState(false)
  const [customStylePrompt, setCustomStylePrompt] = useState(activeCustomStylePrompt)
  const { present, closing } = usePresence(open, onClose, 180)

  const themeMenuOpen = openSelect === 'theme'
  const styleMenuOpen = openSelect === 'style'
  const writingInstructionsPreview = activeWritingInstructions.trim().replace(/\s+/g, ' ')
  const globalWritingPreview = globalWritingInstructions?.trim().replace(/\s+/g, ' ')
  const pendingPageRef = useRef<SettingsPage | null>(null)

  function navigateToPage(next: SettingsPage, direction: 'forward' | 'back' = 'forward') {
    if (next === page) return
    // 所有切换都先播当前页的退出动画，再切到目标页
    setNavigationDirection(direction)
    pendingPageRef.current = next
    setPageExiting(true)
  }

  function navigateBack() {
    if (suspended) return
    if (customStyleEditorOpen) {
      setCustomStyleEditorOpen(false)
      return
    }
    if (openSelect) {
      setOpenSelect(null)
      return
    }
    if (page !== 'home') {
      navigateToPage('home', 'back')
      return
    }
    onClose()
  }

  const navigateBackRef = useRef(navigateBack)
  navigateBackRef.current = navigateBack

  useEffect(() => {
    if (!pageExiting || !pendingPageRef.current) return
    const timer = window.setTimeout(() => {
      setPageExiting(false)
      if (pendingPageRef.current) {
        const next = pendingPageRef.current
        pendingPageRef.current = null
        // 目标页与进入动画 key 在同一批更新：避免先渲染旧 key 内容再递增
        // key 导致二次挂载（会产生 detached DOM 竞态，UI 也会闪两下）。
        setPageTransitionKey(k => k + 1)
        setPage(next)
      }
    }, 160) // 与 --motion-exit 匹配
    return () => window.clearTimeout(timer)
  }, [pageExiting])

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (suspended || wasOpenRef.current) return
    wasOpenRef.current = true
    setPage('home')
    setOpenSelect(null)
    setCustomStyleEditorOpen(false)
    closeButtonRef.current?.focus()
  }, [open, suspended])

  useEffect(() => {
    if (page === 'home') return
    setOpenSelect(null)
    if (!pageExiting) {
      closeButtonRef.current?.focus()
    }
  }, [page, pageExiting])

  useEffect(() => {
    if (!open || suspended) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      navigateBackRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, suspended])

  // Android 系统返回手势/硬件键与 Esc 共用同一层级返回逻辑；
  // 仅在抽屉打开期间接管，关闭后卸载监听以还原系统默认退出行为。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let handle: PluginListenerHandle | undefined
    void CapacitorApp.addListener('backButton', () => navigateBackRef.current()).then((registered) => {
      if (cancelled) {
        void registered.remove()
        return
      }
      handle = registered
    })
    return () => {
      cancelled = true
      void handle?.remove()
    }
  }, [open])

  useEffect(() => {
    setCustomStylePrompt(activeCustomStylePrompt)
  }, [activeCustomStylePrompt])

  if (!present) return null

  return (
    <div className={`settings-backdrop${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <aside
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        aria-hidden={suspended || undefined}
        data-suspended={suspended ? 'true' : 'false'}
      >
        <header className="drawer-header">
          <div className="drawer-header-lead">
            {page !== 'home' && (
              <button ref={closeButtonRef} className="icon-button" type="button" aria-label="返回设置" onClick={() => navigateBackRef.current()}>
                <ArrowLeft size={20} />
              </button>
            )}
            <div>
              <h2 id="settings-drawer-title">{PAGE_TITLES[page]}</h2>
              <p>当前作品 · {projectTitle}</p>
            </div>
          </div>
          {page === 'home' && (
            <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭设置" onClick={() => navigateBackRef.current()}>
              <X size={20} />
            </button>
          )}
        </header>

        <div className={`settings-content${pageExiting ? ' settings-content--exiting' : ''}`} key={pageTransitionKey} data-direction={navigationDirection}>
          {page === 'home' && (
            <>
              <section className="settings-section" aria-labelledby="settings-app-appearance">
                <h3 id="settings-app-appearance">深浅模式</h3>
                <div className="appearance-options" role="radiogroup" aria-label="深浅模式">
                  <button type="button" role="radio" aria-checked={appearanceMode === 'dark'} onClick={() => onAppearanceChange('dark')}><Moon size={16} />深色</button>
                  <button type="button" role="radio" aria-checked={appearanceMode === 'light'} onClick={() => onAppearanceChange('light')}><Sun size={16} />浅色</button>
                </div>
                <p className="settings-help">只改变应用界面。</p>
              </section>

              <section className="settings-section" aria-label="设置导航">
                <div className="settings-navigation-stack">
                  <button type="button" onClick={() => navigateToPage('writing')}>
                    <ScrollText size={18} aria-hidden="true" />
                    <span><strong>写作</strong><small>创作设定、风格语料库与文风优化数据</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => navigateToPage('memory')}>
                    <Brain size={18} aria-hidden="true" />
                    <span><strong>记忆与上下文</strong><small>上下文长度、本轮用量与摘要历史</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => navigateToPage('appearance')}>
                    <Brush size={18} aria-hidden="true" />
                    <span><strong>作品风格</strong><small>{getIllustrationStylePreset(activeIllustrationStyleId).label} · 插画与故事样式</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => navigateToPage('providers')}>
                    <FileText size={18} aria-hidden="true" />
                    <span><strong>模型服务</strong><small>{providerSummary(providerSettings.text)}</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </section>

              <TokenEstimatorProbe />
            </>
          )}

          {page === 'writing' && (
            <>
              <section className="settings-section" aria-labelledby="global-writing-settings">
                <h3 id="global-writing-settings">作用于所有作品</h3>
                <div className="settings-navigation-stack">
                  <button type="button" onClick={onEditGlobalWritingInstructions} disabled={!onEditGlobalWritingInstructions}>
                    <ScrollText size={18} aria-hidden="true" />
                    <span>
                      <strong>全局创作设定</strong>
                      <small>{globalWritingPreview || '对所有作品生效的默认规则'}</small>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
                <p className="settings-help">所有作品都会携带，本作品的局部设定可以临时覆盖。</p>
              </section>

              <section className="settings-section" aria-labelledby="current-project-writing-settings">
                <h3 id="current-project-writing-settings">只作用于本书</h3>
                <div className="settings-navigation-list">
                  <button type="button" onClick={onEditWritingInstructions}>
                    <ScrollText size={18} aria-hidden="true" />
                    <span>
                      <strong>局部创作设定</strong>
                      <small>{writingInstructionsPreview || '设置视角、文风、篇幅和长期禁忌'}</small>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
                <p className="settings-help">每轮写作都会携带，本轮明确要求可以临时覆盖。</p>
              </section>

              <section className="settings-section" aria-labelledby="writing-tools-settings">
                <h3 id="writing-tools-settings">创作辅助</h3>
                <div className="settings-navigation-stack">
                  <button type="button" onClick={onOpenStyleCorpus} disabled={!onOpenStyleCorpus}>
                    <BookText size={18} aria-hidden="true" />
                    <span><strong>风格语料库</strong><small>{styleCorpusSummary ? `${styleCorpusSummary.sourceCount} 个来源 · ${styleCorpusSummary.fragmentCount} 个片段` : '导入并整理你认可的表达范例'}</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={onOpenProseEvaluation} disabled={!onOpenProseEvaluation}>
                    <Gauge size={18} aria-hidden="true" />
                    <span><strong>文风优化数据</strong><small>仅本地记录，可审阅后导出</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </section>
            </>
          )}

          {page === 'memory' && (
            <section className="settings-section" aria-labelledby="memory-settings">
              <h3 id="memory-settings">剧情记忆长度</h3>
              <div className="context-budget-choice" role="radiogroup" aria-label="写作上下文长度">
                {([
                  ['standard', '标准'],
                  ['long', '长'],
                  ['full', '完整'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={contextBudget === value}
                    onClick={() => void onContextBudgetChange(value).catch(() => undefined)}
                  >
                    {label}
                    <span>{memoryBudgetHint(contextUsagePlan, value)}</span>
                  </button>
                ))}
              </div>
              <p className="settings-help">越长越不容易忘记旧剧情，但更费 token。具体数字按当前使用的模型自动计算。</p>
              <div className="settings-navigation-stack context-usage-settings-entry">
                <button type="button" onClick={onOpenContextUsage}>
                  <Gauge size={18} aria-hidden="true" />
                  <span>
                    <strong>查看本轮上下文用量</strong>
                    <small>{contextUsageSummary(contextUsagePlan, contextUsageState)}</small>
                  </span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
                <button type="button" onClick={onOpenSummaryHistory}>
                  <History size={18} aria-hidden="true" />
                  <span>
                    <strong>摘要版本历史</strong>
                    <small>查看章节摘要来源并恢复旧版本</small>
                  </span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              </div>
            </section>
          )}

          {page === 'appearance' && (
            <>
              <section className="settings-section" aria-labelledby="story-theme-settings">
                <h3 id="story-theme-settings">作品氛围</h3>
                <div className="theme-select">
                  <button
                    className="theme-select-trigger"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={themeMenuOpen}
                    onClick={() => setOpenSelect((current) => current === 'theme' ? null : 'theme')}
                  >
                    <span className={`theme-select-swatch theme-${activeThemeId}`} aria-hidden="true" />
                    <span className="theme-select-copy"><strong>{getThemePreset(activeThemeId).label}</strong><small>{getThemePreset(activeThemeId).description}</small></span>
                    <ChevronDown size={17} aria-hidden="true" className={themeMenuOpen ? 'rotate-180' : undefined} />
                  </button>
                </div>
                <p className="settings-help">只改变故事区域，不影响应用操作界面。</p>
              </section>

              <section className="settings-section" aria-labelledby="illustration-style-settings">
                <h3 id="illustration-style-settings">插画画风</h3>
                <div className="theme-select illustration-style-select">
                  <button
                    className="theme-select-trigger"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={styleMenuOpen}
                    onClick={() => setOpenSelect((current) => current === 'style' ? null : 'style')}
                  >
                    <Brush size={16} aria-hidden="true" />
                    <span className="theme-select-copy">
                      <strong>{getIllustrationStylePreset(activeIllustrationStyleId).label}</strong>
                      <small>{activeIllustrationStyleId === 'custom' && activeCustomStylePrompt ? activeCustomStylePrompt : getIllustrationStylePreset(activeIllustrationStyleId).description}</small>
                    </span>
                    <ChevronDown size={17} aria-hidden="true" className={styleMenuOpen ? 'rotate-180' : undefined} />
                  </button>
                </div>
              <form className={`custom-style-editor${customStyleEditorOpen ? ' custom-style-editor--open' : ''}`} onSubmit={(event) => {
                event.preventDefault()
                if (!customStylePrompt.trim()) return
                void onIllustrationStyleChange('custom', customStylePrompt.trim())
                  .then(() => setCustomStyleEditorOpen(false))
                  .catch(() => undefined)
              }}>
                <label htmlFor="custom-illustration-style">描述整体画风</label>
                <textarea
                  id="custom-illustration-style"
                  rows={3}
                  maxLength={500}
                  value={customStylePrompt}
                  placeholder="例如：清透的国风工笔画，细线勾勒，淡雅矿物色，保留纸张纹理。"
                  onChange={(event) => setCustomStylePrompt(event.target.value)}
                />
                <div><span>{customStylePrompt.length}/500</span><button className="primary-button" type="submit" disabled={!customStylePrompt.trim()}>应用画风</button></div>
              </form>
                <p className="settings-help">会用于之后生成的定妆照和剧情插画。</p>
              </section>
            </>
          )}

          {page === 'providers' && (
            <>
              <section className="settings-section" aria-labelledby="model-text-settings">
                <h3 id="model-text-settings">文本模型</h3>
                <SlotProviderSelect
                  open={openSelect === 'provider-text'}
                  onToggle={() => setOpenSelect((current) => current === 'provider-text' ? null : 'provider-text')}
                  provider={providerSettings.text}
                />
                <ProviderModelSelect
                  slot="text"
                  open={openSelect === 'model-text'}
                  onToggle={() => setOpenSelect((current) => current === 'model-text' ? null : 'model-text')}
                  provider={providerSettings.text}
                />
                <div className="settings-navigation-stack">
                  <button type="button" aria-label="打开文本模型设置" onClick={() => onOpenProviderSettings('text')}>
                    <FileText size={18} aria-hidden="true" />
                    <span><strong>模型与供应商设置</strong><small>修改地址、密钥，管理常用模型</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </section>

              <section className="settings-section" aria-labelledby="model-image-settings">
                <h3 id="model-image-settings">图片模型</h3>
                <SlotProviderSelect
                  open={openSelect === 'provider-image'}
                  onToggle={() => setOpenSelect((current) => current === 'provider-image' ? null : 'provider-image')}
                  provider={providerSettings.image}
                />
                <ProviderModelSelect
                  slot="image"
                  open={openSelect === 'model-image'}
                  onToggle={() => setOpenSelect((current) => current === 'model-image' ? null : 'model-image')}
                  provider={providerSettings.image}
                />
                <div className="settings-navigation-stack">
                  <button type="button" aria-label="打开图片模型设置" onClick={() => onOpenProviderSettings('image')}>
                    <Image size={18} aria-hidden="true" />
                    <span><strong>模型与供应商设置</strong><small>修改地址、密钥，管理常用模型</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </section>

              <p className="settings-help">点第一张卡切换供应商；在供应商配置中可把常用模型添加到“我的模型”，点第二张卡即可直接切换。</p>
            </>
          )}
        </div>

        {openSelect && (
          <div className="settings-sheet-backdrop" onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpenSelect(null)
          }}>
            <div className="settings-sheet" role="dialog" aria-modal="true" aria-label={SELECT_SHEET_TITLES[openSelect]}>
              <header className="settings-sheet-header">
                <h3>{SELECT_SHEET_TITLES[openSelect]}</h3>
                <button className="icon-button" type="button" aria-label="关闭选择列表" onClick={() => setOpenSelect(null)}>
                  <X size={20} />
                </button>
              </header>
              <div className="settings-sheet-body" role="listbox" aria-label={SELECT_SHEET_TITLES[openSelect]}>
                {openSelect === 'theme' && THEME_PRESETS.map((theme) => {
                  const selected = theme.id === activeThemeId
                  return (
                    <button
                      key={theme.id}
                      className="theme-select-option"
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setOpenSelect(null)
                        void onThemeChange(theme.id)
                      }}
                    >
                      <span className={`theme-select-option-swatch theme-${theme.id}`} aria-hidden="true" />
                      <span><strong>{theme.label}</strong><small>{theme.description}</small></span>
                      {selected && <Check size={15} aria-hidden="true" />}
                    </button>
                  )
                })}
                {openSelect === 'style' && ILLUSTRATION_STYLE_PRESETS.map((style) => {
                  const selected = style.id === activeIllustrationStyleId
                  return (
                    <button
                      key={style.id}
                      className="theme-select-option"
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setOpenSelect(null)
                        if (style.id === 'custom') {
                          setCustomStyleEditorOpen(true)
                          return
                        }
                        setCustomStyleEditorOpen(false)
                        void onIllustrationStyleChange(style.id)
                      }}
                    >
                      <span className={`theme-select-option-swatch illustration-style-${style.id}`} aria-hidden="true" />
                      <span><strong>{style.label}</strong><small>{style.description}</small></span>
                      {selected && <Check size={15} aria-hidden="true" />}
                    </button>
                  )
                })}
                {(openSelect === 'model-text' || openSelect === 'model-image') && (
                  <ProviderModelSheetOptions
                    slot={openSelect === 'model-text' ? 'text' : 'image'}
                    provider={openSelect === 'model-text' ? providerSettings.text : providerSettings.image}
                    onSwitch={onSwitchProviderModel}
                    onDone={() => setOpenSelect(null)}
                  />
                )}
                {(openSelect === 'provider-text' || openSelect === 'provider-image') && (
                  <SlotProviderSheetOptions
                    slot={openSelect === 'provider-text' ? 'text' : 'image'}
                    settings={providerSettings}
                    onSwitch={onSwitchSlotProvider}
                    onDone={() => setOpenSelect(null)}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

/**
 * 底部选择面板中的模型选项。选项来自供应商收藏的 savedModels；
 * 尚未收藏任何模型时退化为只读展示当前模型，引导用户进配置页添加。
 */
function ProviderModelSheetOptions(
  { slot, provider, onSwitch, onDone }: {
    slot: ProviderSlot
    provider: ProviderConfig
    onSwitch?: (slot: ProviderSlot, modelId: string) => void
    onDone: () => void
  },
) {
  const options = provider.savedModels?.length
    ? provider.savedModels
    : provider.model
      ? [{ id: provider.model }]
      : []
  if (!options.length) {
    return <p className="provider-model-empty">暂无常用模型，在下方配置里获取并添加。</p>
  }
  const activeId = provider.model || options[0]?.id
  return (
    <>
      {options.map((entry) => {
        const selected = entry.id === activeId
        return (
          <button
            key={entry.id}
            className="theme-select-option"
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => {
              if (!onSwitch || entry.id === activeId) return
              onSwitch(slot, entry.id)
              onDone()
            }}
          >
            <span><strong>{entry.id}</strong><small>{selected ? '当前使用' : '点击切换'}</small></span>
            {selected && <Check size={15} aria-hidden="true" />}
          </button>
        )
      })}
    </>
  )
}

/**
 * 模型服务页的当前供应商快速切换触发器；选项列表由统一的底部选择面板渲染。
 */
function SlotProviderSelect(
  { open, onToggle, provider }: {
    open: boolean
    onToggle: () => void
    provider: ProviderConfig
  },
) {
  return (
    <div className="theme-select provider-slot-select">
      <button
        className="theme-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
      >
        <PlugZap size={16} aria-hidden="true" />
        <span className="theme-select-copy">
          <strong>{provider.name.trim() || '未命名供应商'}</strong>
          <small>{provider.model || provider.baseUrl || '尚未配置模型与地址'} · 点击切换供应商</small>
        </span>
        <ChevronDown size={17} aria-hidden="true" className={open ? 'rotate-180' : undefined} />
      </button>
    </div>
  )
}

/**
 * 底部选择面板中的供应商选项。选项来自该槽位保存的供应商列表；
 * 点击即切换该槽位的激活供应商，与配置对话框中的"当前供应商"共用同一份数据。
 */
function SlotProviderSheetOptions(
  { slot, settings, onSwitch, onDone }: {
    slot: ProviderSlot
    settings: ProviderSettings
    onSwitch?: (slot: ProviderSlot, providerId: string) => void
    onDone: () => void
  },
) {
  const options = providersFor(settings, slot)
  const activeId = settings[slot].id
  return (
    <>
      {options.map((provider) => {
        const selected = provider.id === activeId
        return (
          <button
            key={provider.id}
            className="theme-select-option"
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => {
              if (!onSwitch || selected) return
              onSwitch(slot, provider.id)
              onDone()
            }}
          >
            <PlugZap size={15} aria-hidden="true" />
            <span>
              <strong>{provider.name.trim() || '未命名供应商'}</strong>
              <small>{provider.model || provider.baseUrl || '尚未配置'}</small>
            </span>
            {selected && <Check size={15} aria-hidden="true" />}
          </button>
        )
      })}
    </>
  )
}

/**
 * 模型服务页的当前模型快速切换触发器；选项列表由统一的底部选择面板渲染。
 */
function ProviderModelSelect(
  { slot, open, onToggle, provider }: {
    slot: ProviderSlot
    open: boolean
    onToggle: () => void
    provider: ProviderConfig
  },
) {
  const Icon = slot === 'text' ? FileText : Image
  const activeId = provider.model || provider.savedModels?.[0]?.id

  return (
    <div className="theme-select provider-model-select">
      <button
        className="theme-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon size={16} aria-hidden="true" />
        <span className="theme-select-copy">
          <strong>{activeId || '未设置模型'}</strong>
          <small>{provider.name.trim() || '未命名供应商'} · 点击切换常用模型</small>
        </span>
        <ChevronDown size={17} aria-hidden="true" className={open ? 'rotate-180' : undefined} />
      </button>
    </div>
  )
}
