<!-- 运行流水：把一次 run 的事件流重放成 agent 化的时间轴视图。
     - store 增量 flatten（streamItems），本组件不再全量 flatten
     - useRunPlayback 播放队列：历史直接全显，实时事件逐条出场（正文打字机、其余 80ms 间隔滑入）
     - 积压 >5 条或点「立即显示」快进；终态先快进再通知
     - 工具调用 / 思考 / 诊断输出默认折叠（无 Edit/Write 例外）
     - 正文与终局结果永不自动折叠（NO_FOLD）；进入页面默认贴底，running 时始终跟随在底部 -->
<template>
  <div class="stream">
    <!-- 运行头：哪一次（时间 + 触发方式）+ 状态 + 指标 chips。历史里点进旧 run 时给「回到最新」。 -->
    <div class="runhead" :class="barTone">
      <span class="pill" :class="run.status">
        <Icon :name="barIcon" :size="11" />{{ barLabel }}
      </span>
      <span class="big">{{ startedText }}</span>
      <span class="dim small">{{ run.trigger === 'manual' ? '手动' : '自动' }}</span>
      <span class="sp" />
      <span class="chip">{{ toolCount }} 个工具调用{{ errorCount ? ` · ${errorCount} 个失败` : '' }}</span>
      <span v-for="c in barChips" :key="c" class="chip">{{ c }}</span>
      <button v-if="backlog > 0" class="btn" title="事件积压，立即显示全部" @click="fastForward">
        立即显示 {{ backlog }}
      </button>
      <button v-if="run.status === 'running'" class="btn" @click="$emit('cancel')">取消</button>
      <span v-else-if="!isLatest" class="link" @click="$emit('latest')">回到最新</span>
    </div>

    <div ref="bodyEl" class="sbody" :class="{ 'empty-body': shown.length === 0 }" @scroll="onScroll">
      <!-- key 里必须带 run.id：RunStreamView 换 run 时是同一个组件实例，只按 at 做 key 会让
           Vue 复用同下标的 ToolStepCard 实例，ToolStepCard 的 open 展开态（默认全折叠）
           就再也不会对新 run 的同下标元素重新求值 —— 折叠态会跨 run 串。
           at 这一段不能去掉：折叠态是按「在未过滤列表里的下标」记的稳定标识。 -->
      <template v-for="item in shown" :key="run.id + ':' + item.at">
        <!-- 时间轴壳：左连线 + 按类型着色的节点（版式 C）。分支的 v-if / v-else-if 链
             必须保持连续，所以全部分支共同包进这一个父节点，内容不改。 -->
        <div
          class="tl-item"
          :class="[
            'k-' + item.kind,
            {
              'tl-enter': fresh.has(item.at),
              'tl-last': item.at === shown.length - 1,
              'is-err': item.kind === 'result' && item.summary.isError,
            },
          ]"
        >
        <div v-if="item.kind === 'init'" class="meta-line">
          <span>Claude Code {{ item.version }}</span>
          <span class="dim">·</span>
          <span>{{ item.model }}</span>
          <span class="dim">·</span>
          <span>{{ item.toolCount }} 个工具</span>
          <span v-for="m in item.failedMcpServers" :key="m" class="warnchip">
            <Icon name="warning" :size="12" />MCP {{ m }} 连接失败
          </span>
        </div>

        <!-- hook_started / hook_response：降级成一行，不展开 -->
        <div v-else-if="item.kind === 'hook'" class="hooked">
          <Icon name="hook" :size="12" />
          {{ item.name }} · {{ item.ok ? '成功' : '失败' }}
        </div>

        <div v-else-if="item.kind === 'thinking'" class="fold-block">
          <div class="fold" @click="toggleFold(item.at)">
            <Icon :name="expanded.has(item.at) ? 'chevron-down' : 'chevron-right'" :size="12" />思考
          </div>
          <div v-if="expanded.has(item.at)" class="md-text">{{ item.text }}</div>
        </div>

        <!-- 正文永不自动折叠：任务流水就是给人读结果的，「> show N lines」把结果藏起来等于没给 -->
        <div v-else-if="item.kind === 'text'" class="text-line">
          <Markdown
            :text="item.text"
            class="md-text"
            :max-len="NO_FOLD"
            :max-lines="NO_FOLD"
          />
          <Icon v-if="typing && typing.at === item.at" name="loader" :size="12" class="spin" />
        </div>

        <!-- 子代理（parent_tool_use_id 非 null → StreamItem.subagent）缩进成一组。
             不加标题：StreamItem 只带布尔标志、没有子代理类型，任何名字都是编造的。
             非子代理的 tool 走下一分支，DOM 与改动前逐字一致。 -->
        <div v-else-if="item.kind === 'tool' && item.subagent" class="subagent">
          <ToolStepCard :item="item" />
        </div>

        <ToolStepCard v-else-if="item.kind === 'tool'" :item="item" />

        <div v-else-if="item.kind === 'stderr'" class="fold-block">
          <div v-if="item.text" class="fold" @click="toggleFold(item.at)">
            <Icon :name="expanded.has(item.at) ? 'chevron-down' : 'chevron-right'" :size="12" />诊断输出
          </div>
          <!-- 空的 stderr 是真实存在的一类事件：给一行静态文案，别给展开后什么都没有的把手 -->
          <div v-else class="fold readonly">诊断输出（空）</div>
          <div v-if="item.text && expanded.has(item.at)" class="io"><pre>{{ item.text }}</pre></div>
        </div>

        <div v-else-if="item.kind === 'result'" class="res" :class="{ err: item.summary.isError }">
          <div class="rh">
            <Icon
              :name="item.summary.isError ? 'warning' : 'check'"
              :size="14"
              :class="item.summary.isError ? 'st-error' : 'st-done'"
            />
            <span class="big" :class="item.summary.isError ? 'st-error' : 'st-done'">
              {{ item.summary.isError ? '失败' : '成功' }}
            </span>
            <span>
              {{ item.summary.numTurns }} 轮 · {{ formatDuration(item.summary.durationMs) }} ·
              ${{ item.summary.totalCostUsd.toFixed(3) }}
              <template v-if="item.summary.stopReason">· stop_reason={{ item.summary.stopReason }}</template>
            </span>
            <span v-if="usageChips(item.summary.usage)" class="chip">{{ usageChips(item.summary.usage) }}</span>
          </div>
          <!-- 正文与紧邻上方的助手正文一字不差时不重复渲染（result.result 就是最后一条
               assistant 文本），只留这行状态头 —— 那里才是这张卡独有的信息。 -->
          <div v-if="!item.textRepeatsAbove && item.summary.resultText" class="rt">
            <Markdown :text="item.summary.resultText" :max-len="NO_FOLD" :max-lines="NO_FOLD" />
          </div>
        </div>
        </div>
      </template>

      <div v-if="run.status === 'running'" class="follow-caret"><Icon name="loader" :size="12" class="spin" /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import Markdown from '../trace/Markdown.vue'
import ToolStepCard from './ToolStepCard.vue'
import { formatDuration } from '../../utils/tasks'
import { isNearBottom } from '../../utils/playback'
import { useRunPlayback } from '../../composables/useRunPlayback'
import type { RunDto, StreamItem } from '../../types/tasks'

const props = defineProps<{
  run: RunDto
  /** 已 flatten 的线性条目（store 增量产出）；原始 events 不再下传 */
  items: StreamItem[]
  /** 历史加载代数：切换时播放队列把当前内容当历史直接全量显示 */
  epoch: number
  /** 当前展示的就是最近一次运行（false 时给「回到最新」入口） */
  isLatest?: boolean
}>()
defineEmits<{ (e: 'cancel'): void; (e: 'latest'): void }>()

/** 手动展开过的下标（思考 / 诊断输出默认折叠 —— 只有展开态需要记） */
const expanded = ref<Set<number>>(new Set())
const bodyEl = ref<HTMLElement | null>(null)
let following = true

const items = computed(() => props.items)
const epoch = computed(() => props.epoch)
const pb = useRunPlayback(items, epoch)
const { visibleCount, typing, backlog, fastForward, fresh } = pb

/** 传给 Markdown 的「永不折叠」阈值（它默认 >800 字符 / >18 行就折成 details） */
const NO_FOLD = Number.MAX_SAFE_INTEGER

/** 实际渲染的条目：slice 到 visibleCount；打字机进行中的 text 只取前 chars 个字符。
 *  折叠态仍按下标记（at）—— 下标随事件追加只增不改，是稳定标识。 */
const shown = computed<(StreamItem & { at: number })[]>(() => {
  const list = items.value.slice(0, visibleCount.value)
  const t = typing.value
  if (t !== null && t.at < list.length) {
    const it = list[t.at]
    if (it.kind === 'text') list[t.at] = { ...it, text: it.text.slice(0, t.chars) }
  }
  return list.map((it, at) => ({ ...it, at }))
})

const toolCount = computed(() => items.value.filter((i) => i.kind === 'tool').length)
const errorCount = computed(
  () => items.value.filter((i) => i.kind === 'tool' && i.status === 'error').length,
)

const isBad = computed(() => ['error', 'timeout', 'interrupted'].includes(props.run.status))
const LABELS: Record<string, string> = {
  queued: '排队中', running: '运行中', done: '成功', error: '失败',
  timeout: '超时', skipped: '已跳过', interrupted: '已中断',
}
const ICONS: Record<string, string> = {
  queued: 'clock', running: 'loader', done: 'check', error: 'warning',
  timeout: 'clock', skipped: 'slash', interrupted: 'slash',
}
const barLabel = computed(() => LABELS[props.run.status] ?? props.run.status)
const barIcon = computed(() => ICONS[props.run.status] ?? 'clock')
/** 状态栏底色：done 绿 / 失败红 / running 蓝（accent）/ 排队·跳过 中性。
 *  设计稿只画了成功与运行中两种；queued / skipped 沿用成功绿会读成「跑成功了」，故单独降为中性底。 */
const barTone = computed(() => {
  if (props.run.status === 'running') return 'live'
  if (isBad.value) return 'err'
  return props.run.status === 'done' ? 'done' : 'idle'
})

const startedText = computed(() => {
  const ms = props.run.startedAt ?? props.run.queuedAt
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

/* running 时显示的是「实时秒数」：computed 不会因为时间流逝自己重算，得有个秒级心跳。 */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

function syncTicker() {
  if (props.run.status === 'running' && ticker === null) {
    ticker = setInterval(() => { now.value = Date.now() }, 1000)
  } else if (props.run.status !== 'running' && ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}

/** 指标 chips：轮次 / 耗时 / 费用 / 失败原因 / 会话重建提示。
 *  resume_used 三态：1=走了 --resume，0=resume 目标缺失后回退重建，null=首次运行。
 *  只有 0 才是「重建」，首跑不显示（写 0 会误报）。 */
const barChips = computed(() => {
  const bits: string[] = []
  if (props.run.status === 'running' && props.run.startedAt != null) {
    bits.push(`已 ${formatDuration(now.value - props.run.startedAt)}`)
  } else if (props.run.durationMs != null) {
    bits.push(formatDuration(props.run.durationMs))
  }
  if (props.run.numTurns != null) bits.push(`${props.run.numTurns} 轮`)
  if (props.run.totalCostUsd != null) bits.push(`$${props.run.totalCostUsd.toFixed(3)}`)
  if (props.run.resultSubtype && props.run.status === 'error') bits.push(props.run.resultSubtype)
  if (props.run.resumeUsed === 0) bits.push('会话已重建')
  return bits
})

function toggleFold(at: number) {
  const next = new Set(expanded.value)
  if (next.has(at)) next.delete(at)
  else next.add(at)
  expanded.value = next
}

function usageChips(usage: Record<string, number>): string {
  const LABELS: Record<string, string> = {
    input_tokens: 'in', output_tokens: 'out',
    cache_read_input_tokens: 'cache_read', cache_creation_input_tokens: 'cache_write',
  }
  return Object.entries(usage)
    .map(([k, v]) => `${LABELS[k] ?? k} ${v.toLocaleString()}`)
    .join(' · ')
}

async function scrollToBottom() {
  await nextTick()
  const el = bodyEl.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

function onScroll() {
  const el = bodyEl.value
  if (!el) return
  following = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight)
}

/** 换 run 要重置视图态：展开态的下标是随 run 变的，跟着跨 run 会串到别的块上。 */
watch(
  () => props.run.id,
  () => {
    expanded.value = new Set()
    now.value = Date.now()
    // 进入页面默认贴底看最新（历史 run 也一样，用户拍板），上滚后由 onScroll 接管
    following = true
    void scrollToBottom()
  },
  { immediate: true },
)

watch(() => props.run.status, syncTicker, { immediate: true })

/** 终态：先把播放队列快进到最新，再走 toast / 托盘通知（spec §6 通知前先快进） */
watch(
  () => props.run.status,
  (s) => {
    if (s !== 'running' && s !== 'queued') fastForward()
  },
  { immediate: true },
)

/** 出新条目 / 打字机推进：running 时始终拉回底部（用户拍板「执行中始终在最下面」，
   上滚也强制跟随）；非 running（历史回放、终态）仍贴底才跟随，由 onScroll 维护。 */
watch(
  [visibleCount, () => typing.value?.chars],
  () => {
    if (!following && props.run.status !== 'running') return
    void scrollToBottom()
  },
)

onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker)
})
</script>

<style scoped>
/* height:100%（不是 min-height）：内容再长也封在本组件内，滚动条归 .sbody；
   放回 .dbody 的话 scrollTo / onScroll 全部空转（见 .sbody 注释）。空态同样撑满居中（spec §4）。 */
.stream {
  display: flex; flex-direction: column; background: var(--bg-primary);
  height: 100%;
}
.runhead {
  flex: none;
  padding: 11px 20px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: var(--fs-caption); border-bottom: 1px solid var(--border);
}
.runhead.done { background: var(--status-success-soft); }
.runhead.err { background: var(--status-error-soft); }
.runhead.live { background: var(--accent-soft-bg); }
.runhead.idle { background: var(--bg-panel); }
.runhead .big { font-weight: 600; font-size: var(--fs-body); color: var(--text-primary); }
.runhead .sp { flex: 1; }
.runhead .link { color: var(--accent); cursor: pointer; }
.runhead .link:hover { text-decoration: underline; }
.dim { color: var(--text-tertiary); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* 事件体：自身带滚动条，底部自动跟随才有落点（外层 .dbody 也是滚动容器，
   不封住高度的话滚动条归外层，scrollTop 赋值无效、onScroll 也永远不触发）。 */
.sbody { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 26px; }
.sbody.empty-body { flex: 1; display: flex; align-items: center; justify-content: center; }

.meta-line {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: var(--fs-caption); color: var(--text-tertiary); margin-bottom: 5px;
}
.meta-line .warnchip { color: var(--status-warn); display: inline-flex; align-items: center; gap: 4px; }
.hooked {
  font-size: var(--fs-caption); color: var(--text-tertiary);
  display: flex; align-items: center; gap: 6px; margin-bottom: 16px; opacity: .8;
}

.fold-block { display: block; }
.fold {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: var(--fs-caption); color: var(--text-secondary);
  padding: 4px 0; margin: 2px 0;
}
.fold:hover { color: var(--text-primary); }
.fold.readonly { cursor: default; }
.fold.readonly:hover { color: var(--text-secondary); }
.md-text { font-size: var(--fs-body-sm); margin: 10px 0 14px; }
/* 打字机进行中的正文：块级容器 + 行尾光标 */
.text-line { position: relative; }

.io {
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 8px 10px;
}
.io pre {
  margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  color: var(--text-primary);
}

/* 子代理（parent_tool_use_id 非 null）缩进：左侧留白 + 虚竖线，照设计稿第 3 节的 .subagent */
.subagent {
  margin-left: 20px; border-left: 2px dashed var(--border-strong);
  padding-left: 12px; margin-top: 10px; margin-bottom: 10px;
}

.res {
  border: 1px solid var(--status-success); border-radius: var(--radius-md);
  background: var(--status-success-soft); padding: 12px 14px; margin-top: 18px;
}
.res.err { border-color: var(--status-error); background: var(--status-error-soft); }
.res .rh {
  display: flex; align-items: center; gap: 10px; font-size: var(--fs-caption);
  color: var(--text-secondary); margin-bottom: 8px; flex-wrap: wrap;
}
.res .rh .big { font-weight: 600; font-size: var(--fs-body-sm); }
.res .rt { font-size: var(--fs-body-sm); color: var(--text-primary); }
/* Markdown 自带 8px 12px 内边距，嵌在卡片（已有 12px 14px）里会叠成双重缩进 */
.res .rt :deep(.markdown-body) { padding: 0; }
.chip {
  font-size: 10px; padding: 2px 7px; border-radius: var(--radius-pill);
  background: var(--bg-hover); color: var(--text-secondary);
}

.follow-caret { padding: 2px 0; }
/* 打字机 / 跟随尾部用转圈菊花（Loader2），不用闪烁光标——与 Claude 的思考指示一致 */
.spin {
  vertical-align: -2px; margin-left: 2px;
  color: var(--accent);
  animation: task-spin 0.8s linear infinite;
}
@keyframes task-spin { to { transform: rotate(360deg); } }

.st-done { color: var(--status-success); }
.st-error, .st-timeout { color: var(--status-error); }
.st-running { color: var(--accent); }
.st-queued, .st-skipped, .st-interrupted { color: var(--text-tertiary); }

/* —— 时间轴（版式 C）：左连线 + 按类型着色的节点 —— */
.tl-item {
  position: relative;
  padding-left: 22px;
  padding-bottom: 14px;
  border-left: 1px solid var(--border);
  margin-left: 4px;
}
.tl-item::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 3px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--node, var(--text-tertiary));
  box-shadow: 0 0 0 3px var(--bg-primary);
}
/* 最后一项不留悬空连接线 */
.tl-item.tl-last { border-left-color: transparent; }

.k-init, .k-hook { --node: var(--text-tertiary); }
.k-thinking { --node: var(--status-thinking); }
.k-text { --node: var(--accent); }
.k-tool { --node: var(--status-warn); }
.k-stderr { --node: var(--status-error); }
.k-result { --node: var(--status-success); }
.k-result.is-err { --node: var(--status-error); }

/* 节奏收紧：条目间距由 tl-item 的 padding-bottom 承担，内部不再叠加旧外边距 */
.tl-item .md-text { margin: 2px 0 0; }
.tl-item .res { margin-top: 8px; }
.tl-item .hooked { margin-bottom: 0; }

/* —— 动效（spec §5）：全部走 CSS，reduced-motion 下照 spinner 先例豁免 —— */

/* 新事件行滑入：下方位移 10px + 淡入 */
@keyframes task-slide {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}
.tl-item.tl-enter { animation: task-slide .35s ease both; }

/* 运行中状态呼吸点：runhead 的 running pill 做 box-shadow 扩散脉冲 */
@keyframes task-pulse {
  0% { box-shadow: 0 0 0 0 var(--accent-soft-border); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.runhead .pill.running { animation: task-pulse 1.4s ease-out infinite; }

/* reset.css 在系统「减少动态效果」时会把所有动画压成 0.01ms/1 次，
   流水出场、运行呼吸与转圈菊花都是状态反馈动画，仍需保持（照 NewSessionDialog spinner 豁免先例） */
@media (prefers-reduced-motion: reduce) {
  .tl-item.tl-enter { animation: task-slide .35s ease both !important; }
  .runhead .pill.running { animation: task-pulse 1.4s ease-out infinite !important; }
  .spin { animation: task-spin 0.8s linear infinite !important; }
}
</style>
