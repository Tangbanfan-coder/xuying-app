import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ImagePlus, Save, Send, Square } from 'lucide-react'
import ContextUsage, { contextUsageToolbarSummary } from './ContextUsage'
import ComposerAssetsMenu from './ComposerAssetsMenu'
import ReasoningEffortQuickControl from './ReasoningEffortQuickControl'
import type { ContextUsageState } from '../domain/contextUsage'
import type { IllustrationMode } from '../domain/models'
import { resolveReasoningEffortOptions } from '../providers/endpointReasoningAdapters'
import type { ProviderConfig, ReasoningEffort } from '../providers/types'
import type { ContextBudgetPlan } from '../providers/writing'
import type { GenerationPhase } from '../hooks/useWritingTurnController'
import { usePresence } from '../hooks/usePresence'
import { focusTriggerUnlessTyping } from '../utils/menuFocus'

interface ComposerProps {
  generationPhase: GenerationPhase
  illustrationMode: IllustrationMode
  reasoningEffort: ReasoningEffort | undefined
  reasoningProvider?: Pick<ProviderConfig, 'baseUrl' | 'model'>
  contextUsagePlan?: ContextBudgetPlan
  contextUsageState: ContextUsageState
  onSubmit: (text: string) => Promise<boolean>
  onStop: () => void
  onOpenContextUsage: () => void
  onOpenCharacterAssets: () => void
  onOpenReferenceImage: () => void
  onReasoningEffortChange: (reasoningEffort: ReasoningEffort) => void
  onIllustrationModeChange: (mode: IllustrationMode) => void
}

export default function Composer({
  generationPhase,
  illustrationMode,
  reasoningEffort,
  reasoningProvider,
  contextUsagePlan,
  contextUsageState,
  onSubmit,
  onStop,
  onOpenContextUsage,
  onOpenCharacterAssets,
  onOpenReferenceImage,
  onReasoningEffortChange,
  onIllustrationModeChange,
}: ComposerProps) {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [illustrationModeOpen, setIllustrationModeOpen] = useState(false)
  const { present: modeMenuPresent, closing: modeMenuClosing } = usePresence(illustrationModeOpen, () => {}, 150)
  const [menuFlipped, setMenuFlipped] = useState(false)
  const [menuShiftX, setMenuShiftX] = useState(0)
  const illustrationModeControlRef = useRef<HTMLDivElement>(null)
  const illustrationModeTriggerRef = useRef<HTMLButtonElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const generating = generationPhase === 'starting' || generationPhase === 'running'
  const saving = generationPhase === 'saving'
  const cancelling = generationPhase === 'cancelling'
  const reasoningOptions = resolveReasoningEffortOptions(reasoningProvider).options

  useEffect(() => {
    if (!illustrationModeOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!illustrationModeControlRef.current?.contains(event.target as Node)) setIllustrationModeOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setIllustrationModeOpen(false)
      focusTriggerUnlessTyping(illustrationModeTriggerRef.current)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [illustrationModeOpen])

  // 菜单定位：垂直方向空间不足时向下展开，水平方向 clamp 在视口内。
  // 工具栏在打开后仍会重排（如上下文用量从"待计算"变为百分比、字体加载），
  // 因此打开期间持续重测，避免锚点移动后菜单溢出屏幕。
  useLayoutEffect(() => {
    if (!illustrationModeOpen) return
    const trigger = illustrationModeTriggerRef.current
    if (!trigger) return
    const measure = () => {
      const currentTrigger = illustrationModeTriggerRef.current
      if (!currentTrigger) return
      const rect = currentTrigger.getBoundingClientRect()
      if (!rect.width && !rect.height) return // 布局尚未就绪（如测试环境），保持默认位置
      // 菜单预估高度：3 项 × (min-height 48px + gap 2px) + padding 5px × 2 ≈ 162px + 间距 8px
      const menuHeight = 170
      const margin = 12
      const spaceAbove = rect.top - margin
      const spaceBelow = window.innerHeight - rect.bottom - margin
      setMenuFlipped(spaceAbove < menuHeight && spaceBelow >= menuHeight)
      // 菜单宽度为 min(252px, 100vw - 24px)，理想右缘对齐按钮右缘；左缘不足 margin 时向右平移
      const menuWidth = Math.min(252, window.innerWidth - margin * 2)
      setMenuShiftX(Math.max(0, Math.round(menuWidth - rect.right + margin)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [illustrationModeOpen, contextUsageState])

  const submit = async () => {
    const text = draft.trim()
    if (!text || generationPhase !== 'idle' || submitting) return
    setSubmitting(true)
    setDraft('')
    try {
      if (await onSubmit(text)) setDraft(text)
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Browsers disagree on composition state during the final IME Enter.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <footer className="composer-wrap">
      <div className="composer">
        <textarea ref={draftRef} rows={1} value={draft} placeholder="继续写下去，或告诉 AI 你想看到的画面…" aria-label="创作要求" onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <ComposerAssetsMenu onOpenCharacterAssets={onOpenCharacterAssets} onOpenReferenceImage={onOpenReferenceImage} />
            <ReasoningEffortQuickControl value={reasoningEffort} options={reasoningOptions} onChange={onReasoningEffortChange} />
            <ContextUsage plan={contextUsagePlan} state={contextUsageState} compactLabel={contextUsageToolbarSummary(contextUsagePlan, contextUsageState)} detailsOpen={false} showDetails={false} onDetailsOpenChange={(open) => { if (open) onOpenContextUsage() }} />
            <div ref={illustrationModeControlRef} className="illustration-mode-control">
              <button ref={illustrationModeTriggerRef} className="composer-tool-button auto-illustrate-button" type="button" aria-expanded={illustrationModeOpen} aria-haspopup="menu" aria-label={`配图模式：${illustrationMode === 'none' ? '无图' : illustrationMode === 'manual' ? '按需' : '自动'}`} onPointerDown={(event) => event.preventDefault()} onClick={() => setIllustrationModeOpen((open) => !open)}>
                <ImagePlus size={17} aria-hidden="true" /><span>配图</span><strong>{illustrationMode === 'none' ? '无图' : illustrationMode === 'manual' ? '按需' : '自动'}</strong>
              </button>
              {modeMenuPresent && <div className={`illustration-mode-menu${modeMenuClosing ? ' closing' : ''}${menuFlipped ? ' illustration-mode-menu-flipped' : ''}`} role="menu" aria-label="选择配图模式" style={menuShiftX ? { translate: `${menuShiftX}px 0` } : undefined}>
                {([['none', '无图', '只写正文'], ['manual', '按需', '保存建议，手动生成'], ['auto', '自动', '自动生成插画']] as const).map(([mode, label, description]) => (
                  <button key={mode} type="button" role="menuitemradio" aria-checked={illustrationMode === mode} onPointerDown={(event) => event.preventDefault()} onClick={() => { onIllustrationModeChange(mode); setIllustrationModeOpen(false); focusTriggerUnlessTyping(illustrationModeTriggerRef.current) }}>
                    <span><strong>{label}</strong><small>{description}</small></span>{illustrationMode === mode && <Check size={15} aria-hidden="true" />}
                  </button>
                ))}
              </div>}
            </div>
          </div>
          <button className="send-button" type="button" aria-label={cancelling ? '正在停止' : saving ? '正在保存' : generating ? '停止生成' : '发送'} disabled={cancelling || saving || (!generating && (!draft.trim() || submitting))} onClick={() => { if (generating) void onStop(); else if (!cancelling && !saving) void submit() }}>
            <span className="send-button-surface">{saving ? <Save size={16} /> : generating || cancelling ? <Square size={16} /> : <Send size={18} />}</span>
          </button>
        </div>
      </div>
    </footer>
  )
}
