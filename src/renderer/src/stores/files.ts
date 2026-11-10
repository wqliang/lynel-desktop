import { acceptHMRUpdate, defineStore } from 'pinia'
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

/** Markdown 文件的编辑器/预览布局模式：纯编辑 / 左右分栏 / 纯预览。 */
export type MdMode = 'editor' | 'split' | 'preview'

const MD_MODE_KEY = 'lynel:md-mode'
const MD_MODE_DEFAULT: MdMode = 'split'

/** 全局偏好（localStorage）。读取失败或非合法值一律回落默认值，
 *  保证在测试环境 / 隐私模式下 store 仍可正常创建。 */
function readMdMode(): MdMode {
  try {
    const v = localStorage.getItem(MD_MODE_KEY)
    if (v === 'editor' || v === 'split' || v === 'preview') return v
  } catch { /* localStorage 不可用 */ }
  return MD_MODE_DEFAULT
}

/** 右栏顶部的一级视图：文件工作区（左栏文件树）/ Git 工作区（左栏变更清单）。
 *  注意与 activeView（编辑器区 file|diff）是两层概念，不能混用。 */
export type RightPaneView = 'file' | 'git'
/** diff 布局：side = 左右双栏，inline = 上下统一（Monaco renderSideBySide）。 */
export type DiffLayout = 'side' | 'inline'

const RIGHT_VIEW_KEY = 'lynel:right-pane-view'
const DIFF_LAYOUT_KEY = 'lynel:git-diff-layout'
const GIT_HISTORY_KEY = 'lynel:git-history-open'
const RIGHT_VIEW_DEFAULT: RightPaneView = 'file'
const DIFF_LAYOUT_DEFAULT: DiffLayout = 'side'

function readRightView(): RightPaneView {
  try {
    const v = localStorage.getItem(RIGHT_VIEW_KEY)
    if (v === 'file' || v === 'git') return v
  } catch { /* localStorage 不可用 */ }
  return RIGHT_VIEW_DEFAULT
}
function readDiffLayout(): DiffLayout {
  try {
    const v = localStorage.getItem(DIFF_LAYOUT_KEY)
    if (v === 'side' || v === 'inline') return v
  } catch { /* localStorage 不可用 */ }
  return DIFF_LAYOUT_DEFAULT
}
/** 提交历史折叠进 Git 工作区后，右侧内容区是否停在历史视图。默认回 diff/编辑器，
 *  避免新会话一进 Git 视图就看不到变更文件的 diff。 */
function readGitHistoryOpen(): boolean {
  try { return localStorage.getItem(GIT_HISTORY_KEY) === '1' } catch { return false }
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
  /** 该会话最后一次使用的 md 布局模式；老快照缺字段时回落全局偏好 */
  mdMode: MdMode
  /** 该会话右栏一级视图；老快照缺字段时回落全局偏好 */
  rightView: RightPaneView
  /** diff 布局偏好；老快照缺字段时回落全局偏好 */
  diffLayout: DiffLayout
  /** Git 视图右侧内容区是否停在提交历史；老快照缺字段时回落全局偏好 */
  gitHistoryOpen: boolean
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
  /** md 文件的布局模式：全局偏好作为初值，切会话时按现场还原 */
  const mdMode = ref<MdMode>(readMdMode())
  /** 右栏一级视图（文件 / Git）：全局偏好 + 按会话现场 */
  const rightView = ref<RightPaneView>(readRightView())
  /** diff 布局：全局偏好 + 按会话现场 */
  const diffLayout = ref<DiffLayout>(readDiffLayout())
  /** Git 视图右侧内容区：false = 编辑器/diff，true = 提交历史图。全局偏好 + 按会话现场 */
  const gitHistoryOpen = ref<boolean>(readGitHistoryOpen())

  function setMdMode(mode: MdMode) {
    mdMode.value = mode
    try { localStorage.setItem(MD_MODE_KEY, mode) } catch { /* localStorage 不可用 */ }
  }

  /** 切到 Git 视图时顺带把右栏展开，避免用户在收起态点了分段却看不到内容。 */
  function setRightView(v: RightPaneView) {
    rightView.value = v
    if (v === 'git') splitOpen.value = true
    try { localStorage.setItem(RIGHT_VIEW_KEY, v) } catch { /* localStorage 不可用 */ }
  }

  function setDiffLayout(v: DiffLayout) {
    diffLayout.value = v
    try { localStorage.setItem(DIFF_LAYOUT_KEY, v) } catch { /* localStorage 不可用 */ }
  }

  function setGitHistoryOpen(v: boolean) {
    gitHistoryOpen.value = v
    try { localStorage.setItem(GIT_HISTORY_KEY, v ? '1' : '0') } catch { /* localStorage 不可用 */ }
  }

  /** 「右栏」按钮的单一动作：展开右栏并回到文件工作区（文件树 + 编辑器）。
   *  rightView 是全局持久化偏好，上次停在 Git 视图 / 提交历史时，重启后右栏会
   *  直接展开成变更清单，用户找不到文件面板；显式切回 file 并写入偏好，下次启动
   *  默认也是文件面板。历史图只在 Git 视图下显示，顺手关掉避免切回 Git 视图时
   *  又直接落在历史图上。 */
  function openFilePane() {
    setRightView('file')
    splitOpen.value = true
    setGitHistoryOpen(false)
  }

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
          mdMode: mdMode.value,
          rightView: rightView.value,
          diffLayout: diffLayout.value,
          gitHistoryOpen: gitHistoryOpen.value,
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
      // 展开态跟着文件 tab 组记忆，但没有任何 tab 时不恢复（否则是个空右栏）。
      // 例外：上次停在 Git 视图时，即使没有打开的文件也要恢复展开，否则 Git 入口会「消失」。
      const lastView = saved.rightView ?? readRightView()
      splitOpen.value = saved.splitOpen && (saved.openFiles.length > 0 || lastView === 'git')
      // 树折叠态以该会话上一次状态为准
      collapsed.value = saved.collapsed
      // 老快照可能没有这些字段，回落全局偏好
      mdMode.value = saved.mdMode ?? readMdMode()
      rightView.value = lastView
      diffLayout.value = saved.diffLayout ?? readDiffLayout()
      gitHistoryOpen.value = saved.gitHistoryOpen ?? readGitHistoryOpen()
    } else {
      openFiles.value = []
      drafts.value = {}
      activeRelPath.value = null
      expanded.value = new Set()
      splitOpen.value = false
      // 首次进入默认展开文件树，不继承上一个会话的折叠残留
      collapsed.value = false
      // 新会话采用全局偏好（即用户最近一次选择的模式）
      mdMode.value = readMdMode()
      rightView.value = readRightView()
      diffLayout.value = readDiffLayout()
      gitHistoryOpen.value = readGitHistoryOpen()
    }
    // Git 视图没有「打开文件」这个展开理由，必须自己保证右栏可见
    if (id && rightView.value === 'git') splitOpen.value = true
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
    // 历史图占着右侧内容区时，点历史里的文件（或变更清单里的文件）必须切回 diff，
    // 否则 openDiff 把 activeView 改了，用户却还盯着被隐藏的编辑器区。
    setGitHistoryOpen(false)
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
   *  三级回退：① 内部剪贴板非空 → 用它；② 为空 → FileClipRead 读系统剪贴板
   *  （主进程已过滤不存在的路径，外部源按现有逻辑处理）；③ 两级皆空 →
   *  warn「剪贴板为空」，不发 IPC。成功（有 ok）后清内部剪贴板 ——
   *  外部粘贴时内部本就为空，清空是 no-op，不会误清别的东西。 */
  async function pasteInto(destParentRel: string) {
    const wd = workDir.value
    if (!wd) return
    let paths = clipboard.value?.paths ?? []
    const op = clipboard.value?.op ?? 'copy'
    if (!paths.length) {
      paths = await FileClipRead().catch(() => [])
    }
    if (!paths.length) {
      pushToast({ level: 'warn', source: 'file', message: '剪贴板为空' })
      return
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
  // 开发态 HMR 会用新 setup 重新 patch 同一个 store 实例，旧闭包里的退订函数
  // 就再也拿不到了。把 cleanup 挂到 hot.data 上跨模块版本保存，重新订阅前先退订，
  // 否则每热更新一次就叠加一个 file:changed 监听（一次文件改动刷新 N 次树）。
  const hotData = import.meta.hot?.data as
    | { fileChangedCleanup?: (() => void) | null }
    | undefined

  /** 刷新后选中项已不在树里（外部删除）→ 清空选中（spec §1：watcher 删除 → 清空若是被删项）。
   *  按选中项的父目录查 tree[parent]；根级选中查 tree['']。父目录未加载（查不到）时不清，
   *  避免拿不完整的数据误清。不清会让 +/F2/Delete 指向已不存在的幽灵路径。 */
  function clearSelectionIfGone() {
    const sel = selectedRelPath.value
    if (!sel) return
    const parent = parentOf(sel)
    const name = sel.slice(parent ? parent.length + 1 : 0)
    const entries = tree.value[parent]
    if (entries && !entries.some((x) => x.name === name)) selectedRelPath.value = null
  }

  function initWatcher() {
    hotData?.fileChangedCleanup?.()
    fileChangedCleanup?.()
    fileChangedCleanup = FileChanged((e: { workDir: string; relPath: string }) => {
      if (e.workDir !== workDir.value) return
      const parts = e.relPath.split('/')
      const parent = parts.slice(0, -1).join('/')
      const refresh = expanded.value.has(parent) ? loadDir(parent).catch(() => {}) : Promise.resolve()
      void refresh.then(clearSelectionIfGone) // 刷新树后再查，拿的是最新条目列表
      const f = openFiles.value.find((o) => o.relPath === e.relPath)
      if (f && !f.dirty) void reloadFile(e.relPath).catch(() => {})
      else if (f && f.dirty) f.externalChanged = true
    })
    if (hotData) hotData.fileChangedCleanup = fileChangedCleanup
  }
  initWatcher()

  return {
    workDir, currentSessionId, tree, expanded, openFiles, drafts, activeRelPath, collapsed,
    createAtRequest, selectedRelPath, clipboard, dragRel, dropTargetRel,
    splitOpen, mdMode, setMdMode,
    rightView, setRightView, diffLayout, setDiffLayout,
    gitHistoryOpen, setGitHistoryOpen, openFilePane,
    diffRequest, activeView, openDiff, closeDiff, activateFile,
    setSession, forgetSession, loadDir, toggleExpand, openFile, openInSplit, closeFile, saveFile, reloadFile,
    setDraft, clearDraft,
    createEntry, renameEntry, deleteEntry,
    select, entryIsDir, setClipboard, copyPath, pasteInto, moveEntry, revealEntry, collapseAll, refreshAll,
    cleanupWatcher: () => {
      fileChangedCleanup?.()
      fileChangedCleanup = null
      if (hotData) hotData.fileChangedCleanup = null
    },
  }
})

// setup store 的模块热更新默认不会重建实例：pinia._s 里留着旧的 store，
// 新加的 ref / action 不会挂上去。组件 HMR 后模板调用新 action 就会抛
// "xxx is not a function"（本次「历史」按钮就是这个原因）。注册 Pinia 官方
// HMR 适配器后，改动 store 会 patch 现有实例，无需整页重载。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFilesStore, import.meta.hot))
}
