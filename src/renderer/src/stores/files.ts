import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  FileListDir, FileRead, FileWrite, FileCreate, FileRename, FileDelete,
  FileWatch, FileUnwatch, FileChanged,
  FileCopy, FileReveal, FileClipWrite, FileClipRead, ClipboardWrite,
} from '../composables/useElectron'
import { pushToast } from '../composables/useToast'
import { parentOf, absJoin } from '../utils/fileTree'

export interface TreeEntry { name: string; isDir: boolean }
export interface OpenFile {
  relPath: string
  content: string
  dirty: boolean
  binary: boolean
  truncated: boolean
  externalChanged: boolean
  savedVersion: number // 打开/保存时自增，用于区分本地改动与外部变更
}

/** 按会话记忆的工作区现场（tab / 草稿 / 激活文件 / 展开态 / 右栏展开态） */
export interface SessionWorkspace {
  openFiles: OpenFile[]
  drafts: Record<string, string>
  activeRelPath: string | null
  expanded: string[]
  /** 会话右栏（文件工作区折叠栏）是否展开 */
  splitOpen: boolean
  /** 文件树是否折叠：首次进入默认展开，之后以该会话上一次状态为准 */
  collapsed: boolean
}

export const useFilesStore = defineStore('files', () => {
  const workDir = ref('')
  const tree = ref<Record<string, TreeEntry[]>>({ '': [] }) // relPath -> 单层条目
  const expanded = ref<Set<string>>(new Set())
  const openFiles = ref<OpenFile[]>([])
  // 编辑器草稿（relPath -> 未保存内容）。持有权放 store：CodeEditor 折叠/离页卸载不丢草稿
  const drafts = ref<Record<string, string>>({})
  const activeRelPath = ref<string | null>(null)
  const collapsed = ref(false) // 侧栏折叠态（HomeView 持有也可，先放这里）
  /** 工具条「新建文件」请求计数：+1 触发树按选中态弹行内输入（旧实现 rootCreateRequest
   *  硬编码根目录，现跟随 selectedRelPath 解析目标） */
  const createAtRequest = ref(0)
  /** 树选中项（单选；多选不做）。点击行设置，setSession 重置，rename/delete 迁移或清除 */
  const selectedRelPath = ref<string | null>(null)
  /** 应用内文件剪贴板：绝对路径列表。切会话保留（跨会话复制是合理场景） */
  const clipboard = ref<{ op: 'cut' | 'copy'; paths: string[] } | null>(null)
  /** 拖拽瞬态：源 relPath / 落点目录 relPath（null = 未在拖） */
  const dragRel = ref<string | null>(null)
  const dropTargetRel = ref<string | null>(null)
  /** 当前打开的 diff（null = 没有 diff tab）。
   *  left / right 是要对比的两个 revision；right 为 `WORKTREE` 时表示右侧取工作区文件内容
   *  （而不是某个 revision 里的版本）。label 是标签栏上的对比说明（工作区 / 暂存区 / 短 hash）。 */
  const diffRequest = ref<{
    relPath: string
    left: string
    right: string
    label: string
  } | null>(null)
  /** 编辑器区当前展示哪一侧：'file' = 普通编辑器，'diff' = diff 视图。
   *  diffRequest 非空只代表「存在 diff tab」，不代表正在看它 —— diff 与文件 tab 并列，
   *  用户可以切回文件而不必关闭 diff，所以两者必须分开记录。 */
  const activeView = ref<'file' | 'diff'>('file')
  /** 会话右栏（文件工作区折叠栏）是否展开。与文件 tab 组一起按会话记忆：
   *  切回会话时右栏仍是上次那组文件，语义连贯。 */
  const splitOpen = ref(false)

  // 每个会话独立记忆的工作区现场。切换会话即时还原。
  const sessionState = ref<Record<string, SessionWorkspace>>({})
  // 当前已加载现场的会话 id（'' = 无）。setSession 切走时先保存现场到该槽位。
  // 用 ref 而非普通变量：CodeView / BottomPanel 需响应式感知会话切换来重建终端。
  const currentSessionId = ref('')

  async function setSession(id: string, wd: string) {
    // 同一会话重复设置：现场已就绪，直接返回避免误清
    if (currentSessionId.value === id && workDir.value === wd) return
    // 1. 保存当前会话现场（仅当确实有会话在场）
    if (currentSessionId.value && workDir.value) {
      sessionState.value = {
        ...sessionState.value,
        [currentSessionId.value]: {
          openFiles: openFiles.value.map((o) => ({ ...o })),
          drafts: { ...drafts.value },
          activeRelPath: activeRelPath.value,
          expanded: [...expanded.value],
          splitOpen: splitOpen.value,
          collapsed: collapsed.value,
        },
      }
    }
    // 2. 切换工作目录：unwatch 旧目录
    if (workDir.value) await FileUnwatch(workDir.value).catch(() => {})
    workDir.value = wd
    // 切换会话清掉 diff，避免展示上一个目录的文件
    diffRequest.value = null
    activeView.value = 'file'
    currentSessionId.value = id
    tree.value = { '': [] }
    createAtRequest.value = 0
    selectedRelPath.value = null
    dragRel.value = null
    dropTargetRel.value = null
    // clipboard 刻意不清：跨会话粘贴
    // 3. 恢复新会话现场；无则初始化空
    const saved = id ? sessionState.value[id] : undefined
    if (saved) {
      openFiles.value = saved.openFiles.map((o) => ({ ...o }))
      drafts.value = { ...saved.drafts }
      activeRelPath.value = saved.activeRelPath
      expanded.value = new Set(saved.expanded)
      // 展开态跟着文件 tab 组记忆，但没有任何 tab 时不恢复（否则是个空右栏）
      splitOpen.value = saved.splitOpen && saved.openFiles.length > 0
      // 树折叠态以该会话上一次状态为准
      collapsed.value = saved.collapsed
    } else {
      openFiles.value = []
      drafts.value = {}
      activeRelPath.value = null
      expanded.value = new Set()
      splitOpen.value = false
      // 首次进入默认展开文件树，不继承上一个会话的折叠残留
      collapsed.value = false
    }
    // 4. 挂载新目录 watcher + 拉取根目录；恢复的展开目录内容需重新惰性拉取
    if (wd) {
      await FileWatch(wd).catch(() => {})
      await loadDir('').catch(() => {})
      if (saved) {
        for (const dir of saved.expanded) {
          await loadDir(dir).catch(() => {})
        }
      }
    }
  }

  /** 会话删除时清理其现场快照，避免泄漏 */
  function forgetSession(sid: string) {
    // 关闭的是当前加载的会话时，同步失效现场标记，避免延后 watch 触发的
    // setSession 把快照重新保存回来（越删越回填导致泄漏）
    if (sid === currentSessionId.value) currentSessionId.value = ''
    if (!(sid in sessionState.value)) return
    const next = { ...sessionState.value }
    delete next[sid]
    sessionState.value = next
  }

  /** 打开某个文件的 diff（作为 tab 与文件并列），并切到 diff 视图。
   *  变更列表用 `openDiff(path, 'HEAD', 'WORKTREE', '工作区')`；
   *  查看历史提交里的文件用 `openDiff(path, hash + '^', hash, shortHash)`。 */
  function openDiff(relPath: string, left: string, right: string, label: string) {
    diffRequest.value = { relPath, left, right, label }
    activeView.value = 'diff'
  }

  function closeDiff() {
    diffRequest.value = null
    activeView.value = 'file'
  }

  /** 激活某个已打开的文件 tab：切回编辑器视图 */
  function activateFile(relPath: string) {
    activeRelPath.value = relPath
    activeView.value = 'file'
  }

  /** 拉取单层目录（已展开时刷新用）。返回条目列表，不抛错时更新 tree。 */
  async function loadDir(relPath: string): Promise<void> {
    const wd = workDir.value
    if (!wd) return
    const entries = await FileListDir(wd, relPath || undefined)
    tree.value = { ...tree.value, [relPath]: entries }
  }

  async function toggleExpand(relPath: string, isDir: boolean) {
    if (!isDir) return
    if (expanded.value.has(relPath)) {
      expanded.value = new Set([...expanded.value].filter((p) => p !== relPath))
      return
    }
    expanded.value = new Set([...expanded.value, relPath])
    await loadDir(relPath).catch(() => {})
  }

  /** 打开文件：已在 openFiles 则仅切激活；否则读取后加入。 */
  async function openFile(relPath: string) {
    const wd = workDir.value
    if (!wd) return
    const existing = openFiles.value.find((o) => o.relPath === relPath)
    if (existing) { activeRelPath.value = relPath; activeView.value = 'file'; return }
    const r = await FileRead(wd, relPath)
    openFiles.value = [...openFiles.value, {
      relPath, content: r.content, dirty: false, binary: r.binary,
      truncated: r.truncated, externalChanged: false, savedVersion: 0,
    }]
    activeRelPath.value = relPath
    activeView.value = 'file'
  }

  /** 在右栏打开文件（终端里点路径的入口）：打开文件并展开右栏。
   *  与 openFile 分开：openFile 只切 tab（文件树/树内点击本就处于已展开的右栏），
   *  openInSplit 额外负责把收起的右栏拉出来。 */
  async function openInSplit(relPath: string) {
    await openFile(relPath)
    splitOpen.value = true
  }

  /** 写草稿（整体 spread 更新） */
  function setDraft(relPath: string, content: string) {
    drafts.value = { ...drafts.value, [relPath]: content }
  }

  /** 清草稿（仅存在时更新，避免无谓响应） */
  function clearDraft(relPath: string) {
    if (!(relPath in drafts.value)) return
    const next = { ...drafts.value }
    delete next[relPath]
    drafts.value = next
  }

  function closeFile(relPath: string) {
    const f = openFiles.value.find((o) => o.relPath === relPath)
    if (f?.dirty && !window.confirm(`「${relPath}」有未保存修改，确定关闭？`)) return
    openFiles.value = openFiles.value.filter((o) => o.relPath !== relPath)
    clearDraft(relPath)
    if (activeRelPath.value === relPath) {
      activeRelPath.value = openFiles.value[openFiles.value.length - 1]?.relPath ?? null
    }
  }

  /** 编辑器内容变化时上报（保存版本 + 当前内容）。返回新 savedVersion 供编辑器存回。 */
  async function saveFile(relPath: string, content: string): Promise<number> {
    const wd = workDir.value
    if (!wd) return 0
    await FileWrite(wd, relPath, content)
    const f = openFiles.value.find((o) => o.relPath === relPath)
    if (f) {
      f.content = content
      f.dirty = false
      f.externalChanged = false
      f.savedVersion += 1
    }
    return f?.savedVersion ?? 0
  }

  async function reloadFile(relPath: string) {
    const wd = workDir.value
    if (!wd) return
    const r = await FileRead(wd, relPath)
    const f = openFiles.value.find((o) => o.relPath === relPath)
    if (f) {
      f.content = r.content
      f.dirty = false
      f.externalChanged = false
      f.savedVersion += 1
    }
  }

  async function createEntry(parentRel: string, name: string, isDir: boolean) {
    const wd = workDir.value
    if (!wd) return
    const rel = parentRel ? `${parentRel}/${name}` : name
    try {
      await FileCreate(wd, rel, isDir)
      if (!expanded.value.has(parentRel)) expanded.value = new Set([...expanded.value, parentRel])
      await loadDir(parentRel)
    } catch (e: any) {
      // 管理操作失败由 store 负责提示，调用方无需处理
      pushToast({ level: 'error', source: 'file', message: `新建失败：${e?.message ?? e}` })
    }
  }

  async function renameEntry(oldRel: string, newName: string) {
    const wd = workDir.value
    if (!wd) return
    const parent = oldRel.includes('/') ? oldRel.slice(0, oldRel.lastIndexOf('/')) : ''
    const newRel = parent ? `${parent}/${newName}` : newName
    try {
      await FileRename(wd, oldRel, newRel)
      if (parent && expanded.value.has(parent)) await loadDir(parent)
      // 重命名打开的 tab
      openFiles.value = openFiles.value.map((o) => o.relPath === oldRel ? { ...o, relPath: newRel } : o)
      if (activeRelPath.value === oldRel) activeRelPath.value = newRel
      if (selectedRelPath.value === oldRel) selectedRelPath.value = newRel
      // 迁移未保存草稿到新 relPath，避免重命名后编辑器丢失未保存内容
      if (oldRel in drafts.value) {
        const next = { ...drafts.value }
        next[newRel] = next[oldRel]
        delete next[oldRel]
        drafts.value = next
      }
    } catch (e: any) {
      // 管理操作失败由 store 负责提示，调用方无需处理
      pushToast({ level: 'error', source: 'file', message: `重命名失败：${e?.message ?? e}` })
    }
  }

  async function deleteEntry(relPath: string) {
    const wd = workDir.value
    if (!wd) return
    if (!window.confirm(`确定删除「${relPath}」？此操作不可撤销。`)) return
    try {
      await FileDelete(wd, relPath)
      const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      if (parent && expanded.value.has(parent)) await loadDir(parent)
      if (parent === '') await loadDir('')
      // 关闭被删文件的 tab
      openFiles.value = openFiles.value.filter((o) => o.relPath !== relPath)
      clearDraft(relPath)
      if (selectedRelPath.value === relPath) selectedRelPath.value = null
      if (activeRelPath.value === relPath) {
        activeRelPath.value = openFiles.value[openFiles.value.length - 1]?.relPath ?? null
      }
    } catch (e: any) {
      // 管理操作失败由 store 负责提示，调用方无需处理
      pushToast({ level: 'error', source: 'file', message: `删除失败：${e?.message ?? e}` })
    }
  }

  /** 设置选中项（null 取消选中） */
  function select(rel: string | null) {
    selectedRelPath.value = rel
  }

  /** 从已加载的 tree 判断条目是否目录；查不到（未加载/已删除）返回 null */
  function entryIsDir(rel: string): boolean | null {
    const parent = parentOf(rel)
    const name = rel.slice(parent ? parent.length + 1 : 0)
    const e = tree.value[parent]?.find((x) => x.name === name)
    return e ? e.isDir : null
  }

  /** 复制/剪切：写内部剪贴板并同步系统剪贴板（外部粘贴依赖） */
  async function setClipboard(relPath: string, op: 'cut' | 'copy') {
    const wd = workDir.value
    if (!wd || !relPath) return
    const paths = [absJoin(wd, relPath)]
    clipboard.value = { op, paths }
    await FileClipWrite(paths).catch(() => {}) // 系统剪贴板失败不阻塞内部粘贴
  }

  /** 复制路径（绝对）/ 复制相对路径 → 系统剪贴板文本 */
  async function copyPath(relPath: string, absolute: boolean) {
    const wd = workDir.value
    if (!wd) return
    try {
      await ClipboardWrite(absolute ? absJoin(wd, relPath) : relPath)
    } catch (e: any) {
      pushToast({ level: 'error', source: 'file', message: `复制路径失败：${e?.message ?? e}` })
    }
  }

  async function applyCopyResult(
    r: { ok: string[]; failed: { path: string; error: string }[] },
    destParentRel: string,
    failLabel: string,
  ) {
    if (r.ok.length) {
      if (destParentRel && !expanded.value.has(destParentRel)) {
        expanded.value = new Set([...expanded.value, destParentRel])
      }
      await loadDir(destParentRel)
      selectedRelPath.value = r.ok[0]
    }
    if (r.failed.length) {
      pushToast({ level: 'error', source: 'file', message: `${failLabel}：${r.failed[0].error}` })
    }
  }

  /** 粘贴到 destParentRel（菜单上下文决定：dir=自身 / file=父 / blank=根）。
   *  内部剪贴板优先，空则回退系统剪贴板路径；成功（有 ok）后清内部剪贴板。 */
  async function pasteInto(destParentRel: string) {
    const wd = workDir.value
    if (!wd) return
    let paths = clipboard.value?.paths ?? []
    const op = clipboard.value?.op ?? 'copy'
    if (!paths.length) {
      paths = await FileClipRead().catch(() => [])
      if (!paths.length) {
        pushToast({ level: 'warn', source: 'file', message: '剪贴板中的源文件不存在或没有可粘贴的路径' })
        return
      }
    }
    try {
      const r = await FileCopy(paths, wd, destParentRel, op === 'cut' ? 'move' : 'copy')
      if (r.ok.length) clipboard.value = null
      await applyCopyResult(r, destParentRel, '粘贴失败')
    } catch (e: any) {
      pushToast({ level: 'error', source: 'file', message: `粘贴失败：${e?.message ?? e}` })
    }
  }

  /** 拖拽落点移动（安全校验在主进程 copyEntries，此处只透传结果） */
  async function moveEntry(srcRel: string, destParentRel: string) {
    const wd = workDir.value
    if (!wd || !srcRel) return
    const srcParent = parentOf(srcRel)
    try {
      const r = await FileCopy([absJoin(wd, srcRel)], wd, destParentRel, 'move')
      if (r.ok.length) {
        await loadDir(srcParent)
      }
      await applyCopyResult(r, destParentRel, '移动失败')
    } catch (e: any) {
      pushToast({ level: 'error', source: 'file', message: `移动失败：${e?.message ?? e}` })
    }
  }

  /** 系统资源管理器中显示 */
  async function revealEntry(relPath: string) {
    const wd = workDir.value
    if (!wd) return
    try {
      await FileReveal(wd, relPath)
    } catch (e: any) {
      pushToast({ level: 'error', source: 'file', message: `在资源管理器中显示失败：${e?.message ?? e}` })
    }
  }

  /** 全部折叠（菜单「全部折叠」） */
  function collapseAll() {
    expanded.value = new Set()
  }

  /** 刷新根 + 所有已展开目录（工具条与菜单「刷新」共用） */
  async function refreshAll() {
    const dirs = new Set([''])
    for (const d of expanded.value) dirs.add(d)
    await Promise.all(Array.from(dirs).map((d) => loadDir(d).catch(() => {})))
  }

  // 外部变更：局部刷新树 + 处理打开文件的冲突
  let fileChangedCleanup: (() => void) | null = null
  function initWatcher() {
    fileChangedCleanup?.()
    fileChangedCleanup = FileChanged((e: { workDir: string; relPath: string }) => {
      if (e.workDir !== workDir.value) return
      const parts = e.relPath.split('/')
      const parent = parts.slice(0, -1).join('/')
      if (expanded.value.has(parent)) void loadDir(parent).catch(() => {})
      const f = openFiles.value.find((o) => o.relPath === e.relPath)
      if (f && !f.dirty) void reloadFile(e.relPath).catch(() => {})
      else if (f && f.dirty) f.externalChanged = true
    })
  }
  initWatcher()

  return {
    workDir, currentSessionId, tree, expanded, openFiles, drafts, activeRelPath, collapsed,
    createAtRequest, selectedRelPath, clipboard, dragRel, dropTargetRel,
    splitOpen,
    diffRequest, activeView, openDiff, closeDiff, activateFile,
    setSession, forgetSession, loadDir, toggleExpand, openFile, openInSplit, closeFile, saveFile, reloadFile,
    setDraft, clearDraft,
    createEntry, renameEntry, deleteEntry,
    select, entryIsDir, setClipboard, copyPath, pasteInto, moveEntry, revealEntry, collapseAll, refreshAll,
    cleanupWatcher: () => { fileChangedCleanup?.(); fileChangedCleanup = null },
  }
})
