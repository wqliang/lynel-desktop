// 验证分屏展开态：openInSplit 打开文件并展开右栏；展开态按会话记忆
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFilesStore } from './files'
import { pushToast } from '../composables/useToast'
import { FileCopy, FileClipWrite, FileClipRead, FileChanged, FileListDir } from '../composables/useElectron'

vi.mock('../composables/useToast', () => ({ pushToast: vi.fn() }))

vi.mock('../composables/useElectron', () => ({
  FileListDir: vi.fn(() => Promise.resolve([])),
  FileRead: vi.fn((_wd: string, rel: string) =>
    Promise.resolve({ content: `// ${rel}`, binary: false, truncated: false })),
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

describe('files store · 分屏展开态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认不展开', () => {
    expect(useFilesStore().splitOpen).toBe(false)
  })

  it('openInSplit 打开文件并展开右栏', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.openInSplit('src/main/app.ts')
    expect(store.splitOpen).toBe(true)
    expect(store.activeRelPath).toBe('src/main/app.ts')
    expect(store.openFiles.map((f) => f.relPath)).toEqual(['src/main/app.ts'])
  })

  it('切走再切回恢复该会话的展开态', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.openInSplit('src/main/app.ts')
    await store.setSession('s2', '/other')
    expect(store.splitOpen).toBe(false)
    await store.setSession('s1', '/repo')
    expect(store.splitOpen).toBe(true)
    expect(store.activeRelPath).toBe('src/main/app.ts')
  })

  it('展开态但没有任何打开文件时不恢复展开（避免空右栏）', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.openInSplit('src/main/app.ts')
    store.closeFile('src/main/app.ts')
    await store.setSession('s2', '/other')
    await store.setSession('s1', '/repo')
    expect(store.splitOpen).toBe(false)
  })
})

describe('files store · 文件树折叠态按会话记忆', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('首次进入默认展开文件树', async () => {
    const store = useFilesStore()
    expect(store.collapsed).toBe(false)
    store.collapsed = true // 模拟进过别的地方被折叠
    await store.setSession('s1', '/repo')
    expect(store.collapsed).toBe(false)
  })

  it('折叠树后切走再切回，恢复该会话的折叠状态', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.collapsed = true
    await store.setSession('s2', '/other')
    // 无现场的新会话：默认展开，不继承上一个会话的折叠残留
    expect(store.collapsed).toBe(false)
    await store.setSession('s1', '/repo')
    expect(store.collapsed).toBe(true)
  })

  it('同一会话内折叠后切到别的会话再切回仍记住折叠（splitOpen 守卫不影响它）', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.collapsed = true
    await store.setSession('s2', '/other')
    await store.setSession('s1', '/repo')
    expect(store.collapsed).toBe(true)
    // 恢复展开后树仍折叠 = 以用户上一次状态为准
    store.splitOpen = true
    expect(store.collapsed).toBe(true)
  })
})

describe('files store · 选中态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('setSession 重置选中', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('src/a.ts')
    expect(store.selectedRelPath).toBe('src/a.ts')
    await store.setSession('s2', '/other')
    expect(store.selectedRelPath).toBe(null)
  })

  it('clipboard 跨会话保留（切会话不清）', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('a.ts', 'copy')
    await store.setSession('s2', '/other')
    expect(store.clipboard?.op).toBe('copy')
  })

  it('renameEntry 把选中迁移到新 relPath', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('src/a.ts')
    await store.renameEntry('src/a.ts', 'b.ts')
    expect(store.selectedRelPath).toBe('src/b.ts')
  })

  it('deleteEntry 删除选中项时清空选中', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('a.ts')
    await store.deleteEntry('a.ts')
    expect(store.selectedRelPath).toBe(null)
  })
})

describe('files store · 剪贴板动作', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('setClipboard 记绝对路径并同步系统剪贴板', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('src/a.ts', 'cut')
    expect(store.clipboard).toEqual({ op: 'cut', paths: ['/repo/src/a.ts'] })
    expect(FileClipWrite).toHaveBeenCalledWith(['/repo/src/a.ts'])
  })

  it('copyPath 绝对/相对走 ClipboardWrite', async () => {
    const { ClipboardWrite } = await import('../composables/useElectron')
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.copyPath('src/a.ts', true)
    expect(ClipboardWrite).toHaveBeenCalledWith('/repo/src/a.ts')
    await store.copyPath('src/a.ts', false)
    expect(ClipboardWrite).toHaveBeenCalledWith('src/a.ts')
  })

  it('pasteInto 用内部剪贴板 copy 粘贴：成功后清剪贴板、选中第一个新条目、刷新目标', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('src/a.ts', 'copy')
    await store.pasteInto('dest')
    expect(FileCopy).toHaveBeenCalledWith(['/repo/src/a.ts'], '/repo', 'dest', 'copy')
    expect(store.clipboard).toBe(null)
    expect(store.selectedRelPath).toBe('dest/a.ts')
  })

  it('cut 粘贴走 move 模式', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('src/a.ts', 'cut')
    await store.pasteInto('dest')
    expect(FileCopy).toHaveBeenCalledWith(['/repo/src/a.ts'], '/repo', 'dest', 'move')
  })

  it('内部剪贴板空时回退 FileClipRead：两级皆空则 toast「剪贴板为空」且不发 copy IPC', async () => {
    vi.mocked(FileClipRead).mockResolvedValueOnce([])
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.pasteInto('')
    expect(FileClipRead).toHaveBeenCalledTimes(1) // 第二级确实回退读了系统剪贴板
    expect(FileCopy).not.toHaveBeenCalled() // 两级皆空不发 file:copy
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn', source: 'file', message: '剪贴板为空',
    }))
  })

  it('内部为空时回退 FileClipRead 成功：用读到的外部路径 copy（外部粘贴入口）', async () => {
    vi.mocked(FileClipRead).mockResolvedValueOnce(['D:/x/y.ts'])
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['y.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.pasteInto('')
    expect(FileClipRead).toHaveBeenCalledTimes(1)
    expect(FileCopy).toHaveBeenCalledWith(['D:/x/y.ts'], '/repo', '', 'copy')
    // 外部粘贴成功后内部剪贴板本就是空的，清空是 no-op —— 不残留脏状态
    expect(store.clipboard).toBe(null)
  })

  it('部分失败：toast error，成功的条目仍生效', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [{ path: '/x/g.ts', error: '源文件不存在：/x/g.ts' }] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('a.ts', 'copy')
    await store.pasteInto('dest')
    expect(store.selectedRelPath).toBe('dest/a.ts')
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
  })

  it('moveEntry 刷新源父与目标目录并迁移选中', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('src/a.ts')
    await store.moveEntry('src/a.ts', 'dest')
    expect(FileCopy).toHaveBeenCalledWith(['/repo/src/a.ts'], '/repo', 'dest', 'move')
    expect(store.selectedRelPath).toBe('dest/a.ts')
  })
})

describe('files store · watcher 外部删除清选中', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 捕获 store 创建时注册的 file:changed 回调，供测试手动触发 */
  function captureWatcher() {
    const handlers: Array<(e: { workDir: string; relPath: string }) => void> = []
    vi.mocked(FileChanged).mockImplementation((cb) => {
      handlers.push(cb)
      return vi.fn()
    })
    return handlers
  }

  it('watcher 事件刷新后被选中项已不存在（外部删除）→ 选中态被清空', async () => {
    const handlers = captureWatcher()
    vi.mocked(FileListDir)
      .mockResolvedValueOnce([])                               // setSession 拉根
      .mockResolvedValueOnce([{ name: 'a.ts', isDir: false }]) // 首次展开 src：a.ts 还在
      .mockResolvedValueOnce([])                               // watcher 刷新：a.ts 已被外部删除
    const store = useFilesStore() // store 创建时注册 watcher
    await store.setSession('s1', '/repo')
    await store.toggleExpand('src', true)
    store.select('src/a.ts')
    expect(store.selectedRelPath).toBe('src/a.ts')

    handlers[0]({ workDir: '/repo', relPath: 'src/a.ts' })
    await new Promise((r) => setTimeout(r, 0)) // 等 loadDir 与选中清理跑完
    expect(store.selectedRelPath).toBe(null)
  })

  it('watcher 事件后条目仍在：选中态保持不动', async () => {
    const handlers = captureWatcher()
    vi.mocked(FileListDir)
      .mockResolvedValueOnce([])                               // setSession 拉根
      .mockResolvedValueOnce([{ name: 'a.ts', isDir: false }]) // 展开 src
      .mockResolvedValueOnce([{ name: 'a.ts', isDir: false }]) // watcher 刷新：a.ts 仍在
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.toggleExpand('src', true)
    store.select('src/a.ts')

    handlers[0]({ workDir: '/repo', relPath: 'src/a.ts' })
    await new Promise((r) => setTimeout(r, 0))
    expect(store.selectedRelPath).toBe('src/a.ts')
  })
})

describe('files store · md 三模式偏好', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('默认 editor&preview（split）', () => {
    expect(useFilesStore().mdMode).toBe('split')
  })

  it('setMdMode 即时生效并写入全局偏好', () => {
    const store = useFilesStore()
    store.setMdMode('preview')
    expect(store.mdMode).toBe('preview')
    expect(localStorage.getItem('lynel:md-mode')).toBe('preview')
  })

  it('新建 store 读取全局偏好；非法值回落 split', () => {
    localStorage.setItem('lynel:md-mode', 'editor')
    setActivePinia(createPinia())
    expect(useFilesStore().mdMode).toBe('editor')
    localStorage.setItem('lynel:md-mode', 'bogus')
    setActivePinia(createPinia())
    expect(useFilesStore().mdMode).toBe('split')
  })

  it('按会话记忆：切走再切回恢复该会话的模式', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.setMdMode('preview')
    await store.setSession('s2', '/other')
    // 新会话采用全局偏好（此时全局已是 preview）
    expect(store.mdMode).toBe('preview')
    store.setMdMode('editor')
    await store.setSession('s1', '/repo')
    expect(store.mdMode).toBe('preview')
  })

  it('无现场的新会话采用全局偏好，不继承别的会话最后一次模式', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.setMdMode('editor')
    localStorage.setItem('lynel:md-mode', 'split')
    await store.setSession('s2', '/other')
    expect(store.mdMode).toBe('split')
  })
})

describe('files store · 右栏视图与 diff 布局偏好', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('默认文件视图 + 左右双栏 diff', () => {
    const store = useFilesStore()
    expect(store.rightView).toBe('file')
    expect(store.diffLayout).toBe('side')
  })

  it('切到 Git 视图即时生效、写全局偏好，并自动展开右栏', () => {
    const store = useFilesStore()
    expect(store.splitOpen).toBe(false)
    store.setRightView('git')
    expect(store.rightView).toBe('git')
    expect(store.splitOpen).toBe(true)
    expect(localStorage.getItem('lynel:right-pane-view')).toBe('git')
  })

  it('切到 inline diff 即时生效并写全局偏好', () => {
    const store = useFilesStore()
    store.setDiffLayout('inline')
    expect(store.diffLayout).toBe('inline')
    expect(localStorage.getItem('lynel:git-diff-layout')).toBe('inline')
  })

  it('新建 store 读取全局偏好；非法值回落默认值', () => {
    localStorage.setItem('lynel:right-pane-view', 'git')
    localStorage.setItem('lynel:git-diff-layout', 'inline')
    setActivePinia(createPinia())
    expect(useFilesStore().rightView).toBe('git')
    expect(useFilesStore().diffLayout).toBe('inline')

    localStorage.setItem('lynel:right-pane-view', 'bogus')
    localStorage.setItem('lynel:git-diff-layout', 'bogus')
    setActivePinia(createPinia())
    expect(useFilesStore().rightView).toBe('file')
    expect(useFilesStore().diffLayout).toBe('side')
  })

  it('按会话记忆：切走再切回恢复该会话的视图与 diff 布局', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.setRightView('git')
    store.setDiffLayout('inline')
    await store.setSession('s2', '/other')
    store.setRightView('file')
    store.setDiffLayout('side')
    await store.setSession('s1', '/repo')
    expect(store.rightView).toBe('git')
    expect(store.diffLayout).toBe('inline')
  })

  it('Git 视图且无打开文件时，切走再切回仍保持右栏展开', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.setRightView('git')
    expect(store.openFiles).toHaveLength(0)
    await store.setSession('s2', '/other')
    await store.setSession('s1', '/repo')
    expect(store.rightView).toBe('git')
    expect(store.splitOpen).toBe(true)
  })

  it('「右栏」入口：从收起的 Git 视图 + 历史图一键回到文件面板，并写回偏好', () => {
    const store = useFilesStore()
    store.setRightView('git')
    store.setGitHistoryOpen(true)
    store.splitOpen = false
    store.openFilePane()
    expect(store.rightView).toBe('file')
    expect(store.splitOpen).toBe(true)
    expect(store.gitHistoryOpen).toBe(false)
    // 下次启动默认落在文件面板，不会又变成 Git 变更清单
    expect(localStorage.getItem('lynel:right-pane-view')).toBe('file')
    expect(localStorage.getItem('lynel:git-history-open')).toBe('0')
  })

  it('「右栏」入口：已在文件视图时只负责展开，不动 diff / 打开的文件', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.openDiff('src/a.ts', 'HEAD', 'WORKTREE', '工作区')
    store.splitOpen = false
    store.openFilePane()
    expect(store.splitOpen).toBe(true)
    expect(store.rightView).toBe('file')
    expect(store.activeView).toBe('diff')
    expect(store.diffRequest?.relPath).toBe('src/a.ts')
  })
})

describe('files store · 提交历史并入 Git 工作区后的右侧内容区偏好', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('setGitHistoryOpen 写全局偏好，默认值为 false', () => {
    const store = useFilesStore()
    expect(store.gitHistoryOpen).toBe(false)
    store.setGitHistoryOpen(true)
    expect(store.gitHistoryOpen).toBe(true)
    expect(localStorage.getItem('lynel:git-history-open')).toBe('1')
    store.setGitHistoryOpen(false)
    expect(localStorage.getItem('lynel:git-history-open')).toBe('0')
  })

  it('openDiff 自动关掉历史视图，保证点历史文件能立刻看到 diff', () => {
    const store = useFilesStore()
    store.setGitHistoryOpen(true)
    store.openDiff('src/a.ts', 'HEAD', 'WORKTREE', '工作区')
    expect(store.activeView).toBe('diff')
    expect(store.gitHistoryOpen).toBe(false)
    expect(localStorage.getItem('lynel:git-history-open')).toBe('0')
  })

  it('新建 store 读取全局偏好；非法值回落 false', () => {
    localStorage.setItem('lynel:git-history-open', '1')
    setActivePinia(createPinia())
    expect(useFilesStore().gitHistoryOpen).toBe(true)
    localStorage.setItem('lynel:git-history-open', 'bogus')
    setActivePinia(createPinia())
    expect(useFilesStore().gitHistoryOpen).toBe(false)
  })

  it('按会话记忆：切走再切回恢复该会话是否停在历史视图', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.setGitHistoryOpen(true)
    await store.setSession('s2', '/other')
    expect(store.gitHistoryOpen).toBe(true) // 无现场的新会话采用全局偏好
    store.setGitHistoryOpen(false)
    await store.setSession('s1', '/repo')
    expect(store.gitHistoryOpen).toBe(true)
  })
})
