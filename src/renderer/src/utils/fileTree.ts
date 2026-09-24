/** 文件树纯路径工具：主/渲染层不能互 import，这里只服务渲染层 */

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

/** + 按钮目标目录：选中目录→自身，选中文件→父目录，无选中→根 */
export function resolveCreateTarget(selected: string | null, isDir: boolean | null): string {
  if (!selected) return ''
  if (isDir === true) return selected
  return parentOf(selected)
}

/** workDir(可能带 \) + relPath(正斜杠) → 可交给 Node fs 的绝对路径 */
export function absJoin(base: string, rel: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return rel ? `${trimmed}/${rel}` : trimmed
}

export interface MenuTarget {
  kind: 'blank' | 'dir' | 'file'
  relPath: string
  name: string
  parentRel: string
}
