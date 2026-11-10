// 验证底部面板合并后的形态：提交历史已并入顶部 Git 工作区的右侧内容区，
// 底部只剩项目终端，不再有「Git 工作区」跳转入口 / 提交历史 tab / 任何 tab 切换。
import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import BottomPanel from './BottomPanel.vue'
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
vi.mock('../Icon.vue', () => ({
  default: { name: 'IconStub', props: ['name', 'size'], template: '<span :data-icon="name" />' },
}))
vi.mock('./ProjectTerminal.vue', () => ({
  default: {
    name: 'TerminalStub',
    props: ['sessionId', 'workDir', 'visible'],
    template: '<div class="terminal-stub" />',
  },
}))

let current: VueWrapper | null = null

/** 面板默认折叠，测试展开态要显式写入偏好 */
function mountPanel(expanded = true): VueWrapper {
  if (expanded) localStorage.setItem('lynel:code-bottom-collapsed', '0')
  const wrapper = mount(BottomPanel, {
    props: { sessionId: 's1', workDir: 'E:/repo', visible: true },
  })
  current = wrapper
  return wrapper
}

describe('BottomPanel · 只剩终端', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    current?.unmount()
    current = null
    document.body.style.userSelect = ''
  })

  it('展开态：唯一静态「终端」标签，无 Git 工作区 / 提交历史 / 徽章', () => {
    const wrapper = mountPanel()
    expect(wrapper.text()).not.toContain('Git 工作区')
    expect(wrapper.text()).not.toContain('提交历史')
    expect(wrapper.find('.jump-git').exists()).toBe(false)
    expect(wrapper.find('.tab-badge').exists()).toBe(false)
    expect(wrapper.find('.git-panel-stub').exists()).toBe(false)
    const tabs = wrapper.findAll('.panel-tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].text()).toContain('终端')
    expect(tabs[0].classes()).toContain('static')
    expect(wrapper.find('.terminal-stub').isVisible()).toBe(true)
    expect(wrapper.findComponent({ name: 'TerminalStub' }).props('visible')).toBe(true)
  })

  it('切到 Git 视图也不再冒出第二个 Git 区域：底部仍是纯终端', () => {
    useFilesStore().setRightView('git')
    const wrapper = mountPanel()
    expect(wrapper.text()).not.toContain('提交历史')
    expect(wrapper.text()).not.toContain('Git 工作区')
    expect(wrapper.findAll('.panel-tab')).toHaveLength(1)
    expect(wrapper.find('.terminal-stub').isVisible()).toBe(true)
  })

  it('折叠态整条仍可展开，文案固定「终端」且终端 visible=false', async () => {
    const wrapper = mountPanel(false)
    expect(wrapper.find('.bar-expand').exists()).toBe(true)
    expect(wrapper.find('.bar-expand').text()).toContain('终端')
    expect(wrapper.find('.panel-tab').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'TerminalStub' }).props('visible')).toBe(false)
    await wrapper.find('.bar-expand').trigger('click')
    expect(wrapper.find('.panel-tab').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'TerminalStub' }).props('visible')).toBe(true)
    expect(wrapper.find('.jump-git').exists()).toBe(false)
  })

  it('折叠/展开偏好写入 localStorage 并在新实例中恢复', async () => {
    const wrapper = mountPanel(false)
    await wrapper.find('.bar-expand').trigger('click')
    expect(localStorage.getItem('lynel:code-bottom-collapsed')).toBe('0')
    wrapper.unmount()
    current = null
    const again = mountPanel(false)
    expect(again.find('.panel-tab').exists()).toBe(true)
  })

  it('终端实例全程挂载（v-show 保活），折叠时不卸载', async () => {
    const wrapper = mountPanel()
    const term = wrapper.findComponent({ name: 'TerminalStub' })
    await wrapper.find('[aria-label="折叠面板"]').trigger('click')
    expect(wrapper.findComponent({ name: 'TerminalStub' }).exists()).toBe(true)
    expect(term.exists()).toBe(true)
    expect(wrapper.find('.terminal-stub').isVisible()).toBe(false)
  })
})
