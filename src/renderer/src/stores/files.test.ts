// 验证分屏展开态：openInSplit 打开文件并展开右栏；展开态按会话记忆
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFilesStore } from './files'
import { pushToast } from '../composables/useToast'
import { FileCopy, FileClipWrite, FileClipRead } from '../composables/useElectron'

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

  it('内部剪贴板空时回退 FileClipRead；都空则 toast 且不发 copy', async () => {
    vi.mocked(FileClipRead).mockResolvedValueOnce([])
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.pasteInto('')
    expect(FileCopy).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', source: 'file' }))
  })

  it('FileClipRead 回退成功：用读到的路径 copy', async () => {
    vi.mocked(FileClipRead).mockResolvedValueOnce(['D:/x/y.ts'])
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['y.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.pasteInto('')
    expect(FileCopy).toHaveBeenCalledWith(['D:/x/y.ts'], '/repo', '', 'copy')
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
