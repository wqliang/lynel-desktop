// 右栏单宿主不变量（源码级，脆是设计的一部分）。
//
// Monaco 对同一 model URI 只允许一个 model，第二个 FileEditorPanel 实例会直接抛
// `Cannot add model because it already exists!`。改造后宿主唯一：HomeView 挂
// RightWorkspacePane（内部 → CodeView → FileEditorPanel），旧的 hostInSplit 双宿主
// 闸门与 EditorSplitPane 已删除。这里做源码级文本匹配：类型检查与组件测试
// （各自挂载、看不见全局）都发现不了「又加了第二个挂载点」，这几行能。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(p, 'utf8')
const homeSrc = read(join(here, 'HomeView.vue'))
// 刻意不用 new URL(...)：Vite 会把字面量模式当资源 URL 改写（见同文件旧版注释）
const rendererSrc = resolve(here, '..')
const codeViewSrc = read(join(rendererSrc, 'components', 'code', 'CodeView.vue'))
const fedSrc = read(join(rendererSrc, 'components', 'code', 'FileEditorPanel.vue'))

describe('右栏单宿主不变量', () => {
  it('HomeView 挂唯一右栏，旧分屏闸门已删净', () => {
    expect(homeSrc.includes('RightWorkspacePane'), 'HomeView 必须挂 RightWorkspacePane').toBe(true)
    expect(homeSrc.includes('hostInSplit'), 'hostInSplit 双宿主闸门必须已删除').toBe(false)
    expect(homeSrc.includes('EditorSplitPane'), '旧分屏组件必须已删除').toBe(false)
    expect(homeSrc.includes("setSubTab('code')"), '「文件」不再是子页').toBe(false)
    // 右栏收起必须是 CSS 隐藏：RightWorkspacePane 上不许出现 v-if
    const rp = homeSrc.match(/<RightWorkspacePane[^>]*>/)?.[0] ?? ''
    expect(rp.includes('v-if'), 'RightWorkspacePane 禁止 v-if（收起会卸载、丢底部终端缓冲）').toBe(false)
    // 旧的面板图标展开入口（sub-expand）已删：展开走右栏收起态的 expand-rail 图标
    expect(homeSrc.includes('sub-expand'), 'sub-expand 图标入口必须已删除').toBe(false)
  })

  it('「右栏」常驻入口：sub-tabs 行纯图标按钮，展开统一走 openFilePane', () => {
    // 右栏入口不能只在收起态出现：上次停在 Git 视图/提交历史时，重启后右栏
    // 自动展开成变更清单，用户会以为「打开文件面板的按钮不见了」。
    const start = homeSrc.indexOf('class="sub-tab right-pane-entry"')
    const entry = start >= 0 ? homeSrc.slice(start, homeSrc.indexOf('</button>', start)) : ''
    expect(entry, 'sub-tabs 行必须有常驻「右栏」入口').not.toBe('')
    expect(entry).toContain('panel-right-open')
    expect(entry, '只显示图标，不渲染「右栏」文字').not.toContain('<span>右栏</span>')
    expect(entry, '纯图标靠 title / aria-label 说明用途').toContain('title="打开文件面板（右栏）"')
    expect(entry).toContain('aria-label="打开右栏文件面板"')
    expect(homeSrc.match(/files\.openFilePane\(\)/g)?.length, '按钮与 @expand 两处都要走 openFilePane').toBe(2)
    expect(homeSrc.includes('@expand="files.splitOpen = true"'), '旧展开逻辑不能把视图留在 Git').toBe(false)
  })

  it('FileEditorPanel 全应用只有一个挂载点，且不再内含 FileTabs', () => {
    const inCodeView = codeViewSrc.match(/<FileEditorPanel\b/g)?.length ?? 0
    expect(inCodeView, `CodeView 内 FileEditorPanel 挂载数应为 1，实际 ${inCodeView}`).toBe(1)
    expect(homeSrc.includes('<FileEditorPanel'), 'HomeView 不得直接挂 FileEditorPanel').toBe(false)
    expect(codeViewSrc.includes('editorInSplit'), 'editorInSplit 双宿主条件必须已删除').toBe(false)
    expect(fedSrc.includes('<FileTabs'), 'FileTabs 必须已上移到右栏顶部行').toBe(false)
  })
})
