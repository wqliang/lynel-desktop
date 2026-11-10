// 验证右栏右侧内容区的三视图互斥：编辑器 / diff / 提交历史恰好一个可见。
// 历史图并入 Git 工作区后挂在这里（纯 DOM），不得破坏「唯一 Monaco 宿主」不变量，
// 也不能出现三个视图同时隐藏导致内容区空白。
// 注意：断言三个 .editor-slot 自身的 style.display，而不是用 isVisible() 查 stub 子元素 ——
// jsdom 里父级 display:none 不会让子元素的 computed display 变成 none，isVisible 会误判。
import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import FileEditorPanel from './FileEditorPanel.vue'
import { useFilesStore } from '../../stores/files'

vi.mock('../../composables/useToast', () => ({ pushToast: vi.fn() }))
vi.mock('../../composables/useElectron', () => ({
  FileListDir: vi.fn(() => Promise.resolve([])),
  FileRead: vi.fn(() => Promise.resolve({ content: '', binary: false, truncated: false })),
  FileWrite: vi.fn(() => Promise.resolve({ ok: true })),
  FileCreate: vi.fn(() => Promise.resolve({ ok: true })),
  FileRename: vi.fn(() => Promise.resolve({ ok: true })),
  FileDelete: vi.fn(() => Promise.resolve({ ok: true })),
  FileWatch: vi.fn(() => Promise.resolve()),
  FileUnwatch: vi.fn(() => Promise.resolve()),
  FileChanged: vi.fn(() => vi.fn()),
  FileCopy: vi.fn(() => Promise.resolve({ ok: [], failed: [] })),
  FileReveal: vi.fn(() => Promise.resolve({ ok: true })),
  FileClipWrite: vi.fn(() => Promise.resolve({ ok: true })),
  FileClipRead: vi.fn(() => Promise.resolve([])),
  ClipboardWrite: vi.fn(() => Promise.resolve()),
}))
vi.mock('./CodeEditor.vue', () => ({
  default: { name: 'CodeEditorStub', template: '<div class="editor-stub" />' },
}))
vi.mock('./CodeDiffView.vue', () => ({
  default: { name: 'CodeDiffViewStub', template: '<div class="diff-stub" />' },
}))
vi.mock('./GitPanel.vue', () => ({
  default: { name: 'GitPanelStub', props: ['view'], template: '<div class="history-stub" />' },
}))

let current: VueWrapper | null = null

function mountPanel(): VueWrapper {
  const wrapper = mount(FileEditorPanel)
  current = wrapper
  return wrapper
}

/** 三个 slot 依次为 编辑器 / diff / 提交历史；true = 可见 */
function visibleSlots(wrapper: VueWrapper): boolean[] {
  return wrapper.findAll('.editor-slot').map(
    (slot) => (slot.element as HTMLElement).style.display !== 'none',
  )
}

describe('FileEditorPanel · 编辑器 / diff / 提交历史互斥', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    current?.unmount()
    current = null
  })

  it('默认展示编辑器，其余两个 slot 常驻但隐藏（v-show 保活）', () => {
    const wrapper = mountPanel()
    expect(visibleSlots(wrapper)).toEqual([true, false, false])
    expect(wrapper.find('.diff-stub').exists()).toBe(true)
    expect(wrapper.find('.history-stub').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'GitPanelStub' }).props('view')).toBe('log')
  })

  it('Git 视图打开历史：历史可见，编辑器与 diff 都隐藏', async () => {
    const store = useFilesStore()
    const wrapper = mountPanel()
    store.setRightView('git')
    store.setGitHistoryOpen(true)
    await nextTick()
    expect(visibleSlots(wrapper)).toEqual([false, false, true])
  })

  it('关闭历史后回到 diff（activeView=diff 且存在 diffRequest）', () => {
    const store = useFilesStore()
    store.openDiff('src/a.ts', 'HEAD', 'WORKTREE', '工作区')
    store.setRightView('git')
    const wrapper = mountPanel()
    expect(visibleSlots(wrapper)).toEqual([false, true, false])
  })

  it('历史优先级最高，且 openDiff 会关掉历史让 diff 立刻可见', async () => {
    const store = useFilesStore()
    store.openDiff('src/a.ts', 'HEAD', 'WORKTREE', '工作区')
    store.setRightView('git')
    store.setGitHistoryOpen(true)
    const wrapper = mountPanel()
    expect(visibleSlots(wrapper)).toEqual([false, false, true])
    // 点历史里的文件 → openDiff → 切回 diff
    store.openDiff('src/a.ts', 'abc^', 'abc', 'abc')
    await nextTick()
    expect(visibleSlots(wrapper)).toEqual([false, true, false])
  })

  it('文件视图下即使 gitHistoryOpen 残留为 true，也不显示历史', async () => {
    const store = useFilesStore()
    store.setGitHistoryOpen(true)
    const wrapper = mountPanel()
    expect(visibleSlots(wrapper)).toEqual([true, false, false])
    store.setRightView('git')
    await nextTick()
    expect(visibleSlots(wrapper)).toEqual([false, false, true])
  })
})
