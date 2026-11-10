// 验证 CodeView 子页容器：展开态渲染树面板+编辑器面板，折叠态仅收起树面板、编辑器常驻，
// 文件树固定 300px（无拖拽 handle），编辑器区始终渲染（editorInSplit 已删除）
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import CodeView from './CodeView.vue'
import { useFilesStore } from '../../stores/files'

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
  GitChanged: vi.fn(() => vi.fn()),
  FileCopy: vi.fn(() => Promise.resolve({ ok: [], failed: [] })),
  FileReveal: vi.fn(() => Promise.resolve({ ok: true })),
  FileClipWrite: vi.fn(() => Promise.resolve({ ok: true })),
  FileClipRead: vi.fn(() => Promise.resolve([])),
  ClipboardWrite: vi.fn(() => Promise.resolve()),
}))

vi.mock('./FileTree.vue', () => ({ default: { name: 'FileTreeStub', template: '<div class="tree-stub" />' } }))
vi.mock('./CodeEditor.vue', () => ({ default: { name: 'CodeEditorStub', template: '<div class="editor-stub" />' } }))
vi.mock('../Icon.vue', () => ({ default: { name: 'IconStub', props: ['name', 'size'], template: '<span :data-icon="name" />' } }))

describe('CodeView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.style.userSelect = ''
  })

  afterEach(() => {
    document.body.style.userSelect = ''
  })

  it('展开态渲染树面板 + 编辑器面板', () => {
    useFilesStore().collapsed = false
    const wrapper = mount(CodeView)
    expect(wrapper.find('.tree-panel').exists()).toBe(true)
    expect(wrapper.find('.editor-panel').exists()).toBe(true)
    expect(wrapper.find('.tree-collapsed').exists()).toBe(false)
  })

  it('折叠态 v-show 收起文件树面板，编辑器面板仍渲染；展开入口在右栏顶部而非 CodeView', () => {
    useFilesStore().collapsed = true
    const wrapper = mount(CodeView)
    // 一级视图切换用 v-show 保活，所以 DOM 仍在、只是不可见
    expect(wrapper.find('.tree-panel').exists()).toBe(true)
    expect(wrapper.find('.tree-panel').isVisible()).toBe(false)
    expect(wrapper.find('.tree-collapsed').exists()).toBe(false)
    expect(wrapper.find('[aria-label="展开文件树"]').exists()).toBe(false)
    expect(wrapper.find('.editor-panel').exists()).toBe(true)
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
  })

  it('Git 一级视图：左栏换为变更清单，唯一编辑器宿主仍常驻', () => {
    const store = useFilesStore()
    store.collapsed = false
    store.setRightView('git')
    const wrapper = mount(CodeView)
    expect(wrapper.find('.git-changes-pane').exists()).toBe(true)
    expect(wrapper.find('.git-changes-pane').isVisible()).toBe(true)
    expect(wrapper.find('.tree-panel').isVisible()).toBe(false)
    expect(wrapper.find('.editor-panel').exists()).toBe(true)
  })

  it('Git 视图打开提交历史：历史图占右侧内容区，编辑器宿主仍常驻不卸载', () => {
    const store = useFilesStore()
    store.setRightView('git')
    store.setGitHistoryOpen(true)
    const wrapper = mount(CodeView)
    expect(wrapper.find('.git-panel.log-only').exists()).toBe(true)
    expect(wrapper.find('.editor-panel').exists()).toBe(true)
    // 断言 slot 自身的 display：jsdom 下 isVisible() 无法穿透父级 display:none
    const slots = wrapper.findAll('.editor-slot')
    expect(slots.map((s) => (s.element as HTMLElement).style.display !== 'none')).toEqual([
      false, false, true,
    ])
    // 底部面板只剩终端，不再渲染第二份历史图
    expect(wrapper.findAll('.git-panel')).toHaveLength(1)
  })

  it('文件树固定 300px：不再有拖拽 handle，也不写内联宽度', () => {
    useFilesStore().collapsed = false
    const wrapper = mount(CodeView)
    // 只查文件树自己的手柄：BottomPanel/GitPanel 仍有各自的合法拖宽 handle
    expect(wrapper.find('.tree-panel .resize-handle').exists()).toBe(false)
    expect((wrapper.find('.tree-panel').element as HTMLElement).style.width).toBe('')
  })

  it('不再接收 editorInSplit：编辑器区始终渲染', () => {
    useFilesStore().collapsed = false
    const wrapper = mount(CodeView, { props: { editorInSplit: true } as any })
    expect(wrapper.find('.editor-panel').exists()).toBe(true)
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
  })
})
