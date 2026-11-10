<template>
  <div ref="rootEl" class="md-preview">
    <div v-if="truncated" class="md-truncate-tip">
      文档过大，仅预览前 {{ shownLines }} 行（{{ shownChars }} 字符），完整内容请在编辑模式下查看
    </div>
    <div v-if="!text" class="md-empty">预览为空</div>
    <div
      v-else
      ref="bodyEl"
      class="markdown-body"
      v-html="html"
      @click="onBodyClick"
    />
    <div v-if="error" class="md-error">渲染失败：{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
/** Markdown 预览：只做「文本 → HTML → 净化 → v-html」，不引入第二个编辑器。
 *  与 trace/Markdown.vue 的区别：① 没有 fold（不能把正常 md 文件折叠起来）；
 *  ② 有输入节流与大文档降级，适合实时跟随编辑；③ 处理相对资源与外链跳转。
 *  外部内容必须净化：用户的 .md 可能来自仓库、Agent 写入或剪贴板。 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { OpenExternal } from '../../composables/useElectron'

const props = withDefaults(defineProps<{
  text: string
  /** 当前工作目录，仅用于相对资源占位符的提示 */
  baseDir?: string
  /** 当前文件相对路径，仅用于提示 */
  relPath?: string
}>(), { baseDir: '', relPath: '' })

/** 实时预览的资源上限：超过就只渲染前一部分，避免每次按键重建上万 DOM 节点 */
const MAX_CHARS = 200_000
const MAX_LINES = 5_000
const DEBOUNCE_MS = 150

/** 只放行网络图片与 http(s)/mailto/# 链接。
 *  相对路径资源会因此被 DOMPurify 摘掉 src/href（不会发起 404 请求），
 *  再由 postProcess 换成占位符。data: 只放常见的位图格式。 */
const PURIFY_CONFIG = {
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
  // input 刻意不禁：GFM 任务列表会渲染 <input type="checkbox">，
  // 由 postProcess 只保留 checkbox 并强制 disabled，其余表单输入一律移除。
  // DOMPurify 默认白名单不含 input，需 ADD_TAGS 显式放行（否则任务列表复选框会消失）。
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'button', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'srcdoc', 'formaction', 'srcset'],
  ADD_TAGS: ['input'],
  ADD_ATTR: ['checked', 'disabled'],
}

const html = ref('')
const truncated = ref(false)
const shownLines = ref(0)
const shownChars = ref(0)
const error = ref('')
const rootEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
let frameId = 0

/** jsdom / 后台窗口下可能没有 rAF，统一走一层可降级的调度 */
function nextFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb)
  return setTimeout(cb, 0) as unknown as number
}
function cancelFrame(id: number) {
  if (!id) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

/** 超长文档截断。若截断处正好落在 ``` 围栏内，补一个闭合围栏，
 *  否则剩余内容会全被当成代码，预览看起来「只剩一个代码块」。 */
function clampText(src: string): string {
  const lines = src.split('\n')
  if (src.length <= MAX_CHARS && lines.length <= MAX_LINES) {
    truncated.value = false
    shownLines.value = 0
    shownChars.value = 0
    return src
  }
  let out = lines.slice(0, MAX_LINES).join('\n')
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS)
  const fences = (out.match(/^```/gm) ?? []).length
  if (fences % 2 === 1) out += '\n```'
  truncated.value = true
  shownLines.value = out.split('\n').length
  shownChars.value = out.length
  return out
}

function render() {
  try {
    const src = clampText(props.text ?? '')
    if (!src) { html.value = ''; error.value = ''; return }
    const raw = marked.parse(src, { gfm: true, breaks: false, async: false }) as string
    html.value = DOMPurify.sanitize(raw, PURIFY_CONFIG)
    error.value = ''
  } catch (e: any) {
    // 渲染失败不能影响编辑器：保留上一次结果，只提示错误
    error.value = e?.message ?? String(e)
  }
}

function schedule(immediate = false) {
  if (timer) { clearTimeout(timer); timer = null }
  cancelFrame(frameId)
  frameId = 0
  const run = () => { frameId = nextFrame(() => { frameId = 0; render() }) }
  if (immediate) { run(); return }
  timer = setTimeout(() => { timer = null; run() }, DEBOUNCE_MS)
}

/** v-html 落地后的轻量后处理：相对资源占位 + 标题锚点 + 本地链接标记。
 *  只遍历本次生成的节点，节流 150ms 后最多执行一次。 */
function postProcess() {
  const root = bodyEl.value
  if (!root) return
  root.querySelectorAll('img').forEach((img) => {
    if (img.getAttribute('src')) return
    const alt = img.getAttribute('alt') || '本地图片'
    const span = document.createElement('span')
    span.className = 'md-asset-placeholder'
    span.textContent = `图片：${alt}`
    span.title = props.baseDir
      ? `相对路径图片暂不预览（${props.baseDir} / ${props.relPath}）`
      : '相对路径图片暂不预览'
    img.replaceWith(span)
  })
  root.querySelectorAll('a').forEach((a) => {
    if (!a.getAttribute('href')) a.classList.add('md-local-link')
  })
  // DOMPurify 会剥掉 input 的 type 属性（安全策略，ADD_ATTR 也拦不住），
  // 而 marked 的 GFM 任务列表一定带 disabled —— 据此识别并补回 type=checkbox；
  // md 里手写的其它 input（无 disabled）一律剔除，避免出现可输入的表单控件。
  root.querySelectorAll('input').forEach((el) => {
    if (el.hasAttribute('disabled')) el.setAttribute('type', 'checkbox')
    else el.remove()
  })
  // marked 默认不给标题加 id，这里补一个 slug，让文档内的 [xxx](#xxx) 可跳转
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    if (h.id) return
    const slug = (h.textContent || '').trim().toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s-]/g, '').replace(/\s+/g, '-')
    if (slug) h.id = slug
  })
}

/** 预览里的链接一律拦截：hash 路由下 `#锚点` 会改路由，
 *  外部链接也不能在 Electron 窗口内直接导航。 */
async function onBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const a = target?.closest?.('a') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (/^(?:https?:|mailto:)/i.test(href)) {
    try { await OpenExternal(href) } catch { /* 打开失败静默，不影响预览 */ }
    return
  }
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1))
    const el = id ? document.getElementById(id) : null
    // jsdom / 某些嵌入式 webview 不实现 scrollIntoView，缺能力时静默跳过
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' })
  }
}

watch(() => props.text, () => schedule(false))
watch(html, () => { void nextTick(postProcess) })

onMounted(() => schedule(true))
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  cancelFrame(frameId)
  timer = null
  frameId = 0
})
</script>

<style scoped>
.md-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  background: var(--bg-panel);
}
.markdown-body {
  padding: 12px 16px 32px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-primary);
  word-break: break-word;
}
.md-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-tertiary);
}
.md-truncate-tip {
  flex-shrink: 0;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--status-warn);
  background: var(--status-warn-soft);
  border-bottom: 1px solid var(--status-warn-border);
}
.md-error {
  flex-shrink: 0;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--status-error);
  background: var(--status-error-soft);
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 14px 0 8px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text-primary);
}
.markdown-body :deep(h1) { font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.markdown-body :deep(h2) { font-size: 17px; border-bottom: 1px solid var(--border); padding-bottom: 5px; }
.markdown-body :deep(h3) { font-size: 15px; }
.markdown-body :deep(h4) { font-size: 14px; }
.markdown-body :deep(h5), .markdown-body :deep(h6) { font-size: 13px; }
.markdown-body :deep(p) { margin: 8px 0; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { margin: 8px 0; padding-left: 22px; }
.markdown-body :deep(li) { margin: 3px 0; }
.markdown-body :deep(li > input[type='checkbox']) { margin-right: 6px; }
.markdown-body :deep(strong) { font-weight: 600; }
.markdown-body :deep(em) { font-style: italic; }
.markdown-body :deep(del) { color: var(--text-tertiary); }
.markdown-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-primary);
}
.markdown-body :deep(pre) {
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-input);
  border: 1px solid var(--border);
  overflow-x: auto;
}
.markdown-body :deep(pre code) {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12px;
  line-height: 1.55;
}
.markdown-body :deep(blockquote) {
  margin: 10px 0;
  padding: 4px 14px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}
.markdown-body :deep(blockquote p) { margin: 4px 0; }
.markdown-body :deep(a) {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.markdown-body :deep(a:hover) { text-decoration: underline; }
.markdown-body :deep(a.md-local-link) {
  color: var(--text-tertiary);
  cursor: default;
  text-decoration: none;
  border-bottom: 1px dashed var(--border);
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  max-width: 100%;
  display: block;
  overflow-x: auto;
}
.markdown-body :deep(th), .markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 9px;
  text-align: left;
}
.markdown-body :deep(th) { background: var(--bg-hover); font-weight: 600; }
.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
}
.markdown-body :deep(.md-asset-placeholder) {
  display: inline-block;
  padding: 2px 8px;
  border: 1px dashed var(--status-warn-border);
  border-radius: var(--radius-sm);
  background: var(--status-warn-soft);
  color: var(--status-warn);
  font-size: 12px;
}
.markdown-body :deep(kbd) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-input);
}
</style>
