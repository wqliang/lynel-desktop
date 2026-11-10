// 回归：Monaco 0.56 默认 useInlineViewWhenSpaceIsLimited=true + 断点 900px，
// 会在右栏（diff 区通常 <900px）无条件把双栏降级成 inline，导致「左右双栏」按钮点了没反应。
// 这里锁住：创建时关闭自动降级，且切换布局时 updateOptions 带上正确参数。
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import CodeDiffView from './CodeDiffView.vue'

const h = vi.hoisted(() => {
  const diffEditor: Record<string, any> = {
    onDidUpdateDiff: vi.fn(),
    setModel: vi.fn(),
    getLineChanges: vi.fn(() => []),
    updateOptions: vi.fn(),
    getModifiedEditor: vi.fn(() => null),
    layout: vi.fn(),
    dispose: vi.fn(),
  }
  const monaco: Record<string, any> = {
    editor: {
      createDiffEditor: vi.fn(() => diffEditor),
      createModel: vi.fn(() => ({ dispose: vi.fn() })),
      getModel: vi.fn(() => undefined),
      setTheme: vi.fn(),
    },
    Uri: { parse: vi.fn((s: string) => ({ toString: () => s })) },
  }
  return { diffEditor, monaco, files: null as any }
})

vi.mock('../../stores/files', async () => {
  const { reactive } = await import('vue')
  const state = reactive({
    workDir: '/repo',
    diffRequest: { relPath: 'src/a.ts', left: 'HEAD', right: 'WORKTREE', label: '工作区' },
    activeView: 'diff',
    diffLayout: 'side' as 'side' | 'inline',
    setDiffLayout(v: 'side' | 'inline') { state.diffLayout = v },
    openDiff: vi.fn(),
    closeDiff: vi.fn(),
  })
  h.files = state
  return { useFilesStore: () => state }
})
vi.mock('../../stores/settings', () => ({
  useSettingsStore: () => ({
    cfg: { terminal: { theme: 'default-dark', fontSize: 14 } },
    load: vi.fn(),
  }),
}))
vi.mock('../../composables/useElectron', () => ({
  FileRead: vi.fn(() => Promise.resolve({ content: '右侧内容', binary: false, truncated: false })),
  GitFileAtRev: vi.fn(() => Promise.resolve({ ok: true, content: '左侧内容', binary: false, truncated: false })),
}))
vi.mock('../../monaco/setup', () => ({
  ensureMonaco: vi.fn(() => Promise.resolve(h.monaco)),
  applyMonacoTheme: vi.fn(() => 'code-default-dark'),
}))
vi.mock('../../monaco/languages', () => ({
  languageForPath: vi.fn(() => Promise.resolve('plaintext')),
}))
vi.mock('../../monaco/textmate', () => ({
  installTextMate: vi.fn(() => Promise.resolve()),
}))
vi.mock('../Icon.vue', () => ({
  default: { name: 'IconStub', props: ['name', 'size'], template: '<span :data-icon="name" />' },
}))

let current: VueWrapper | null = null

async function mountDiff(): Promise<VueWrapper> {
  const wrapper = mount(CodeDiffView)
  current = wrapper
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('CodeDiffView · 双栏 / inline 布局', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.files.diffLayout = 'side'
  })
  afterEach(() => {
    current?.unmount()
    current = null
  })

  it('创建 DiffEditor 时关闭 Monaco 的窄宽度自动 inline 降级', async () => {
    await mountDiff()
    expect(h.monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1)
    const options = h.monaco.editor.createDiffEditor.mock.calls[0][1]
    expect(options.renderSideBySide).toBe(true)
    // 必须为 false：否则 diff 区宽度 <= 900px 时 Monaco 会强制 inline，双栏按钮永远无效
    expect(options.useInlineViewWhenSpaceIsLimited).toBe(false)
  })

  it('点「上下统一视图」→ inline，并同步 updateOptions', async () => {
    const wrapper = await mountDiff()
    await wrapper.find('.diff-seg-btn[aria-label="上下统一视图"]').trigger('click')
    await nextTick()
    expect(h.files.diffLayout).toBe('inline')
    expect(h.diffEditor.updateOptions).toHaveBeenCalledWith({
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
    })
  })

  it('点「左右双栏视图」→ side，并同步 updateOptions', async () => {
    const wrapper = await mountDiff()
    await wrapper.find('.diff-seg-btn[aria-label="上下统一视图"]').trigger('click')
    await nextTick()
    h.diffEditor.updateOptions.mockClear()
    await wrapper.find('.diff-seg-btn[aria-label="左右双栏视图"]').trigger('click')
    await nextTick()
    expect(h.files.diffLayout).toBe('side')
    expect(h.diffEditor.updateOptions).toHaveBeenCalledWith({
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
    })
  })

  it('偏好已是 side 时重复点「左右双栏」仍强制重新应用（HMR 旧实例自愈）', async () => {
    const wrapper = await mountDiff()
    h.diffEditor.updateOptions.mockClear()
    // 值没变 → watch 不会触发，必须由按钮入口直接 apply
    await wrapper.find('.diff-seg-btn[aria-label="左右双栏视图"]').trigger('click')
    await nextTick()
    expect(h.files.diffLayout).toBe('side')
    expect(h.diffEditor.updateOptions).toHaveBeenCalledWith({
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
    })
  })

  it('切换布局不重建 DiffEditor / model', async () => {
    const wrapper = await mountDiff()
    const createCount = h.monaco.editor.createDiffEditor.mock.calls.length
    const modelCount = h.monaco.editor.createModel.mock.calls.length
    await wrapper.find('.diff-seg-btn[aria-label="上下统一视图"]').trigger('click')
    await nextTick()
    await wrapper.find('.diff-seg-btn[aria-label="左右双栏视图"]').trigger('click')
    await nextTick()
    expect(h.monaco.editor.createDiffEditor).toHaveBeenCalledTimes(createCount)
    expect(h.monaco.editor.createModel).toHaveBeenCalledTimes(modelCount)
  })
})
