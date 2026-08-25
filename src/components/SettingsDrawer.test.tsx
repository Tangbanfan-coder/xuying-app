// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '../providers/types'
import type { ContextBudgetPlan } from '../providers/writing'
import SettingsDrawer from './SettingsDrawer'

const capacitorAppMocks = vi.hoisted(() => ({
  addListener: vi.fn((_eventName: string, handler: () => void) => Promise.resolve({ remove: async () => {} })),
}))

vi.mock('@capacitor/app', () => ({
  App: { addListener: capacitorAppMocks.addListener },
}))

const providerSettings: ProviderSettings = {
  text: {
    id: 'text-provider',
    name: '文本服务',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
  },
  image: {
    id: 'image-provider',
    name: '图片服务',
    baseUrl: 'https://example.test/v1',
    model: 'image-model',
    protocol: 'openai-compatible',
    secretRef: 'provider:image',
  },
  textProviders: [],
  imageProviders: [],
}

function drawerProps(overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {}) {
  return {
    open: true,
    projectTitle: '测试作品',
    activeThemeId: 'neutral' as const,
    onClose: vi.fn(),
    onThemeChange: vi.fn().mockResolvedValue(undefined),
    activeIllustrationStyleId: 'unconstrained' as const,
    activeCustomStylePrompt: '',
    onIllustrationStyleChange: vi.fn().mockResolvedValue(undefined),
    activeWritingInstructions: '',
    onEditWritingInstructions: vi.fn(),
    contextBudget: 'standard' as const,
    onContextBudgetChange: vi.fn().mockResolvedValue(undefined),
    contextUsageState: 'empty' as const,
    onOpenContextUsage: vi.fn(),
    onOpenSummaryHistory: vi.fn(),
    providerSettings,
    onOpenProviderSettings: vi.fn(),
    appearanceMode: 'dark' as const,
    onAppearanceChange: vi.fn(),
    ...overrides,
  }
}

function renderDrawer(overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {}) {
  return render(<SettingsDrawer {...drawerProps(overrides)} />)
}

async function waitForPageSettled(targetHeading: string) {
  const heading = await screen.findByRole('heading', { name: targetHeading })
  await waitFor(() => expect(document.querySelector('.settings-content--exiting')).toBeNull())
  await waitFor(() => expect(heading.isConnected).toBe(true))
  const closeButton = screen.queryByRole('button', { name: '返回设置' })
  if (closeButton) {
    await waitFor(() => expect(document.activeElement).toBe(closeButton))
  }
}

afterEach(() => cleanup())

describe('SettingsDrawer', () => {
  it('shows category entries and app appearance controls on the home page', () => {
    renderDrawer()

    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('button', { name: /写作/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /记忆与上下文/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /作品风格/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /模型服务/ })).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: '深浅模式' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /中性纸墨/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /摘要版本历史/ })).toBeNull()
  })

  it('opens chapter summary history from the memory page', async () => {
    const user = userEvent.setup()
    const onOpenSummaryHistory = vi.fn()
    renderDrawer({ onOpenSummaryHistory })

    await user.click(screen.getByRole('button', { name: /记忆与上下文/ }))
    // 页面切换带 160ms 退出动画，需等页面重挂载完成
    await waitForPageSettled('记忆与上下文')
    expect(screen.getByRole('heading', { name: '记忆与上下文' })).toBeDefined()
    expect(screen.getByText('剧情记忆长度')).toBeDefined()
    await user.click(screen.getByRole('button', { name: /摘要版本历史/ }))
    expect(onOpenSummaryHistory).toHaveBeenCalledTimes(1)
  })

  it('navigates between writing subpages and back home', async () => {
    const user = userEvent.setup()
    const onEditGlobalWritingInstructions = vi.fn()
    const onEditWritingInstructions = vi.fn()
    renderDrawer({
      activeWritingInstructions: '局部规则',
      globalWritingInstructions: '全局规则',
      onEditGlobalWritingInstructions,
      onEditWritingInstructions,
    })

    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')

    const globalHeading = await screen.findByRole('heading', { name: '作用于所有作品' })
    const globalSection = globalHeading.closest('section')
    const toolsHeading = await screen.findByRole('heading', { name: '创作辅助' })
    const toolsSection = toolsHeading.closest('section')
    const localButton = await screen.findByRole('button', { name: /局部创作设定/ })
    expect(globalSection?.querySelector('button')?.textContent).toContain('全局创作设定')
    expect(globalSection?.textContent).not.toContain('风格语料库')
    expect(globalSection?.textContent).not.toContain('文风优化数据')
    expect(toolsSection?.textContent).toContain('风格语料库')
    expect(toolsSection?.textContent).toContain('文风优化数据')
    expect(globalSection?.compareDocumentPosition(localButton.closest('section')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await user.click(screen.getByRole('button', { name: /全局创作设定/ }))
    expect(onEditGlobalWritingInstructions).toHaveBeenCalledTimes(1)
    await user.click(localButton)
    expect(onEditWritingInstructions).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '返回设置' }))
    await waitForPageSettled('设置')
    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('button', { name: /模型服务/ })).toBeDefined()
  })

  it('opens the global style corpus from the writing page', async () => {
    const user = userEvent.setup()
    const onOpenStyleCorpus = vi.fn()
    renderDrawer({
      styleCorpusSummary: { sourceCount: 2, fragmentCount: 8 },
      onOpenStyleCorpus,
    })

    await user.click(screen.getByRole('button', { name: /写作/ }))
    // 先等页面切换完成（home 入口卸载），避免 /风格语料库/ 匹配到 home 页"写作"入口
    await waitForPageSettled('写作')
    const button = screen.getByRole('button', { name: /风格语料库/ })
    expect(button.textContent).toContain('2 个来源 · 8 个片段')
    await user.click(button)
    expect(onOpenStyleCorpus).toHaveBeenCalledTimes(1)
  })

  it('keeps independent writing and memory actions outside a joined list', async () => {
    const user = userEvent.setup()
    renderDrawer()

    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')
    expect(screen.getByRole('button', { name: /全局创作设定/ }).closest('.settings-navigation-list')).toBeNull()
    expect(screen.getByRole('button', { name: /风格语料库/ }).closest('.settings-navigation-list')).toBeNull()
    expect(screen.getByRole('button', { name: /文风优化数据/ }).closest('.settings-navigation-list')).toBeNull()

    await user.click(screen.getByRole('button', { name: '返回设置' }))
    await waitForPageSettled('设置')
    await user.click(screen.getByRole('button', { name: /记忆与上下文/ }))
    await waitForPageSettled('记忆与上下文')
    expect(screen.getByRole('button', { name: /查看本轮上下文用量/ }).closest('.settings-navigation-list')).toBeNull()
    expect(screen.getByRole('button', { name: /摘要版本历史/ }).closest('.settings-navigation-list')).toBeNull()
  })

  it('shows the story theme selector inside the appearance page', async () => {
    const user = userEvent.setup()
    renderDrawer()

    await user.click(screen.getByRole('button', { name: /作品风格/ }))
    await waitForPageSettled('作品风格')
    expect(screen.getByRole('heading', { name: '作品氛围' })).toBeDefined()
    expect(screen.getByRole('button', { name: /中性纸墨/ })).toBeDefined()
  })

  it('shows token-based memory hints derived from the usage plan', async () => {
    const user = userEvent.setup()
    const plan = {
      contextBudget: 'standard',
      contextCapacityTokens: 100_000,
      contextNarrowingFactor: 0.92,
    } as ContextBudgetPlan
    renderDrawer({ contextUsagePlan: plan })

    await user.click(screen.getByRole('button', { name: /记忆与上下文/ }))
    await waitForPageSettled('记忆与上下文')

    expect(screen.getByText('约 50.6k 剧情记忆')).toBeDefined()
    expect(screen.getByText('约 69k 剧情记忆')).toBeDefined()
    expect(screen.getByText('约 87.4k 剧情记忆')).toBeDefined()
  })

  it('returns to the active category after an external settings page closes', async () => {
    const user = userEvent.setup()
    const props = drawerProps()
    const { rerender } = render(<SettingsDrawer {...props} />)

    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')
    expect(screen.getByRole('heading', { name: '写作' })).toBeDefined()

    rerender(<SettingsDrawer {...props} suspended />)
    expect(screen.getByRole('dialog', { hidden: true }).getAttribute('data-suspended')).toBe('true')
    rerender(<SettingsDrawer {...props} suspended={false} />)

    expect(await screen.findByRole('heading', { name: '写作' })).toBeDefined()
    expect(await screen.findByRole('button', { name: /局部创作设定/ })).toBeDefined()
  })

  it('opens provider settings from the model service page', async () => {
    const user = userEvent.setup()
    const onOpenProviderSettings = vi.fn()
    renderDrawer({ onOpenProviderSettings })

    await user.click(screen.getByRole('button', { name: /模型服务/ }))
    await waitForProvidersPage()
    await user.click(screen.getByRole('button', { name: '打开图片模型设置' }))
    expect(onOpenProviderSettings).toHaveBeenCalledWith('image')
  })

  async function waitForProvidersPage() {
    await screen.findByRole('heading', { name: '文本模型', level: 3 })
    await waitFor(() => expect(document.querySelector('.settings-content--exiting')).toBeNull())
  }

  it('switches the active text model from the quick select on the model service page', async () => {
    const user = userEvent.setup()
    const onSwitchProviderModel = vi.fn()
    const withSavedModels: ProviderSettings = {
      ...providerSettings,
      text: { ...providerSettings.text, savedModels: [{ id: 'test-model' }, { id: 'alt-model' }] },
    }
    renderDrawer({ providerSettings: withSavedModels, onSwitchProviderModel })

    await user.click(screen.getByRole('button', { name: /^模型服务/ }))
    await waitForProvidersPage()
    await user.click(screen.getByRole('button', { name: /文本服务 · 点击切换常用模型/ }))
    await user.click(screen.getByRole('option', { name: /alt-model/ }))

    expect(onSwitchProviderModel).toHaveBeenCalledWith('text', 'alt-model')
  })

  it('switches the active text provider from the quick select on the model service page', async () => {
    const user = userEvent.setup()
    const onSwitchSlotProvider = vi.fn()
    const altProvider = { ...providerSettings.text, id: 'alt-text-provider', name: '备用文本服务', model: 'alt-model' }
    const withProviders: ProviderSettings = {
      ...providerSettings,
      textProviders: [providerSettings.text, altProvider],
    }
    renderDrawer({ providerSettings: withProviders, onSwitchSlotProvider })

    await user.click(screen.getByRole('button', { name: /^模型服务/ }))
    await waitForProvidersPage()
    await user.click(screen.getByRole('button', { name: /test-model · 点击切换供应商/ }))

    const sheetBody = document.querySelector('.settings-sheet-body')
    expect(within(sheetBody as HTMLElement).getAllByRole('option')).toHaveLength(2)
    await user.click(within(sheetBody as HTMLElement).getByRole('option', { name: /备用文本服务/ }))

    expect(onSwitchSlotProvider).toHaveBeenCalledWith('text', 'alt-text-provider')
  })

  it('shows an empty hint in the quick select when no models are saved', async () => {
    const user = userEvent.setup()
    const emptySettings: ProviderSettings = {
      ...providerSettings,
      text: { ...providerSettings.text, model: '' },
    }
    renderDrawer({ providerSettings: emptySettings })

    await user.click(screen.getByRole('button', { name: /^模型服务/ }))
    await waitForProvidersPage()
    await user.click(screen.getByRole('button', { name: /未设置模型/ }))

    expect(screen.getByText(/暂无常用模型/)).toBeDefined()
  })

  it('returns home with Escape from a subpage before closing', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDrawer({ onClose })

    await user.click(screen.getByRole('button', { name: /作品风格/ }))
    await waitForPageSettled('作品风格')
    expect(screen.getByRole('heading', { name: '作品风格' })).toBeDefined()
    await user.keyboard('{Escape}')
    await waitForPageSettled('设置')
    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the settings layer open but ignores Escape while a subpage is above it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDrawer({ suspended: true, onClose })

    expect(screen.getByRole('dialog', { hidden: true }).getAttribute('data-suspended')).toBe('true')
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens selection options in a bottom sheet and Escape only closes the sheet', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDrawer({ onClose })

    await user.click(screen.getByRole('button', { name: /作品风格/ }))
    await waitForPageSettled('作品风格')
    await user.click(screen.getByRole('button', { name: /中性纸墨/ }))

    const sheetBody = document.querySelector('.settings-sheet-body')
    expect(sheetBody?.getAttribute('role')).toBe('listbox')
    expect(within(sheetBody as HTMLElement).getByRole('option', { name: /中性纸墨/ })).toBeDefined()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.querySelector('.settings-sheet-body')).toBeNull())
    expect(screen.getByRole('heading', { name: '作品风格' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the back arrow only on subpages and the close button only on home', async () => {
    const user = userEvent.setup()
    renderDrawer()

    expect(screen.queryByRole('button', { name: '返回设置' })).toBeNull()
    expect(screen.getByRole('button', { name: '关闭设置' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')

    expect(screen.getByRole('button', { name: '返回设置' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '关闭设置' })).toBeNull()
  })

  it('navigates one level per Android back press and animates backwards', async () => {
    const onClose = vi.fn()
    const handlers: Array<() => void> = []
    capacitorAppMocks.addListener.mockImplementation((_event, handler) => {
      handlers.push(handler as () => void)
      return Promise.resolve({ remove: async () => {} })
    })
    renderDrawer({ onClose })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')

    act(() => { handlers[handlers.length - 1]?.() })
    await waitForPageSettled('设置')
    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.settings-content')?.getAttribute('data-direction')).toBe('back')

    act(() => { handlers[handlers.length - 1]?.() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
