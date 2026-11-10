<script setup lang="ts">
/**
 * Git 工作区的左栏：顶栏（分支 / Pull / Push / 刷新 / worktree）+ 变更清单 + 提交表单。
 *
 * 设计要点：它只替换右栏「左栏」的内容，右侧 FileEditorPanel（编辑器 / diff）常驻，
 * 因此点变更行 openDiff 后 diff 立刻在右边可见 —— 这是 IDEA「Commit 工具窗口 + 右侧 diff」
 * 的习惯，同时保证全应用仍然只有一个 Monaco / 一个 DiffEditor 实例。
 */
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useGitStore } from '../../stores/git'
import { useFilesStore } from '../../stores/files'
import { ClipboardWrite, type GitFileChange } from '../../composables/useElectron'
import { pushToast } from '../../composables/useToast'
import { useResizablePanel } from '../../composables/useResizablePanel'

const git = useGitStore()
const files = useFilesStore()

const MESSAGE_MAX = 4000
const message = ref('')
const amend = ref(false)
const committing = ref(false)

// ---------- 面板宽度（与文件树对称，可拖） ----------
const { width, onResizeStart } = useResizablePanel({
  storageKey: 'lynel:git-pane-width',
  defaultWidth: 340,
  min: 240,
  max: 520,
  handle: 'right',
})

// ---------- 变更清单树 ----------
type GroupKey = 'conflicted' | 'staged' | 'unstaged' | 'untracked'
interface Group {
  key: GroupKey
  label: string
  items: GitFileChange[]
}
const GROUP_LABEL: Record<GroupKey, string> = {
  conflicted: '冲突',
  staged: '暂存的更改',
  unstaged: '更改',
  untracked: '未跟踪',
}
const groups = computed<Group[]>(() => {
  const s = git.status
  if (!s) return []
  const all: Group[] = [
    { key: 'conflicted', label: GROUP_LABEL.conflicted, items: s.conflicted },
    { key: 'staged', label: GROUP_LABEL.staged, items: s.staged },
    { key: 'unstaged', label: GROUP_LABEL.unstaged, items: s.unstaged },
    { key: 'untracked', label: GROUP_LABEL.untracked, items: s.untracked },
  ]
  return all.filter((g) => g.items.length > 0)
})

const statusLabel: Record<GitFileChange['status'], string> = {
  M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U',
}

interface Row {
  type: 'group' | 'dir' | 'file'
  key: string
  label: string
  depth: number
  count?: number
  dirKey?: string
  group?: GroupKey
  file?: GitFileChange
}

/** 折叠的目录集合。key = group + ':' + 目录路径 */
const collapsedDirs = ref<Set<string>>(new Set())
/** 勾选的文件集合。key = group + ':' + path */
const selected = ref<Set<string>>(new Set())

function fileKey(group: GroupKey, path: string): string {
  return `${group}:${path}`
}

/** 按「四组 → 目录 → 文件」展开成可渲染的扁平行。
 *  用扁平行而非递归组件，避免为几十个变更引入一整套树组件。 */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const g of groups.value) {
    out.push({ type: 'group', key: `g:${g.key}`, label: g.label, depth: 0, count: g.items.length, group: g.key })
    const seenDirs = new Set<string>()
    for (const f of g.items) {
      const parts = f.path.split('/')
      let prefix = ''
      // 中间目录：生成可折叠行，并把后代挂在其下（靠 collapsed 判断跳过）
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
        if (seenDirs.has(prefix)) continue
        seenDirs.add(prefix)
        out.push({
          type: 'dir',
          key: `d:${g.key}:${prefix}`,
          label: parts[i],
          depth: i + 1,
          dirKey: fileKey(g.key, prefix),
          group: g.key,
        })
      }
      // 若任一祖先目录被折叠，跳过该文件
      let hidden = false
      let p = ''
      for (let i = 0; i < parts.length - 1; i++) {
        p = p ? `${p}/${parts[i]}` : parts[i]
        if (collapsedDirs.value.has(fileKey(g.key, p))) { hidden = true; break }
      }
      if (hidden) continue
      out.push({
        type: 'file',
        key: `f:${g.key}:${f.path}`,
        label: parts[parts.length - 1],
        depth: parts.length,
        group: g.key,
        file: f,
      })
    }
  }
  return out
})

function toggleDir(key: string) {
  const next = new Set(collapsedDirs.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedDirs.value = next
}

function toggleSelect(key: string) {
  const next = new Set(selected.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selected.value = next
}

/** 勾选集合里仍然存在的条目（刷新 status 后可能有文件已消失） */
const selectedFiles = computed(() => {
  const result: { path: string; group: GroupKey }[] = []
  for (const key of selected.value) {
    const idx = key.indexOf(':')
    const group = key.slice(0, idx) as GroupKey
    const path = key.slice(idx + 1)
    result.push({ path, group })
  }
  return result
})

function clearSelection() { selected.value = new Set() }

// 仓库/会话切换后清空勾选，避免把 A 仓库的选中项作用到 B 仓库
watch(() => git.workDir, clearSelection)
watch(() => git.status, () => {
  const alive = new Set<string>()
  for (const g of groups.value) for (const f of g.items) alive.add(fileKey(g.key, f.path))
  const next = new Set([...selected.value].filter((k) => alive.has(k)))
  if (next.size !== selected.value.size) selected.value = next
})

// ---------- 操作 ----------
function openDiff(f: GitFileChange, group: GroupKey) {
  const staged = group === 'staged'
  files.openDiff(f.path, 'HEAD', staged ? ':0' : 'WORKTREE', staged ? '暂存区' : '工作区')
}

async function onDiscardOne(path: string) {
  if (!window.confirm(`确定丢弃 ${path} 的改动？此操作不可撤销。`)) return
  await git.discard([path])
}

async function stageSelected() {
  const staged = selectedFiles.value.filter((s) => s.group !== 'staged').map((s) => s.path)
  const unstaged = selectedFiles.value.filter((s) => s.group === 'staged').map((s) => s.path)
  if (staged.length) await git.stage(staged)
  if (unstaged.length) await git.unstage(unstaged)
  clearSelection()
}

async function discardSelected() {
  const paths = selectedFiles.value.map((s) => s.path)
  if (paths.length === 0) return
  if (!window.confirm(`确定丢弃以下 ${paths.length} 个文件的改动？此操作不可撤销：\n${paths.join('\n')}`)) return
  await git.discard(paths)
  clearSelection()
}

async function onCommit(andPush = false) {
  const msg = message.value.trim()
  if (committing.value || !msg || (!git.hasStaged && !amend.value)) return
  committing.value = true
  try {
    const ok = await git.commit(msg, amend.value)
    if (!ok) return
    message.value = ''
    amend.value = false
    if (andPush) await git.runRemoteOp('push')
  } finally {
    committing.value = false
  }
}

// ---------- 分支下拉 ----------
const branchOpen = ref(false)
const newBranch = ref('')
const ddPos = ref({ top: '0px', left: '0px' })
function openBranchMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  ddPos.value = { top: `${r.bottom + 4}px`, left: `${r.left}px` }
  branchOpen.value = true
}
async function onCheckout(name: string) {
  branchOpen.value = false
  await git.checkoutBranch(name)
}
async function onCreateBranch() {
  const name = newBranch.value.trim()
  if (!name) return
  newBranch.value = ''
  branchOpen.value = false
  await git.createBranch(name)
}

// ---------- worktree ----------
const wtOpen = ref(false)
const wtPos = ref({ top: '0px', left: '0px' })
const wtPath = ref('')
const wtBranch = ref('')
const wtCreateBranch = ref(false)

/** 默认建议放在仓库同级目录，避免用户不小心填进仓库内部（主进程也会拦） */
function suggestWorktreePath(): string {
  const wd = git.workDir.replace(/\\/g, '/').replace(/\/$/, '')
  const cut = wd.lastIndexOf('/')
  if (cut < 0) return ''
  return `${wd.slice(0, cut)}/${wd.slice(cut + 1)}-wt-${Date.now().toString(36).slice(-4)}`
}

function openWorktreeMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  wtPos.value = { top: `${r.bottom + 4}px`, left: `${Math.min(r.left, window.innerWidth - 300)}px` }
  if (!wtPath.value) wtPath.value = suggestWorktreePath()
  branchOpen.value = false
  wtOpen.value = true
}

async function onAddWorktree() {
  const target = wtPath.value.trim()
  if (!target) return
  const ok = await git.addWorktree({
    path: target,
    branch: wtBranch.value.trim() || undefined,
    createBranch: wtCreateBranch.value,
  })
  if (!ok) return
  wtPath.value = suggestWorktreePath()
  wtBranch.value = ''
  wtCreateBranch.value = false
  pushToast({ level: 'info', source: 'git', message: `已新建工作树：${target}` })
}

async function onRemoveWorktree(target: string) {
  if (!window.confirm(`确定移除工作树 ${target}？\n未提交的改动会阻止移除，需先自行处理。`)) return
  await git.removeWorktree(target)
}

async function onPruneWorktrees() {
  await git.pruneWorktrees()
}

function copyWorktreePath(target: string) {
  void ClipboardWrite(target).then(() =>
    pushToast({ level: 'info', source: 'git', message: '工作树路径已复制，可用于新建会话' }),
  )
}
</script>

<template>
  <aside class="git-changes-pane" :style="{ width: width + 'px' }">
    <!-- 顶栏：常规操作一眼可见（带文字 + busy 反馈） -->
    <div class="pane-toolbar">
      <button class="branch-btn" :title="git.status?.tracking ?? '切换分支'" @click="openBranchMenu">
        <Icon name="git-branch" :size="13" />
        <span class="branch-name">{{ git.status?.branch ?? '—' }}</span>
        <Icon name="chevron-down" :size="11" />
      </button>
      <span v-if="(git.status?.ahead ?? 0) > 0" class="ahead">↑{{ git.status?.ahead }}</span>
      <span v-if="(git.status?.behind ?? 0) > 0" class="behind">↓{{ git.status?.behind }}</span>
      <button class="wt-btn" title="Worktree 管理" @click="openWorktreeMenu">
        <Icon name="layers" :size="12" /> Worktree
        <span v-if="git.worktrees.length > 1" class="wt-count">{{ git.worktrees.length }}</span>
      </button>
      <span class="toolbar-spacer" />
      <button class="tool-btn icon" title="刷新" aria-label="刷新" :disabled="!!git.busyOp" @click="git.refreshAll()">
        <Icon name="refresh-cw" :size="13" />
      </button>
    </div>
    <div class="remote-bar">
      <button class="op-btn" :disabled="!!git.busyOp" title="从远端拉取" @click="git.runRemoteOp('pull')">
        <Icon name="arrow-down" :size="13" /> Pull
      </button>
      <button class="op-btn" :disabled="!!git.busyOp" title="推送到远端" @click="git.runRemoteOp('push')">
        <Icon name="arrow-up" :size="13" /> Push
      </button>
      <button class="op-btn" :disabled="!!git.busyOp" title="仅获取远端更新" @click="git.runRemoteOp('fetch')">
        Fetch
      </button>
      <span v-if="git.busyOp" class="busy-hint">{{ git.busyOp }}…</span>
      <span class="toolbar-spacer" />
      <!-- 提交历史已并入 Git 工作区：切换右侧内容区，底部面板不再放第二份 -->
      <button
        class="op-btn history-btn"
        :class="{ active: files.gitHistoryOpen }"
        :title="files.gitHistoryOpen ? '返回编辑器 / diff' : '在右侧查看提交历史'"
        :aria-label="files.gitHistoryOpen ? '返回编辑器' : '提交历史'"
        :aria-pressed="files.gitHistoryOpen"
        @click="files.setGitHistoryOpen(!files.gitHistoryOpen)"
      >
        <Icon name="history" :size="13" /> 历史
      </button>
    </div>

    <!-- 批量操作条：勾选后出现 -->
    <div class="batch-bar">
      <span class="batch-count">已选 {{ selected.size }}</span>
      <button class="mini-btn" :disabled="selected.size === 0 || !!git.busyOp" title="暂存/取消暂存选中项" @click="stageSelected">
        暂存
      </button>
      <button class="mini-btn danger" :disabled="selected.size === 0 || !!git.busyOp" title="丢弃选中项的改动" @click="discardSelected">
        丢弃
      </button>
      <button class="mini-btn" :disabled="selected.size === 0" @click="clearSelection">清除</button>
    </div>

    <!-- 变更清单 -->
    <div class="change-list">
      <div v-if="git.loading && !git.status" class="empty">加载中…</div>
      <div v-else-if="git.error" class="empty error" :title="git.error">{{ git.error }}</div>
      <div v-else-if="!git.status?.isRepo" class="empty">当前目录不是 Git 仓库</div>
      <div v-else-if="git.totalChanges === 0" class="empty">工作区干净，没有待提交的变更</div>
      <template v-else>
        <template v-for="row in rows" :key="row.key">
          <div v-if="row.type === 'group'" class="group-title">
            {{ row.label }} ({{ row.count }})
          </div>
          <div
            v-else-if="row.type === 'dir'"
            class="row dir-row"
            :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
            @click="toggleDir(row.dirKey!)"
          >
            <Icon :name="collapsedDirs.has(row.dirKey!) ? 'chevron-right' : 'chevron-down'" :size="12" />
            <Icon name="folder-tree" :size="12" />
            <span class="path">{{ row.label }}</span>
          </div>
          <div
            v-else
            class="row file-row"
            :class="{ selected: selected.has(fileKey(row.group!, row.file!.path)) }"
            :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
            :title="row.file!.path"
            @click="openDiff(row.file!, row.group!)"
          >
            <input
              type="checkbox"
              class="row-check"
              :checked="selected.has(fileKey(row.group!, row.file!.path))"
              :aria-label="`选择 ${row.file!.path}`"
              @click.stop
              @change="toggleSelect(fileKey(row.group!, row.file!.path))"
            />
            <span class="st" :class="'st-' + row.group">{{ statusLabel[row.file!.status] }}</span>
            <span class="path">{{ row.label }}</span>
            <span class="row-actions">
              <button
                v-if="row.group === 'staged'"
                class="mini"
                title="取消暂存"
                @click.stop="git.unstage([row.file!.path])"
              >
                <Icon name="minus" :size="12" />
              </button>
              <button v-else class="mini" title="暂存" @click.stop="git.stage([row.file!.path])">
                <Icon name="plus" :size="12" />
              </button>
              <button
                class="mini danger"
                title="丢弃改动"
                @click.stop="onDiscardOne(row.file!.path)"
              >
                <Icon name="undo-2" :size="12" />
              </button>
            </span>
          </div>
        </template>
      </template>
    </div>

    <!-- 提交区 -->
    <div class="commit-box">
      <label class="amend-label" title="修改最近一次提交">
        <input v-model="amend" type="checkbox" /> amend
      </label>
      <textarea
        v-model="message"
        class="msg"
        rows="2"
        :maxlength="MESSAGE_MAX"
        placeholder="提交说明（Ctrl+Enter 提交）"
        @keydown.ctrl.enter.prevent="onCommit(false)"
      />
      <div class="commit-actions">
        <button
          class="commit-btn primary"
          :disabled="(!git.hasStaged && !amend) || !message.trim() || committing || !!git.busyOp"
          @click="onCommit(false)"
        >
          <Icon name="check" :size="13" /> 提交
        </button>
        <button
          class="commit-btn"
          :disabled="(!git.hasStaged && !amend) || !message.trim() || committing || !!git.busyOp"
          title="提交后推送到远端"
          @click="onCommit(true)"
        >
          提交并推送
        </button>
      </div>
    </div>

    <div class="pane-resize-handle" title="拖拽调整宽度" @mousedown.prevent="onResizeStart" />

    <!-- Worktree 下拉 -->
    <Teleport to="body">
      <template v-if="wtOpen">
        <div class="dd-backdrop" @click="wtOpen = false" />
        <div class="wt-dd" :style="wtPos">
          <div class="dd-title">Git Worktree（{{ git.worktrees.length }}）</div>
          <div class="wt-list">
            <div v-for="w in git.worktrees" :key="w.path" class="wt-item" :class="{ current: w.current }">
              <Icon name="layers" :size="12" />
              <div class="wt-info">
                <span class="wt-path" :title="w.path">{{ w.path }}</span>
                <span class="wt-meta">
                  {{ w.branch ?? (w.detached ? 'detached' : '—') }}
                  <template v-if="w.current"> · 当前</template>
                  <template v-if="w.locked"> · 锁定</template>
                  <template v-if="w.prunable"> · 可清理</template>
                </span>
              </div>
              <button class="wt-mini" title="复制路径（用于新建会话）" @click="copyWorktreePath(w.path)">
                <Icon name="copy" :size="11" />
              </button>
              <button
                v-if="!w.current"
                class="wt-mini danger"
                title="移除该工作树"
                @click="onRemoveWorktree(w.path)"
              >
                <Icon name="trash" :size="11" />
              </button>
            </div>
            <div v-if="git.worktrees.length === 0" class="wt-empty">没有登记的工作树</div>
          </div>
          <div class="wt-new">
            <div class="dd-title">新建工作树</div>
            <input v-model="wtPath" class="dd-input" placeholder="绝对路径（仓库同级）" />
            <div class="wt-new-row">
              <input v-model="wtBranch" class="dd-input" placeholder="分支名（可选）" />
              <label class="amend-label"><input v-model="wtCreateBranch" type="checkbox" /> 新建</label>
            </div>
            <div class="wt-actions">
              <button class="mini-btn" :disabled="!wtPath.trim() || !!git.busyOp" @click="onAddWorktree">新建</button>
              <button class="mini-btn" :disabled="!!git.busyOp" title="清理失效的工作树元数据" @click="onPruneWorktrees">清理</button>
              <button class="mini-btn" @click="wtOpen = false">关闭</button>
            </div>
          </div>
        </div>
      </template>
    </Teleport>

    <!-- 分支下拉 -->
    <Teleport to="body">
      <template v-if="branchOpen">
        <div class="dd-backdrop" @click="branchOpen = false" />
        <div class="branch-dd" :style="ddPos">
          <div class="dd-title">切换分支</div>
          <div class="dd-list">
            <button
              v-for="b in git.branches"
              :key="b.name"
              class="dd-item"
              :class="{ current: b.current }"
              @click="onCheckout(b.name)"
            >
              <span class="dd-mark">{{ b.current ? '●' : '' }}</span>
              <span class="dd-name">{{ b.name }}</span>
            </button>
          </div>
          <div class="dd-new">
            <input v-model="newBranch" class="dd-input" placeholder="新建分支名" @keydown.enter.prevent="onCreateBranch" />
            <button class="dd-add" :disabled="!newBranch.trim()" @click="onCreateBranch">新建</button>
          </div>
        </div>
      </template>
    </Teleport>
  </aside>
</template>

<style scoped>
.git-changes-pane {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
  overflow: hidden;
}
.pane-toolbar,
.remote-bar,
.batch-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.pane-toolbar { height: 32px; min-height: 32px; }
.remote-bar { height: 30px; min-height: 30px; gap: 3px; }
.batch-bar { height: 28px; min-height: 28px; }
.toolbar-spacer { flex: 1; }
.branch-btn {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 150px; height: 22px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-primary);
  font: inherit; font-size: 11px; cursor: pointer;
}
.branch-btn:hover { background: var(--bg-hover); }
.branch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ahead { color: var(--status-ok); font-size: 11px; }
.behind { color: var(--status-warn); font-size: 11px; }
.tool-btn, .op-btn, .mini-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 3px;
  height: 22px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary);
  font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap;
}
.tool-btn:hover, .op-btn:hover, .mini-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
/* 历史视图开关的选中态：放在 hover 之后，保证同优先级下 active 生效 */
.op-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft-bg); }
.op-btn:disabled, .mini-btn:disabled, .tool-btn:disabled { opacity: .45; cursor: not-allowed; }
.tool-btn.icon { width: 22px; padding: 0; border-color: transparent; }
.busy-hint { font-size: 10px; color: var(--text-tertiary); }
.batch-count { font-size: 10px; color: var(--text-tertiary); margin-right: auto; }
.mini-btn { height: 20px; font-size: 10px; }
.mini-btn.danger { color: var(--status-error); }
.change-list { flex: 1; min-height: 0; overflow: auto; }
.empty { padding: 12px; font-size: 11px; color: var(--text-tertiary); }
.empty.error { color: var(--status-error); }
.group-title {
  padding: 5px 8px; font-size: 11px; font-weight: 600;
  color: var(--text-secondary); background: var(--bg-hover);
  border-bottom: 1px solid var(--border);
}
.row {
  display: flex; align-items: center; gap: 4px;
  min-height: 24px; padding-right: 6px;
  border-bottom: 1px solid var(--border);
  font-size: 11px; color: var(--text-primary); cursor: pointer;
}
.row:hover { background: var(--bg-hover); }
.file-row.selected { background: var(--accent-soft-bg); }
.dir-row { color: var(--text-secondary); }
.row-check { width: 12px; height: 12px; margin: 0; flex-shrink: 0; cursor: pointer; }
.path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st {
  flex-shrink: 0; width: 14px; text-align: center;
  font-family: var(--font-mono, monospace); font-size: 10px; font-weight: 600;
}
.st-conflicted { color: var(--status-error); }
.st-staged { color: var(--status-ok); }
.st-unstaged { color: var(--status-warn); }
.st-untracked { color: var(--text-tertiary); }
.row-actions { display: none; align-items: center; gap: 1px; flex-shrink: 0; }
.row:hover .row-actions { display: inline-flex; }
.mini {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0;
  border: none; border-radius: 3px; background: transparent;
  color: var(--text-secondary); cursor: pointer;
}
.mini:hover { background: var(--bg-panel); color: var(--text-primary); }
.mini.danger { color: var(--status-error); }
.commit-box {
  flex-shrink: 0; padding: 6px;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 5px;
}
.amend-label {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; color: var(--text-tertiary); cursor: pointer;
}
.msg {
  width: 100%; min-height: 38px; max-height: 110px; resize: vertical;
  padding: 5px 6px; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-input); color: var(--text-primary);
  font: inherit; font-size: 11px;
}
.msg:focus { outline: 1px solid var(--accent); }
.commit-actions { display: flex; gap: 4px; }
.commit-btn {
  flex: 1; height: 26px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-primary);
  font: inherit; font-size: 11px; cursor: pointer;
}
.commit-btn.primary { background: var(--accent); color: var(--text-inverse); border-color: transparent; }
.commit-btn:disabled { opacity: .45; cursor: not-allowed; }
.pane-resize-handle {
  position: absolute; top: 0; right: 0; bottom: 0; width: 4px;
  cursor: col-resize; z-index: 4; background: transparent;
}
.pane-resize-handle:hover { background: var(--accent); }
.dd-backdrop { position: fixed; inset: 0; z-index: 900; }
.branch-dd {
  position: fixed; z-index: 901; width: 220px; max-height: 320px;
  display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--bg-panel); box-shadow: var(--shadow-card);
}
.dd-title { padding: 7px 10px; font-size: 11px; color: var(--text-tertiary); border-bottom: 1px solid var(--border); }
.dd-list { flex: 1; min-height: 0; overflow: auto; padding: 4px; }
.dd-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 6px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-primary); font: inherit; font-size: 11px;
  text-align: left; cursor: pointer;
}
.dd-item:hover { background: var(--bg-hover); }
.dd-item.current { color: var(--accent); font-weight: 600; }
.dd-mark { width: 10px; flex-shrink: 0; }
.dd-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-new { display: flex; gap: 4px; padding: 6px; border-top: 1px solid var(--border); }
.dd-input {
  flex: 1; min-width: 0; padding: 4px 6px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-input); color: var(--text-primary); font: inherit; font-size: 11px;
}
.dd-add {
  padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-primary); font: inherit; font-size: 11px; cursor: pointer;
}
.dd-add:disabled { opacity: .45; cursor: not-allowed; }
.wt-btn {
  display: inline-flex; align-items: center; gap: 3px;
  height: 22px; padding: 0 6px; flex-shrink: 0;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary);
  font: inherit; font-size: 10px; cursor: pointer; white-space: nowrap;
}
.wt-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.wt-count {
  min-width: 14px; padding: 0 3px; border-radius: 7px;
  background: var(--accent-soft-bg); color: var(--text-primary); font-size: 9px;
}
.wt-dd {
  position: fixed; z-index: 901; width: 320px; max-height: 420px;
  display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--bg-panel); box-shadow: var(--shadow-card);
}
.wt-list { flex: 1; min-height: 0; max-height: 190px; overflow: auto; padding: 4px; }
.wt-item {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 4px; border-radius: var(--radius-sm);
  font-size: 11px; color: var(--text-primary);
}
.wt-item:hover { background: var(--bg-hover); }
.wt-item.current { color: var(--accent); }
.wt-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wt-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-meta { font-size: 10px; color: var(--text-tertiary); }
.wt-empty { padding: 10px; font-size: 11px; color: var(--text-tertiary); }
.wt-mini {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0;
  border: none; border-radius: 3px; background: transparent;
  color: var(--text-secondary); cursor: pointer;
}
.wt-mini:hover { background: var(--bg-panel); }
.wt-mini.danger { color: var(--status-error); }
.wt-new { padding: 4px 6px 6px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 5px; }
.wt-new .dd-title { padding: 2px 0; border: none; }
.wt-new .dd-input { width: 100%; box-sizing: border-box; }
.wt-new-row { display: flex; align-items: center; gap: 6px; }
.wt-new-row .dd-input { flex: 1; }
.wt-actions { display: flex; gap: 4px; }
.wt-actions .mini-btn { flex: 1; }
</style>
