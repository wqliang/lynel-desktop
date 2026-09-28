import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, afterEach } from 'vitest'
import TreeContextMenu from './TreeContextMenu.vue'
import type { MenuTarget } from '../../utils/fileTree'

// Icon stub 渲染成 <i> 而非 <span>：labels() 用 `.menu-item span` 取文案，
// stub 若也是 span 会混进空字符串导致 toEqual 失败
vi.mock('../Icon.vue', () => ({ default: { name: 'IconStub', props: ['name', 'size'], template: '<i />' } }))

const blank: MenuTarget = { kind: 'blank', relPath: '', name: '', parentRel: '' }
const dir: MenuTarget = { kind: 'dir', relPath: 'src', name: 'src', parentRel: '' }
const file: MenuTarget = { kind: 'file', relPath: 'src/a.ts', name: 'a.ts', parentRel: 'src' }

function labels(w: ReturnType<typeof mount>): string[] {
  return w.findAll('.menu-item span').map((x) => x.text())
}

describe('TreeContextMenu', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('blank 上下文：新建两项 + 折叠/刷新，无复制粘贴', () => {
    const w = mount(TreeContextMenu, { props: { target: blank, x: 0, y: 0 } })
    expect(labels(w)).toEqual(['新建文件', '新建文件夹', '全部折叠', '刷新'])
  })

  it('dir 上下文：含新建/路径/剪贴板/管理项', () => {
    const w = mount(TreeContextMenu, { props: { target: dir, x: 0, y: 0 } })
    const l = labels(w)
    expect(l).toContain('新建文件夹')
    expect(l).toContain('复制相对路径')
    expect(l).toContain('剪切')
    expect(l).toContain('在资源管理器中显示')
  })

  it('粘贴项始终渲染（剪贴板为空也不隐藏，外部粘贴靠它进入口），位置固定在剪切之后', () => {
    // 无 showPaste prop —— 组件不再根据剪贴板状态条件渲染
    for (const target of [dir, file]) {
      const w = mount(TreeContextMenu, { props: { target, x: 0, y: 0 } })
      const l = labels(w)
      expect(l).toContain('粘贴')
      expect(l.indexOf('粘贴')).toBeGreaterThan(l.indexOf('剪切'))
      expect(l.indexOf('粘贴')).toBeLessThan(l.indexOf('重命名'))
    }
  })

  it('file 上下文：首项是打开，无新建项', () => {
    const w = mount(TreeContextMenu, { props: { target: file, x: 0, y: 0 } })
    const l = labels(w)
    expect(l[0]).toBe('打开')
    expect(l).not.toContain('新建文件')
  })

  it('点击菜单项 emit action + target，点删除项带 danger 样式', async () => {
    const w = mount(TreeContextMenu, { props: { target: file, x: 0, y: 0 } })
    const rename = w.findAll('.menu-item').find((i) => i.text().includes('重命名'))!
    await rename.trigger('click')
    expect(w.emitted('action')?.[0]).toEqual(['rename', file])
    const del = w.findAll('.menu-item').find((i) => i.text().includes('删除'))!
    expect(del.classes()).toContain('danger')
  })

  it('视口右缘收拢：x 贴近 innerWidth 时样式不溢出', () => {
    const w = mount(TreeContextMenu, {
      props: { target: dir, x: window.innerWidth - 1, y: window.innerHeight - 1 },
    })
    const left = parseInt(w.find('.ctx-menu').attributes('style')!.match(/left:\s*(-?\d+)px/)![1], 10)
    expect(left).toBeLessThanOrEqual(window.innerWidth - 240)
  })
})
