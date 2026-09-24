<script lang="ts">
export interface MenuNode {
  kind: 'item' | 'sep'
  action?: string
  label?: string
  icon?: string
  danger?: boolean
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '../Icon.vue'
import type { MenuTarget } from '../../utils/fileTree'

const props = defineProps<{
  target: MenuTarget
  x: number
  y: number
  /** 内部剪贴板非空时显示「粘贴」（空则隐藏而非 disabled） */
  showPaste: boolean
}>()
const emit = defineEmits<{
  (e: 'action', action: string, target: MenuTarget): void
  (e: 'close'): void
}>()

/** 三种上下文的菜单结构（数据驱动，加菜单项只改这里） */
const nodes = computed<MenuNode[]>(() => {
  const t = props.target
  const sep: MenuNode = { kind: 'sep' }
  const tail: MenuNode[] = [
    sep,
    { kind: 'item', action: 'copy-path', label: '复制路径', icon: 'link' },
    { kind: 'item', action: 'copy-relpath', label: '复制相对路径', icon: 'link' },
    sep,
    { kind: 'item', action: 'copy', label: '复制', icon: 'copy' },
    { kind: 'item', action: 'cut', label: '剪切', icon: 'scissors' },
    ...(props.showPaste ? [{ kind: 'item', action: 'paste', label: '粘贴', icon: 'clipboard-paste' } as MenuNode] : []),
    sep,
    { kind: 'item', action: 'rename', label: '重命名', icon: 'pencil' },
    { kind: 'item', action: 'reveal', label: '在资源管理器中显示', icon: 'eye' },
    { kind: 'item', action: 'delete', label: '删除', icon: 'trash', danger: true },
  ]
  if (t.kind === 'blank') {
    return [
      { kind: 'item', action: 'new-file', label: '新建文件', icon: 'file-plus' },
      { kind: 'item', action: 'new-folder', label: '新建文件夹', icon: 'folder-plus' },
      sep,
      { kind: 'item', action: 'collapse-all', label: '全部折叠', icon: 'chevrons-down-up' },
      { kind: 'item', action: 'refresh', label: '刷新', icon: 'refresh-cw' },
    ]
  }
  if (t.kind === 'file') {
    return [
      { kind: 'item', action: 'open', label: '打开', icon: 'file-text' },
      ...tail,
    ]
  }
  return [
    { kind: 'item', action: 'new-file', label: '新建文件', icon: 'file-plus' },
    { kind: 'item', action: 'new-folder', label: '新建文件夹', icon: 'folder-plus' },
    ...tail,
  ]
})

/** 视口右/下缘收拢（菜单实际宽度按 240 估） */
const style = computed(() => ({
  left: `${Math.min(props.x, window.innerWidth - 240)}px`,
  top: `${Math.min(props.y, window.innerHeight - 260)}px`,
}))

function onItemClick(action?: string) {
  if (!action) return
  emit('action', action, props.target)
  emit('close')
}

// 点菜单外 / 别处右键 → 关闭。组件只在菜单打开时挂载（父级 v-if），
// mounted/unmounted 天然对应开关
function onDocClick(e: MouseEvent) {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) emit('close')
}
function onDocCtx() {
  emit('close')
}
const menuEl = ref<HTMLElement | null>(null)
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('contextmenu', onDocCtx)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('contextmenu', onDocCtx)
})
</script>

<template>
  <div ref="menuEl" class="ctx-menu" :style="style" @click.stop @contextmenu.prevent.stop>
    <template v-for="(n, i) in nodes" :key="i">
      <div v-if="n.kind === 'sep'" class="menu-sep" />
      <div
        v-else
        class="menu-item"
        :class="{ danger: n.danger }"
        @click="onItemClick(n.action)"
      >
        <Icon :name="n.icon!" :size="13" />
        <span>{{ n.label }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-panel);
}
.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
  cursor: pointer;
}
.menu-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.menu-item.danger { color: var(--status-error); }
.menu-item.danger:hover { background: var(--status-error-soft); }
</style>
