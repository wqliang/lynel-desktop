<script lang="ts">
import type { InjectionKey, Ref } from 'vue'

// 递归组件共享上下文类型：根实例 provide，子实例 inject，保证全局只有一行在编辑、一个菜单在展示
interface EditState {
  kind: 'create' | 'rename'
  parentRel: string // create: 父目录 relPath；rename: 旧条目的父目录 relPath
  isDir: boolean
  name: string // 输入框当前值
  oldRel?: string // rename 时的旧 relPath
}
interface MenuState {
  x: number
  y: number
  target: MenuTarget
}
interface TreeRowCtx {
  editing: Ref<EditState | null>
  menu: Ref<MenuState | null>
}

// 注入键必须声明在普通 <script> 块（模块顶层）：<script setup> 内的 const 会被编译器
// 搬进 setup 作用域，每个实例重新 Symbol() 产生不同 symbol，导致 provide/inject 链断裂、
// 递归组件无限挂载（Maximum call stack size exceeded）
const TREE_ROW_CTX: InjectionKey<TreeRowCtx> = Symbol('tree-row-ctx')
</script>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, provide, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import TreeContextMenu from './TreeContextMenu.vue'
import { parentOf, baseName, absJoin, resolveCreateTarget, type MenuTarget } from '../../utils/fileTree'
import { useFilesStore, type TreeEntry } from '../../stores/files'

// ---------- 文件类型图标（vscode-icons 提取的本地 SVG 资产） ----------
// 按扩展名映射到 assets/file-icons/ 下的图标名；未匹配回退 null（用 lucide file-text）
const ICON_ASSETS = import.meta.glob('../../assets/file-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const EXT_ICON: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  go: 'go',
  html: 'html', htm: 'html',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  css: 'css',
  scss: 'scss', sass: 'sass', less: 'less',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyi: 'python', pyw: 'python',
  rs: 'rust',
  vue: 'vue',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql',
  xml: 'xml',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  env: 'dotenv',
  svelte: 'svelte',
  astro: 'astro',
  lua: 'lua',
  sol: 'solidity',
  zig: 'zig',
  gitignore: 'git',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', ico: 'image', webp: 'image',
  pdf: 'pdf2',
  txt: 'text',
}

/** 根据文件名返回对应语言图标的资产 URL；无匹配返回空串（回退 lucide file-text） */
function fileIconUrl(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx < 0) return ''
  const ext = name.slice(idx + 1).toLowerCase()
  const icon = EXT_ICON[ext]
  if (!icon) return ''
  return ICON_ASSETS[`../../assets/file-icons/${icon}.svg`] ?? ''
}

// 递归组件自引用：模板内 <TreeRow> 需解析到本组件自身（Vue 3.5 官方机制）
defineOptions({ name: 'TreeRow' })

const store = useFilesStore()

const injectCtx = inject(TREE_ROW_CTX, null)
const editing = injectCtx ? injectCtx.editing : ref<EditState | null>(null)
const menu = injectCtx ? injectCtx.menu : ref<MenuState | null>(null)
if (!injectCtx) provide(TREE_ROW_CTX, { editing, menu })
const isRoot = !injectCtx

const props = defineProps<{ relPath: string; depth: number }>()

// ---------- 树数据 ----------
const entries = computed<TreeEntry[]>(() => store.tree[props.relPath] ?? [])

function entryRel(entry: TreeEntry): string {
  return props.relPath ? `${props.relPath}/${entry.name}` : entry.name
}

// ---------- 行交互 ----------
function onRowClick(entry: TreeEntry) {
  if (editing.value) return // 编辑态下避免误触
  const rel = entryRel(entry)
  store.select(rel)
  if (entry.isDir) store.toggleExpand(rel, true)
  else store.openFile(rel)
}

function openMenu(e: MouseEvent, entry: TreeEntry) {
  // fixed 定位浮层；视口收拢交给 TreeContextMenu
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    target: {
      kind: entry.isDir ? 'dir' : 'file',
      relPath: entryRel(entry),
      name: entry.name,
      parentRel: props.relPath,
    },
  }
}

/** 空白处右键（根容器）：目标 = 根。行上已 .stop 不会冒泡到这里 */
function openBlankMenu(e: MouseEvent) {
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    target: { kind: 'blank', relPath: '', name: '', parentRel: '' },
  }
}

function closeMenu() {
  menu.value = null
}

// ---------- 拖拽移动（HTML5 DnD；单文件拖拽，多选不做） ----------
function onDragStart(e: DragEvent, entry: TreeEntry) {
  const rel = entryRel(entry)
  store.dragRel = rel
  e.dataTransfer?.setData('text/plain', rel)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

/** 落点目录：目录行=自身，文件行=其父目录 */
function dropDirOf(entry: TreeEntry): string {
  const rel = entryRel(entry)
  return entry.isDir ? rel : parentOf(rel)
}

/** 拒绝自我拖拽与拖入自身子孙（防递归爆炸；主进程 copyEntries 仍会兜底校验） */
function isIllegalDrop(src: string, dest: string): boolean {
  return !src || dest === src || dest.startsWith(src + '/') || dest === parentOf(src)
  // dest === parentOf(src) = 同目录移动，no-op 没意义，也拒绝高亮
}

function onDragOver(e: DragEvent, entry: TreeEntry) {
  const src = store.dragRel
  if (!src) return
  const dest = dropDirOf(entry)
  if (isIllegalDrop(src, dest)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  store.dropTargetRel = dest
}

function onDrop(e: DragEvent, entry: TreeEntry) {
  e.preventDefault()
  const src = store.dragRel
  const dest = dropDirOf(entry)
  store.dragRel = null
  store.dropTargetRel = null
  if (!src || isIllegalDrop(src, dest)) return
  void store.moveEntry(src, dest)
}

function onDragEnd() {
  store.dragRel = null
  store.dropTargetRel = null
}

// ---------- 快捷键（树容器聚焦时生效；input 内不劫持） ----------
function onTreeKeydown(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
  const sel = store.selectedRelPath
  if (e.key === 'F2') {
    if (!sel) return
    e.preventDefault()
    startRenameAt({
      kind: store.entryIsDir(sel) === true ? 'dir' : 'file',
      relPath: sel,
      name: baseName(sel),
      parentRel: parentOf(sel),
    })
  } else if (e.key === 'Delete') {
    if (!sel) return
    e.preventDefault()
    void store.deleteEntry(sel)
  } else if (e.key === 'Escape') {
    if (menu.value) { closeMenu(); return }
    e.preventDefault()
    store.select(null)
  }
}

// 根容器元素：点击（含点行冒泡）时拿焦点，让容器上的 @keydown（F2/Delete/Esc）可触发
const fileTreeEl = ref<HTMLElement | null>(null)

// ---------- 行内编辑 ----------
function isEditingEntry(entry: TreeEntry): boolean {
  return editing.value?.kind === 'rename' && editing.value.oldRel === entryRel(entry)
}

/** 当前目录处于「新建」态（输入行显示在子列表末尾） */
const creatingHere = computed(() => editing.value?.kind === 'create' && editing.value.parentRel === props.relPath)

function startCreate(parentRel: string, isDir: boolean) {
  if (!store.expanded.has(parentRel)) store.toggleExpand(parentRel, true) // 展开以显示输入行
  editing.value = { kind: 'create', parentRel, isDir, name: isDir ? 'new-folder' : 'untitled.ts' }
}

/** Enter 提交：名称空或未变化则直接取消；失败提示由 store 内部负责 */
function submitEdit() {
  const e = editing.value
  if (!e) return
  const name = e.name.trim()
  editing.value = null
  if (!name) return
  if (e.kind === 'rename') {
    const oldName = e.oldRel ? e.oldRel.slice(e.oldRel.lastIndexOf('/') + 1) : ''
    if (name !== oldName) store.renameEntry(e.oldRel ?? '', name)
  } else {
    store.createEntry(e.parentRel, name, e.isDir)
  }
}

function cancelEdit() {
  editing.value = null
}

// ---------- 菜单动作分发 ----------
/** 菜单动作分发：目标目录语义 dir=自身 / file=父 / blank=根 */
function dirOf(t: MenuTarget): string {
  if (t.kind === 'dir') return t.relPath
  if (t.kind === 'file') return t.parentRel
  return ''
}

function startRenameAt(t: MenuTarget) {
  editing.value = {
    kind: 'rename',
    parentRel: t.parentRel,
    isDir: t.kind === 'dir',
    name: t.name,
    oldRel: t.relPath,
  }
}

function onMenuAction(action: string, t: MenuTarget) {
  closeMenu() // TreeContextMenu 自己也 emit close，这里兜底保证状态清干净
  switch (action) {
    case 'new-file': startCreate(dirOf(t), false); break
    case 'new-folder': startCreate(dirOf(t), true); break
    case 'open': store.openFile(t.relPath); break
    case 'copy-path': void store.copyPath(t.relPath, true); break
    case 'copy-relpath': void store.copyPath(t.relPath, false); break
    case 'copy': void store.setClipboard(t.relPath, 'copy'); break
    case 'cut': void store.setClipboard(t.relPath, 'cut'); break
    case 'paste': void store.pasteInto(dirOf(t)); break
    case 'rename': startRenameAt(t); break
    case 'reveal': void store.revealEntry(t.relPath); break
    case 'delete': void store.deleteEntry(t.relPath); break
    case 'collapse-all': store.collapseAll(); break
    case 'refresh': void store.refreshAll(); break
  }
}

// ---------- 编辑态下自动聚焦输入框 ----------
const editInput = ref<HTMLInputElement | null>(null)
// watch 负责：编辑态在已挂载的行上切换时聚焦（重命名/展开目录中新建）
watch(editing, async () => {
  await nextTick()
  const el = editInput.value
  if (el) {
    el.focus()
    el.select()
  }
})
// 折叠目录中新建时，子实例在编辑态设置后才挂载，watch 不会触发，需在挂载后补一次聚焦
onMounted(() => {
  if (creatingHere.value) editInput.value?.focus()
})

// 工具条「新建文件」按钮联动：+1 时按选中态解析目标目录弹行内输入
// （旧实现硬编码根目录；现在 选中目录→该目录 / 选中文件→父 / 无选中→根）。
// 仅 v > old 防止 setSession 清零造成误触发；editing 由所有实例共享（provide），
// 但 ghost 行只在 parentRel 匹配的实例渲染，根实例触发即可。
watch(
  () => store.createAtRequest,
  (v, old) => {
    if (v > old && isRoot) {
      const sel = store.selectedRelPath
      startCreate(resolveCreateTarget(sel, sel ? store.entryIsDir(sel) : null), false)
    }
  },
)
</script>

<template>
  <!-- 根实例：外层容器 + 空状态 + 右键浮层 -->
  <div
    v-if="isRoot"
    ref="fileTreeEl"
    class="file-tree"
    tabindex="-1"
    @contextmenu.prevent.stop="openBlankMenu($event)"
    @click="fileTreeEl?.focus()"
    @keydown="onTreeKeydown"
  >
    <div v-if="!store.workDir" class="tree-empty">无工作目录</div>
    <TreeRow
      v-else-if="(store.tree['']?.length ?? 0) > 0 || creatingHere"
      :rel-path="''"
      :depth="0"
    />
    <div v-else class="tree-empty">空</div>

    <TreeContextMenu
      v-if="menu"
      :target="menu.target"
      :x="menu.x"
      :y="menu.y"
      @action="onMenuAction"
      @close="closeMenu"
    />
  </div>

  <!-- 递归实例：渲染本目录的条目行 -->
  <div v-else class="dir-node">
    <template v-for="entry in entries" :key="entry.name">
      <div
        class="row"
        :class="{
          'is-dir': entry.isDir,
          active: !entry.isDir && store.activeRelPath === entryRel(entry),
          selected: store.selectedRelPath === entryRel(entry),
          cut: store.clipboard?.op === 'cut' && store.clipboard.paths.includes(absJoin(store.workDir, entryRel(entry))),
          'drop-target': store.dropTargetRel === entryRel(entry) && entry.isDir,
          dragging: store.dragRel === entryRel(entry),
        }"
        :style="{ paddingLeft: depth * 12 + 'px' }"
        :draggable="!(editing && isEditingEntry(entry))"
        @click="onRowClick(entry)"
        @contextmenu.prevent.stop="openMenu($event, entry)"
        @dragstart="onDragStart($event, entry)"
        @dragover="onDragOver($event, entry)"
        @drop="onDrop($event, entry)"
        @dragend="onDragEnd()"
      >
        <template v-if="editing && isEditingEntry(entry)">
          <img
            v-if="!entry.isDir && fileIconUrl(entry.name)"
            :src="fileIconUrl(entry.name)"
            class="row-icon"
            alt=""
            draggable="false"
          />
          <Icon v-else :name="entry.isDir ? 'folder-open' : 'file-text'" :size="14" :class="{ 'icon-dir': entry.isDir }" />
          <input
            ref="editInput"
            v-model="editing.name"
            class="row-input"
            spellcheck="false"
            @click.stop
            @contextmenu.stop
            @keydown.enter.prevent="submitEdit()"
            @keydown.esc.prevent="cancelEdit()"
            @blur="submitEdit()"
          />
        </template>
        <template v-else>
          <span class="chevron">
            <Icon
              :name="entry.isDir && store.expanded.has(entryRel(entry)) ? 'chevron-down' : (entry.isDir ? 'chevron-right' : '')"
              :size="13"
            />
          </span>
          <img
            v-if="!entry.isDir && fileIconUrl(entry.name)"
            :src="fileIconUrl(entry.name)"
            class="row-icon"
            alt=""
            draggable="false"
          />
          <Icon v-else :name="entry.isDir ? 'folder-open' : 'file-text'" :size="14" :class="{ 'icon-dir': entry.isDir }" />
          <span class="name" :title="entry.name">{{ entry.name }}</span>
        </template>
      </div>

      <!-- 展开的子目录递归渲染 -->
      <TreeRow
        v-if="entry.isDir && store.expanded.has(entryRel(entry))"
        :rel-path="entryRel(entry)"
        :depth="depth + 1"
      />
    </template>

    <!-- 新建条目 ghost 行 -->
    <div v-if="creatingHere && editing" class="row creating" :style="{ paddingLeft: depth * 12 + 'px' }">
      <img
        v-if="!editing.isDir && fileIconUrl(editing.name)"
        :src="fileIconUrl(editing.name)"
        class="row-icon"
        alt=""
        draggable="false"
      />
      <Icon v-else :name="editing.isDir ? 'folder-open' : 'file-text'" :size="14" :class="{ 'icon-dir': editing.isDir }" />
      <input
        ref="editInput"
        v-model="editing.name"
        class="row-input"
        spellcheck="false"
        @click.stop
        @contextmenu.stop
        @keydown.enter.prevent="submitEdit()"
        @keydown.esc.prevent="cancelEdit()"
        @blur="submitEdit()"
      />
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 4px;
  background: var(--bg-panel);
}
.tree-empty {
  padding: 16px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
}
.dir-node { min-height: 0; }
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding-right: 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.row:hover { background: var(--bg-hover); color: var(--text-primary); }
.row.active { background: var(--accent-soft-bg); color: var(--text-primary); }
.row.creating { cursor: default; }
.chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
}
.row-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  object-fit: contain;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.row-input {
  flex: 1;
  min-width: 0;
  height: 20px;
  padding: 0 6px;
  font-size: var(--fs-body-sm);
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-focus);
  border-radius: var(--radius-sm);
  outline: none;
}
.icon-dir { color: var(--term-blue); }
.row.selected {
  background: var(--bg-selected);
  box-shadow: inset 0 0 0 1px var(--accent-soft-border);
}
.row.cut { opacity: 0.5; }
.row.drop-target {
  background: var(--accent-soft-bg);
  box-shadow: inset 0 0 0 2px var(--accent);
}
.row.dragging { opacity: 0.4; }
.file-tree:focus { outline: none; }
</style>
