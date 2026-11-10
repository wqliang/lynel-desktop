// 验证 Git 工作区左栏：分组变更清单、openDiff 接线、Pull/Push/Fetch、
// 提交 / amend / 提交并推送、Worktree 管理下拉。
// 这里只测组件行为，故把两个 store 与宽度拖拽能力替身掉，避免牵出 IPC / jsdom 布局。
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import GitChangesPane from './GitChangesPane.vue'

const m = vi.hoisted(() => {
  const makeStatus = () => ({
    isRepo: true,
    branch: 'main',
    tracking: 'origin/main',
    ahead: 0,
    behind: 0,
    conflicted: [] as { path: string; status: string }[],
    staged: [{ path: 'src/a.ts', status: 'M' }] as { path: string; status: string }[],
    unstaged: [{ path: 'src/b.ts', status: 'M' }] as { path: string; status: string }[],
    untracked: [] as { path: string; status: string }[],
  })
  const git = {
    status: makeStatus(),
    loading: false,
    error: '',
    busyOp: null as string | null,
    hasStaged: true,
    totalChanges: 2,
    workDir: 'E:/repo',
    worktrees: [
      { path: 'E:/repo', branch: 'main', current: true, detached: false, locked: false, prunable: false },
      { path: 'E:/repo-wt-a', branch: 'feature', current: false, detached: false, locked: false, prunable: false },
    ],
    branches: [{ name: 'main', current: true }],
    refreshAll: vi.fn(() => Promise.resolve()),
    // 显式声明入参：vi.fn 会按回调签名推断 mock.calls 元组，否则 `calls[0][0]` 报 TS2493
    runRemoteOp: vi.fn((_op: string, _opts?: unknown) => Promise.resolve(true)),
    commit: vi.fn((_msg: string, _amend?: boolean) => Promise.resolve(true)),
    stage: vi.fn((_paths: string[]) => Promise.resolve(true)),
    unstage: vi.fn((_paths: string[]) => Promise.resolve(true)),
    discard: vi.fn((_paths: string[]) => Promise.resolve(true)),
    addWorktree: vi.fn((_opts: unknown) => Promise.resolve(true)),
    removeWorktree: vi.fn(() => Promise.resolve(true)),
    pruneWorktrees: vi.fn(() => Promise.resolve(true)),
    checkoutBranch: vi.fn(() => Promise.resolve(true)),
    createBranch: vi.fn(() => Promise.resolve(true)),
  }
  const files = {
    openDiff: vi.fn(),
    gitHistoryOpen: false,
    setGitHistoryOpen: vi.fn((_v: boolean) => {}),
  }
  return { git, files, makeStatus }
})

vi.mock('../../stores/git', () => ({ useGitStore: () => m.git }))
vi.mock('../../stores/files', () => ({ useFilesStore: () => m.files }))
vi.mock('../../composables/useElectron', () => ({
  ClipboardWrite: vi.fn(() => Promise.resolve()),
}))
vi.mock('../../composables/useToast', () => ({ pushToast: vi.fn() }))
vi.mock('../Icon.vue', () => ({
  default: { name: 'IconStub', props: ['name', 'size'], template: '<span :data-icon="name" />' },
}))
vi.mock('../../composables/useResizablePanel', async () => {
  const { ref } = await import('vue')
  return { useResizablePanel: () => ({ width: ref(340), onResizeStart: vi.fn() }) }
})

let current: VueWrapper | null = null

function mountPane(): VueWrapper {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const wrapper = mount(GitChangesPane, { attachTo: container })
  current = wrapper
  return wrapper
}

describe('GitChangesPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    m.git.status = m.makeStatus()
    m.git.loading = false
    m.git.error = ''
    m.git.busyOp = null
    m.git.hasStaged = true
    m.git.totalChanges = 2
    m.git.commit.mockResolvedValue(true)
    m.files.gitHistoryOpen = false
  })

  afterEach(() => {
    current?.unmount()
    current = null
    document.body.innerHTML = ''
  })

  it('按四组渲染变更清单：分组标题 + 目录行 + 文件行', async () => {
    const wrapper = mountPane()
    await nextTick()
    expect(wrapper.findAll('.group-title').map((n) => n.text())).toEqual([
      '暂存的更改 (1)',
      '更改 (1)',
    ])
    const rows = wrapper.findAll('.file-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes('title')).toBe('src/a.ts')
    expect(rows[1].attributes('title')).toBe('src/b.ts')
    // 按目录分组：会出现目录行
    expect(wrapper.findAll('.dir-row').length).toBeGreaterThan(0)
  })

  it('点未暂存文件用 WORKTREE 打开 diff；点暂存文件用 :0 打开 diff', async () => {
    const wrapper = mountPane()
    await nextTick()
    const rows = wrapper.findAll('.file-row')
    await rows[1].trigger('click')
    expect(m.files.openDiff).toHaveBeenCalledWith('src/b.ts', 'HEAD', 'WORKTREE', '工作区')
    await rows[0].trigger('click')
    expect(m.files.openDiff).toHaveBeenCalledWith('src/a.ts', 'HEAD', ':0', '暂存区')
  })

  it('Pull / Push / Fetch 分别调用 runRemoteOp', async () => {
    const wrapper = mountPane()
    await nextTick()
    // 历史按钮也在 remote-bar，排除后才是 Pull / Push / Fetch 三个
    const btns = wrapper.findAll('.remote-bar .op-btn:not(.history-btn)')
    expect(btns).toHaveLength(3)
    await btns[0].trigger('click')
    await btns[1].trigger('click')
    await btns[2].trigger('click')
    expect(m.git.runRemoteOp.mock.calls.map((c) => c[0])).toEqual(['pull', 'push', 'fetch'])
  })

  it('提交按钮：无说明时禁用；填说明后提交并清空输入框', async () => {
    const wrapper = mountPane()
    await nextTick()
    const btn = wrapper.find('.commit-btn.primary')
    expect(btn.attributes('disabled')).toBeDefined()
    const msg = wrapper.find('textarea.msg')
    await msg.setValue('fix: 修复右栏切换')
    await nextTick()
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(m.git.commit).toHaveBeenCalledWith('fix: 修复右栏切换', false)
    expect((msg.element as HTMLTextAreaElement).value).toBe('')
  })

  it('勾选 amend 时以 true 提交；即使没有暂存文件也允许提交', async () => {
    m.git.hasStaged = false
    const wrapper = mountPane()
    await nextTick()
    await wrapper.find('.commit-box .amend-label input[type="checkbox"]').setValue(true)
    await wrapper.find('textarea.msg').setValue('amend 说明')
    await nextTick()
    const btn = wrapper.find('.commit-btn.primary')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(m.git.commit).toHaveBeenCalledWith('amend 说明', true)
  })

  it('提交并推送：提交成功后 push；提交失败则不 push', async () => {
    const wrapper = mountPane()
    await nextTick()
    await wrapper.find('textarea.msg').setValue('feat: 第一次')
    await wrapper.find('.commit-btn:not(.primary)').trigger('click')
    await flushPromises()
    expect(m.git.commit).toHaveBeenCalledWith('feat: 第一次', false)
    expect(m.git.runRemoteOp).toHaveBeenCalledWith('push')

    m.git.commit.mockResolvedValueOnce(false)
    m.git.runRemoteOp.mockClear()
    const wrapper2 = mountPane()
    await nextTick()
    await wrapper2.find('textarea.msg').setValue('feat: 会失败')
    await wrapper2.find('.commit-btn:not(.primary)').trigger('click')
    await flushPromises()
    expect(m.git.runRemoteOp).not.toHaveBeenCalled()
  })

  it('Worktree 下拉展示已登记工作树，并能发起新建', async () => {
    const wrapper = mountPane()
    await nextTick()
    await wrapper.find('.wt-btn').trigger('click')
    await nextTick()
    const dd = document.querySelector('.wt-dd')
    expect(dd).not.toBeNull()
    expect(dd!.textContent).toContain('E:/repo-wt-a')
    expect(dd!.querySelectorAll('.wt-item')).toHaveLength(2)
    // 默认建议路径已填好 → 新建按钮可用
    const addBtn = dd!.querySelector('.wt-actions .mini-btn') as HTMLButtonElement
    expect(addBtn.disabled).toBe(false)
    addBtn.click()
    await flushPromises()
    expect(m.git.addWorktree).toHaveBeenCalledTimes(1)
    expect(m.git.addWorktree.mock.calls[0][0]).toEqual(
      expect.objectContaining({ path: expect.stringContaining('repo-wt-') }),
    )
  })

  it('工作区干净时显示空态提示，不渲染变更行', async () => {
    m.git.status = { ...m.makeStatus(), staged: [], unstaged: [], conflicted: [], untracked: [] }
    m.git.totalChanges = 0
    const wrapper = mountPane()
    await nextTick()
    expect(wrapper.find('.empty').text()).toContain('工作区干净')
    expect(wrapper.findAll('.file-row')).toHaveLength(0)
  })

  it('「历史」按钮在 Git 工作区内切换右侧内容区', async () => {
    const wrapper = mountPane()
    await nextTick()
    const btn = wrapper.find('.history-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-label')).toBe('提交历史')
    expect(btn.classes()).not.toContain('active')
    await btn.trigger('click')
    expect(m.files.setGitHistoryOpen).toHaveBeenCalledWith(true)
  })

  it('历史已打开时按钮变「返回编辑器」并传 false', async () => {
    m.files.gitHistoryOpen = true
    const wrapper = mountPane()
    await nextTick()
    const btn = wrapper.find('.history-btn')
    expect(btn.classes()).toContain('active')
    expect(btn.attributes('aria-label')).toBe('返回编辑器')
    await btn.trigger('click')
    expect(m.files.setGitHistoryOpen).toHaveBeenCalledWith(false)
  })
})
