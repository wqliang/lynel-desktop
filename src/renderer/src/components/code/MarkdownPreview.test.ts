// Markdown 预览：渲染、净化、相对资源降级、外链跳转、大文档保护
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import MarkdownPreview from './MarkdownPreview.vue'
import { OpenExternal } from '../../composables/useElectron'

vi.mock('../../composables/useElectron', () => ({
  OpenExternal: vi.fn(() => Promise.resolve(true)),
}))

const mounted: VueWrapper[] = []

/** 等首次立即渲染（rAF / setTimeout 降级）与 v-html 落地后的 DOM 后处理 */
async function renderMd(text: string, extra: Record<string, unknown> = {}) {
  const wrapper = mount(MarkdownPreview, {
    props: { text, ...extra },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await new Promise((r) => setTimeout(r, 30))
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  vi.clearAllMocks()
})

describe('MarkdownPreview', () => {
  it('渲染标题 / 粗体 / 列表 / 代码块 / 表格', async () => {
    const w = await renderMd(
      '# 标题\n\n**加粗** 与 `code`\n\n- a\n- b\n\n```ts\nconst a = 1\n```\n\n| x | y |\n|---|---|\n| 1 | 2 |',
    )
    const html = w.find('.markdown-body').element.innerHTML
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>')
    expect(html).toContain('<code>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<pre>')
    expect(html).toContain('<table>')
  })

  it('净化脚本、事件属性与 javascript: 协议', async () => {
    const w = await renderMd(
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[点我](javascript:alert(3))',
    )
    const html = w.find('.markdown-body').element.innerHTML
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
  })

  it('GFM 任务列表保留只读复选框，注入的其它 input 被剔除', async () => {
    const w = await renderMd('- [x] 已完成\n- [ ] 待办\n\n<input type="text" value="注入">')
    const body = w.find('.markdown-body').element
    const boxes = body.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    expect(boxes[0].hasAttribute('disabled')).toBe(true)
    expect(body.querySelector('input[type="text"]')).toBeNull()
  })

  it('相对图片降级为占位符，网络图片保留并可显示', async () => {
    const w = await renderMd('![本地](./a.png)\n\n![网络](https://example.com/b.png)')
    const body = w.find('.markdown-body').element
    const placeholder = body.querySelector('.md-asset-placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.textContent).toContain('本地')
    expect(body.querySelector('img[src="https://example.com/b.png"]')).not.toBeNull()
  })

  it('相对链接标记为本地链接（净化后无 href），不触发跳转', async () => {
    const w = await renderMd('[本地文件](./other.md)')
    const a = w.find('.markdown-body a').element as HTMLAnchorElement
    expect(a.classList.contains('md-local-link')).toBe(true)
    expect(a.getAttribute('href')).toBeNull()
  })

  it('外链点击走 OpenExternal 并阻止窗口内导航', async () => {
    const w = await renderMd('[文档](https://example.com/docs)')
    const a = w.find('.markdown-body a').element as HTMLAnchorElement
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    await new Promise((r) => setTimeout(r, 0))
    expect(ev.defaultPrevented).toBe(true)
    expect(OpenExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('hash 链接不改动路由 hash', async () => {
    const w = await renderMd('## 小结\n\n[跳转](#小结)')
    const a = w.find('.markdown-body a').element as HTMLAnchorElement
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(OpenExternal).not.toHaveBeenCalled()
  })

  it('超长文档只渲染前一部分并给出提示', async () => {
    const text = Array.from({ length: 5100 }, (_, i) => `line ${i}`).join('\n')
    const w = await renderMd(text)
    expect(w.find('.md-truncate-tip').exists()).toBe(true)
    expect(w.find('.md-truncate-tip').text()).toContain('仅预览前')
  })

  it('空文本显示「预览为空」', async () => {
    const w = await renderMd('')
    expect(w.find('.md-empty').exists()).toBe(true)
  })

  it('输入节流：连续变更只保留最后一次内容', async () => {
    const wrapper = mount(MarkdownPreview, { props: { text: '# A' } })
    mounted.push(wrapper)
    await new Promise((r) => setTimeout(r, 30))
    await wrapper.setProps({ text: '# B' })
    await wrapper.setProps({ text: '# C' })
    await new Promise((r) => setTimeout(r, 220))
    await nextTick()
    const html = wrapper.find('.markdown-body').element.innerHTML
    expect(html).toContain('C')
    expect(html).not.toContain('>A<')
    expect(html).not.toContain('>B<')
  })
})
