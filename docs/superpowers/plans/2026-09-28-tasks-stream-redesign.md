# 定时任务运行流水重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务运行流水改成增量 flatten + 流式播放队列，加上时间轴版式与动效，修掉空态不居中与 tool 默认展开。

**Architecture:** 纯渲染层改造。`utils/tasks.ts` 的 flatten 重构为可增量推进的 `createStreamFlattener`（store 持有并逐批 push）；新增 `useRunPlayback` composable 以播放队列控制可见条目与打字机节奏；`RunStreamView` 消费 `items + epoch` 两个新 prop 完成时间轴渲染与动效。主进程零改动。

**Tech Stack:** Vue 3 (`<script setup>` + Pinia setup store)、vitest（jsdom + @vue/test-utils）、CSS keyframes。

**Spec:** `docs/superpowers/specs/2026-09-28-tasks-stream-redesign-design.md`

## Global Constraints

- 所有注释、文案、测试断言消息用简体中文。
- **不自动 git commit**：每个任务完成后等用户审阅，由用户明确指示后再提交（用户全局规则：未经主动要求不执行提交）。
- 样式只用 `styles/theme.css` 的 CSS 变量；新增颜色必须先在 theme.css 的 **light 与 dark 两段**各加一个变量，禁止硬编码色值。
- 不改 `src/main/` 任何文件（方案一：主进程零改动）。
- reduced-motion 豁免必须照 `NewSessionDialog.vue:226-230` 的 spinner 先例写法（`@media (prefers-reduced-motion: reduce)` 内 `!important` 重申动画 + 中文注释说明理由）。
- 每个任务结束必须三绿：渲染层测试、`vue-tsc`、（涉及主进程测试文件时）`npm run test:main`。本计划不改主进程，但收尾任务要全量跑一遍。
- 渲染层测试命令一律在 `src/renderer/` 下执行：`npx vitest run [file]`；类型检查：`npx vue-tsc --noEmit`。

---

### Task 1: 增量 flatten 状态机 `createStreamFlattener`

**Files:**
- Modify: `src/renderer/src/utils/tasks.ts:99-190`（`flattenRunEvents` 重构）
- Test: `src/renderer/src/utils/tasks.test.ts`（新建）

**Interfaces:**
- Consumes: `StreamItem` / `EventEnvelope` / `NormalizedEventDto`（`src/renderer/src/types/tasks.ts`，已存在，不改）。
- Produces（后续任务依赖的精确签名）:
  - `createStreamFlattener(): StreamFlattener`，`StreamFlattener = { push(events: NormalizedEventDto[] | EventEnvelope[]): StreamItem[] }`
  - `flattenRunEvents(events): StreamItem[]` 签名保持不变（根 `tests/main/tasks/flatten.test.ts` 仍在用）。

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/utils/tasks.test.ts`：

```ts
// 增量 flatten 与全量 flatten 的等价性安全网（spec §3.1 不变量）
import { describe, expect, it } from 'vitest';
import { createStreamFlattener, flattenRunEvents } from './tasks';
import type { EventEnvelope, NormalizedEventDto } from '../types/tasks';

const EVENTS: NormalizedEventDto[] = [
  {
    type: 'system', subtype: 'init',
    init: {
      model: 'claude-opus-4-7', cwd: 'G:/work/demo', toolCount: 3,
      claudeCodeVersion: '2.0.0', permissionMode: 'bypassPermissions', failedMcpServers: ['mcp-x'],
    },
  },
  {
    type: 'assistant',
    blocks: [
      { type: 'thinking', text: '先看仓库状态' },
      { type: 'text', text: '开始构建' },
    ],
  },
  { type: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }] },
  { type: 'user', toolResult: { toolUseId: 't1', content: 'build ok', isError: false } },
  { type: 'assistant', blocks: [{ type: 'text', text: '构建通过' }] },
  { type: 'stderr', text: 'warn: legacy dep' },
  {
    type: 'result',
    result: {
      subtype: 'success', isError: false, resultText: '构建通过', numTurns: 2,
      durationMs: 12000, totalCostUsd: 0.012, stopReason: 'end_turn',
      terminalReason: null, permissionDenials: [], usage: { output_tokens: 42 },
    },
  },
];

const env = (event: NormalizedEventDto, seq: number): EventEnvelope => ({ seq, ts: 1000 + seq, event });

describe('createStreamFlattener', () => {
  it('逐条增量 push 的结果与全量 flatten 完全一致', () => {
    const full = flattenRunEvents(EVENTS);
    const f = createStreamFlattener();
    let out: ReturnType<typeof flattenRunEvents> = [];
    EVENTS.forEach((e, i) => {
      out = f.push([env(e, i)]);
    });
    expect(out).toEqual(full);
  });

  it('tool_result 回填到早前的 tool 条目，不追加新行', () => {
    const f = createStreamFlattener();
    let out = f.push(EVENTS.slice(0, 3));
    expect(out).toHaveLength(4); // init / thinking / text / tool(tool 为 running)
    expect(out[3]).toMatchObject({ kind: 'tool', status: 'running' });
    out = f.push(EVENTS.slice(3, 4));
    expect(out).toHaveLength(4); // 长度不变：回填不产生新条目
    expect(out[3]).toMatchObject({ kind: 'tool', status: 'ok', output: 'build ok' });
  });

  it('result 的 textRepeatsAbove 跨分片参照此前的正文（单条 result 分片也能判对）', () => {
    const f = createStreamFlattener();
    f.push(EVENTS.slice(0, 5)); // 正文「构建通过」已在前一个分片
    const out = f.push(EVENTS.slice(5));
    const res = out.find((i) => i.kind === 'result');
    expect(res).toMatchObject({ kind: 'result', textRepeatsAbove: true });
  });

  it('分片大小随机（2 条一批）也与全量一致', () => {
    const full = flattenRunEvents(EVENTS);
    const f = createStreamFlattener();
    let out: ReturnType<typeof flattenRunEvents> = [];
    for (let i = 0; i < EVENTS.length; i += 2) out = f.push(EVENTS.slice(i, i + 2));
    expect(out).toEqual(full);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/utils/tasks.test.ts`
Expected: FAIL，`createStreamFlattener is not a function`（或未导出）。

- [ ] **Step 3: 重构实现**

`src/renderer/src/utils/tasks.ts`：把 `flattenRunEvents`（99-190 行）的函数体包进闭包状态机，原函数变为薄包装。替换后该区域为：

```ts
/** 增量 flatten 状态机：push 只处理新到的事件，内部 out / toolIndex 跨批次保留。
 *  —— tool_result 回填、result 判重都依赖历史状态，闭包必须一直活着。 */
export interface StreamFlattener {
  /** 追加一批事件，返回**整条**线性视图的浅拷贝（回填会换掉早前槽位，整体替换才能触发渲染）。 */
  push(events: NormalizedEventDto[] | EventEnvelope[]): StreamItem[];
}

export function createStreamFlattener(): StreamFlattener {
  const out: StreamItem[] = [];
  /** toolUseId → 在 out 里的下标，用于回填 tool_result */
  const toolIndex = new Map<string, number>();

  function push(events: NormalizedEventDto[] | EventEnvelope[]): StreamItem[] {
    const list: NormalizedEventDto[] = (events as unknown[]).map((e) =>
      e && typeof e === 'object' && 'event' in (e as object)
        ? (e as EventEnvelope).event
        : (e as NormalizedEventDto),
    );

    for (const ev of list) {
      switch (ev.type) {
        case 'system': {
          if (ev.subtype === 'init' && ev.init) {
            out.push({
              kind: 'init',
              model: ev.init.model,
              cwd: ev.init.cwd,
              toolCount: ev.init.toolCount,
              version: ev.init.claudeCodeVersion,
              failedMcpServers: ev.init.failedMcpServers,
            });
          } else if (ev.hook) {
            out.push({ kind: 'hook', name: ev.hook.name, ok: ev.hook.ok });
          }
          break;
        }
        case 'assistant': {
          // C1：同一 message.id 的多个 block 本来就分散在多行里，按到达顺序展开即可；
          // 空 thinking 已在主进程过滤，这里再兜一层。
          for (const b of (ev.blocks ?? []) as NormalizedBlockDto[]) {
            if (b.type === 'thinking') {
              if (b.text) out.push({ kind: 'thinking', text: b.text });
            } else if (b.type === 'text') {
              if (b.text) out.push({ kind: 'text', text: b.text });
            } else {
              const delta = b.name === 'Edit' || b.name === 'Write' ? editDelta(b.input) : undefined;
              const item: StreamItem = {
                kind: 'tool',
                id: b.id,
                name: b.name,
                summary: toolSummary(b.name, b.input),
                status: 'running',
                input: b.input,
                subagent: ev.parentToolUseId != null,
                ...(delta ? { delta } : {}),
              };
              toolIndex.set(b.id, out.length);
              out.push(item);
            }
          }
          break;
        }
        case 'user': {
          const tr = ev.toolResult;
          if (!tr) break;
          const at = toolIndex.get(tr.toolUseId);
          if (at === undefined) {
            // 配对不上的 tool_result 仍然展示，不能静默丢
            out.push({ kind: 'text', text: tr.content });
            break;
          }
          const current = out[at] as Extract<StreamItem, { kind: 'tool' }>;
          out[at] = {
            ...current,
            status: tr.isError ? 'error' : 'ok',
            output: tr.content,
          };
          break;
        }
        case 'stderr':
          out.push({ kind: 'stderr', text: ev.text ?? '' });
          break;
        case 'result': {
          if (!ev.result) break;
          const body = squash(ev.result.resultText);
          out.push({
            kind: 'result',
            summary: ev.result,
            // 内容为空时不判重（否则「都为空」会被当成重复，虽然渲染层对空文本本来也不显示正文）
            textRepeatsAbove: body !== '' && body === squash(trailingTextRun(out)),
          });
          break;
        }
        default:
          break;
      }
    }

    return [...out];
  }

  return { push };
}

export function flattenRunEvents(events: NormalizedEventDto[] | EventEnvelope[]): StreamItem[] {
  return createStreamFlattener().push(events);
}
```

注意：`trailingTextRun(out)` / `squash` / `editDelta` / `toolSummary` 等既有辅助函数保持原位不动；原来 99 行起的 `list` 解析逻辑移入 `push` 内。

- [ ] **Step 4: 跑测试确认通过 + 根测试回归**

Run: `cd src/renderer && npx vitest run src/utils/tasks.test.ts`
Expected: PASS（4 个用例）。

Run: `npm run test:main`
Expected: PASS（含 `tests/main/tasks/flatten.test.ts`，验证 `flattenRunEvents` 包装语义未变）。

---

### Task 2: 播放节奏纯函数 `utils/playback.ts`

**Files:**
- Create: `src/renderer/src/utils/playback.ts`
- Test: `src/renderer/src/utils/playback.test.ts`

**Interfaces:**
- Produces:
  - `typePace(total: number): { tickMs: number; charsPerTick: number }` —— 打字机节奏（spec §3.2：约 12ms/字、单段封顶 1500ms、tick 40ms）
  - `isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold?: number): boolean` —— 贴底判定（默认阈值 40px，与现有 `RunStreamView.onScroll` 一致）

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/utils/playback.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isNearBottom, typePace } from './playback';

describe('typePace', () => {
  it('短文本按约 12ms/字换算成 40ms tick 的步长', () => {
    // 20 字 × 12ms = 240ms 时长，每 tick(40ms) 至少推进 ceil(20*40/240)=4 字
    expect(typePace(20)).toEqual({ tickMs: 40, charsPerTick: 4 });
  });

  it('长文本封顶 1500ms，加速推进', () => {
    const p = typePace(1000);
    expect(p.tickMs).toBe(40);
    expect(p.charsPerTick).toBeGreaterThan(1);
    // 实际总时长不超过封顶 + 一个 tick 的余量
    expect(Math.ceil(1000 / p.charsPerTick) * p.tickMs).toBeLessThanOrEqual(1600);
  });

  it('空文本不除零', () => {
    expect(typePace(0).charsPerTick).toBeGreaterThanOrEqual(1);
    expect(typePace(0).tickMs).toBe(40);
  });
});

describe('isNearBottom', () => {
  it('距底 40px 内算贴底', () => {
    expect(isNearBottom(1000, 950, 40)).toBe(true); // 1000-950-40=10 < 40
    expect(isNearBottom(1000, 800, 40)).toBe(false); // 160 >= 40
  });

  it('阈值可调', () => {
    expect(isNearBottom(1000, 900, 40, 200)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/utils/playback.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

新建 `src/renderer/src/utils/playback.ts`：

```ts
// 播放节奏纯函数：打字机步长与「贴底」判定。
// 只算数，不碰 DOM / 定时器 —— 调度在 composables/useRunPlayback.ts。

/** 打字机节奏：约 12ms/字，单段总时长封顶 1500ms（长文本自动加速）。
 *  返回 40ms tick 下每 tick 应推进的字符数（至少 1）。 */
export function typePace(total: number): { tickMs: number; charsPerTick: number } {
  const tickMs = 40;
  if (total <= 0) return { tickMs, charsPerTick: 1 };
  const duration = Math.min(total * 12, 1500);
  return { tickMs, charsPerTick: Math.max(1, Math.ceil((total * tickMs) / duration)) };
}

/** 视口是否贴底（滚动跟随判定，阈值与 RunStreamView 现行 40px 一致）。 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 40,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/renderer && npx vitest run src/utils/playback.test.ts`
Expected: PASS（5 个用例）。

---

### Task 3: store 增量 flatten（`streamItems` + `streamEpoch`）

**Files:**
- Modify: `src/renderer/src/stores/tasks.ts`
- Test: `src/renderer/src/stores/tasks.test.ts`（新建）

**Interfaces:**
- Consumes: `createStreamFlattener`（Task 1）。
- Produces（Task 5 依赖）:
  - `streamItems: Ref<StreamItem[]>` —— 已 flatten 的线性条目
  - `streamEpoch: Ref<number>` —— 历史加载完成的代数，`openRun` / `closeRun` 在**赋完 `streamItems` 之后**同步 `+1`
  - `events` 保留为原始事件源（push 里合成 seq 仍用它的长度），导出不变

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/stores/tasks.test.ts`：

```ts
// 增量推送路径：多次 OnTasksRunEvent 推送后 streamItems ≡ 全量 flatten（spec §3.1）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flattenRunEvents } from '../utils/tasks';
import type { EventEnvelope, NormalizedEventDto } from '../types/tasks';

const h = vi.hoisted(() => ({
  runEventCb: null as ((p: unknown) => void) | null,
  runEvents: [] as EventEnvelope[],
}));

vi.mock('../composables/useElectron', () => {
  const off = () => {};
  return {
    TasksList: vi.fn(async () => []),
    TasksCreate: vi.fn(),
    TasksUpdate: vi.fn(),
    TasksDelete: vi.fn(),
    TasksSetEnabled: vi.fn(),
    TasksRunNow: vi.fn(),
    TasksCancel: vi.fn(),
    TasksRuns: vi.fn(async () => []),
    TasksRun: vi.fn(),
    TasksRunEvents: vi.fn(async () => h.runEvents),
    TasksPreview: vi.fn(),
    TasksTemplates: vi.fn(async () => []),
    TasksSaveTemplate: vi.fn(),
    TasksDeleteTemplate: vi.fn(),
    OnTasksChanged: vi.fn(() => off),
    OnTasksRunChanged: vi.fn(() => off),
    OnTasksRunEvent: vi.fn((cb: (p: unknown) => void) => {
      h.runEventCb = cb;
      return off;
    }),
  };
});

const evt = (event: NormalizedEventDto, seq: number): EventEnvelope => ({ seq, ts: 1000 + seq, event });

const PART1: NormalizedEventDto[] = [
  { type: 'assistant', blocks: [{ type: 'text', text: '开始构建' }] },
  { type: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }] },
];
const PART2: NormalizedEventDto[] = [
  { type: 'user', toolResult: { toolUseId: 't1', content: 'ok', isError: false } },
  { type: 'assistant', blocks: [{ type: 'text', text: '构建通过' }] },
];

beforeEach(() => {
  setActivePinia(createPinia());
  h.runEventCb = null;
  h.runEvents = [];
});

describe('tasks store 增量 flatten', () => {
  it('openRun 全量拉历史 + 推送追加，streamItems 等于全量 flatten', async () => {
    h.runEvents = PART1.map((e, i) => evt(e, i));
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();

    await store.openRun('r1');
    expect(h.runEventCb).not.toBeNull();
    expect(store.streamItems).toEqual(flattenRunEvents(PART1));
    expect(store.streamEpoch).toBe(1);

    // 模拟主进程推一批（未带 envelope，store 应包成 seq 连续的 envelope）
    h.runEventCb!({ runId: 'r1', events: PART2 });
    const all = [...PART1, ...PART2];
    expect(store.streamItems).toEqual(flattenRunEvents(all));
    // tool 回填：tool 条目最终状态为 ok（增量路径不能丢回填）
    expect(store.streamItems[1]).toMatchObject({ kind: 'tool', status: 'ok', output: 'ok' });
  });

  it('openRun 切换 run 会重置并递增 epoch（播放队列据此把内容当历史）', async () => {
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();

    await store.openRun('r1');
    await store.openRun('r2');
    expect(store.streamItems).toEqual([]);
    expect(store.streamEpoch).toBe(2);
  });

  it('别的 run 的推送不进当前流水', async () => {
    h.runEvents = PART1.map((e, i) => evt(e, i));
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();

    await store.openRun('r1');
    const before = store.streamItems;
    h.runEventCb!({ runId: 'OTHER', events: PART2 });
    expect(store.streamItems).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/stores/tasks.test.ts`
Expected: FAIL，`store.streamItems is not defined` / `streamEpoch` 不存在。

- [ ] **Step 3: 实现 store 改动**

`src/renderer/src/stores/tasks.ts`：

1. 头部 import 增加：

```ts
import { createStreamFlattener } from '../utils/tasks';
import type { StreamItem } from '../types/tasks';
```

（与既有 `EventEnvelope` 等 type import 合并写。）

2. `events` ref 声明（22 行附近）后新增：

```ts
  /** 已 flatten 的线性条目：增量维护，RunStreamView 直接消费（不再每帧全量 flatten） */
  const streamItems = ref<StreamItem[]>([]);
  /** 历史加载完成的代数：openRun / closeRun 在赋完 streamItems 之后 +1，
   *  播放队列据此把当前内容当历史直接全量显示、不打字机回放 */
  const streamEpoch = ref(0);
  let flattener = createStreamFlattener();
```

3. `openRun` 替换为：

```ts
  /** 打开某次 run 的完整流水：先补齐已有事件，再靠推送增量追加 */
  async function openRun(runId: string) {
    activeRunId.value = runId;
    events.value = [];
    streamItems.value = [];
    flattener = createStreamFlattener();
    followTail.value = true;
    const initial = (await TasksRunEvents(runId, {})) as EventEnvelope[];
    // 拉取期间可能穿插过该 run 的推送：与原 events.value = initial 同语义 —— 全量覆盖，
    // flattener 一并重建，保证 streamItems 与 events 从同一起点推进。
    events.value = initial;
    flattener = createStreamFlattener();
    streamItems.value = flattener.push(initial);
    streamEpoch.value += 1;
  }
```

4. `closeRun` 替换为：

```ts
  function closeRun() {
    activeRunId.value = null;
    events.value = [];
    streamItems.value = [];
    flattener = createStreamFlattener();
    streamEpoch.value += 1;
  }
```

5. `select()`（52-63 行）与 `remove()`（88-97 行）里凡是 `events.value = []` 的地方同步补三行（保持两个数据源一致，避免切任务后 streamItems 残留上一个任务的条目）：

```ts
    streamItems.value = [];
    flattener = createStreamFlattener();
    streamEpoch.value += 1;
```

（`select()` 末尾的 `openRun` 会再 bump 一次 epoch，多一次无害——播放队列只是重复消费历史快照。）

6. push 回调（`OnTasksRunEvent`，178-187 行）尾部追加一行，改为：

```ts
    const off3 = OnTasksRunEvent((payload) => {
      const p = payload as { runId: string; events: Array<NormalizedEventDto | EventEnvelope> };
      if (!p || p.runId !== activeRunId.value) return;
      const incoming = (p.events ?? []).map((e, i) =>
        ('event' in (e as object)
          ? (e as EventEnvelope)
          : { seq: events.value.length + i, ts: Date.now(), event: e as NormalizedEventDto }),
      );
      events.value = [...events.value, ...incoming];
      streamItems.value = flattener.push(incoming);
    });
```

7. `return` 对象（195-200 行）加上 `streamItems, streamEpoch`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/renderer && npx vitest run src/stores/tasks.test.ts`
Expected: PASS（3 个用例）。

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误（新字段暂无消费方，正常）。

---

### Task 4: 播放队列 `useRunPlayback`

**Files:**
- Create: `src/renderer/src/composables/useRunPlayback.ts`
- Test: `src/renderer/src/composables/useRunPlayback.test.ts`

**Interfaces:**
- Consumes: `typePace`（Task 2）。
- Produces（Task 5/6 依赖的精确签名）:

```ts
export function useRunPlayback(
  items: Ref<StreamItem[]>,
  epoch: Ref<number>,
): {
  visibleCount: Ref<number>;
  typing: Ref<{ at: number; chars: number } | null>;
  fresh: Ref<Set<number>>;
  backlog: ComputedRef<number>;
  fastForward: () => void;
}
```

- `visibleCount`：已出队条数，渲染层 `items.slice(0, visibleCount)`
- `typing`：正在打字机的条目下标与已显示字符数（非 text 条目播放时为 null）
- `fresh`：实时播放中出队的下标集合（渲染层据此挂滑入动画 class）
- `backlog`：积压条数 = `items.length - visibleCount`
- `fastForward`：立即全部显示（清 timer）

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/composables/useRunPlayback.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { useRunPlayback } from './useRunPlayback';
import type { StreamItem } from '../types/tasks';

const text = (s: string): StreamItem => ({ kind: 'text', text: s });
const tool = (id: string): StreamItem => ({
  kind: 'tool', id, name: 'Bash', summary: 'cmd', status: 'running',
  input: {}, subagent: false,
});

/** 模拟 store 的时序：历史赋值完成后同步 bump epoch（同一 flush 内先 epoch 后 items 生效） */
async function loadHistory(items: Ref<StreamItem[]>, epoch: Ref<number>, list: StreamItem[]) {
  items.value = list;
  epoch.value += 1;
  await nextTick();
}

describe('useRunPlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('历史不回放：epoch 落地后立即全量可见，无打字机', async () => {
    const items = ref<StreamItem[]>([]) as Ref<StreamItem[]>;
    const epoch = ref(0);
    const pb = useRunPlayback(items, epoch);
    await loadHistory(items, epoch, [text('历史一'), tool('t1'), text('历史二')]);
    expect(pb.visibleCount.value).toBe(3);
    expect(pb.typing.value).toBeNull();
    expect(pb.backlog.value).toBe(0);
  });

  it('实时事件逐条出队：text 走打字机，tool 走 80ms 间隔', async () => {
    const items = ref<StreamItem[]>([]) as Ref<StreamItem[]>;
    const epoch = ref(0);
    const pb = useRunPlayback(items, epoch);
    await loadHistory(items, epoch, [text('历史')]);
    expect(pb.visibleCount.value).toBe(1);

    // 推一条实时正文
    items.value = [...items.value, text('新的正文内容')];
    await nextTick();
    await vi.advanceTimersByTimeAsync(90); // 过了 80ms 出队间隔
    expect(pb.visibleCount.value).toBe(2);
    expect(pb.typing.value?.at).toBe(1);
    expect(pb.fresh.value.has(1)).toBe(true);

    // 打字机推进到完成
    await vi.advanceTimersByTimeAsync(2000);
    expect(pb.typing.value).toBeNull();
    expect(pb.backlog.value).toBe(0);
  });

  it('积压超过 5 条自动快进', async () => {
    const items = ref<StreamItem[]>([]) as Ref<StreamItem[]>;
    const epoch = ref(0);
    const pb = useRunPlayback(items, epoch);
    await loadHistory(items, epoch, [text('历史')]);

    const burst: StreamItem[] = [];
    for (let i = 0; i < 7; i++) burst.push(text(`第${i}条`));
    items.value = [...items.value, ...burst];
    await nextTick();
    await vi.advanceTimersByTimeAsync(90); // 触发一次 playOne
    expect(pb.visibleCount.value).toBe(items.value.length);
    expect(pb.typing.value).toBeNull();
    expect(pb.backlog.value).toBe(0);
  });

  it('手动 fastForward 立即全显', async () => {
    const items = ref<StreamItem[]>([]) as Ref<StreamItem[]>;
    const epoch = ref(0);
    const pb = useRunPlayback(items, epoch);
    await loadHistory(items, epoch, [text('历史')]);
    items.value = [...items.value, text('a'), text('b')];
    await nextTick();
    pb.fastForward();
    expect(pb.visibleCount.value).toBe(3);
    expect(pb.backlog.value).toBe(0);
  });

  it('切 run（epoch 再增）清空打字机与 fresh，回到历史快照', async () => {
    const items = ref<StreamItem[]>([]) as Ref<StreamItem[]>;
    const epoch = ref(0);
    const pb = useRunPlayback(items, epoch);
    await loadHistory(items, epoch, [text('旧 run')]);
    items.value = [...items.value, text('实时正文')];
    await nextTick();
    await vi.advanceTimersByTimeAsync(90); // 打字机进行中

    // 切 run：store 先清空再拉新历史再 bump epoch（模拟同一 flush）
    items.value = [text('新 run 历史')];
    epoch.value += 1;
    await nextTick();
    expect(pb.typing.value).toBeNull();
    expect(pb.visibleCount.value).toBe(1);
    expect(pb.fresh.value.size).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/composables/useRunPlayback.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 composable**

新建 `src/renderer/src/composables/useRunPlayback.ts`：

```ts
// 运行流水的播放队列：控制「哪些条目现在可见、以什么节奏出场」。
// 数据源是 store 增量 flatten 后的 items；历史（openRun 拉取）直接全量显示，
// 只有 epoch 落地之后追加的实时事件才逐条播放（打字机 / 滑入节奏）。
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { StreamItem } from '../types/tasks';
import { typePace } from '../utils/playback';

/** 非正文条目（tool / init / stderr / result）之间的出场间隔 */
const GAP_MS = 80;
/** 一段正文打完到下一条的停顿（呼吸感） */
const TEXT_GAP_MS = 120;
/** 积压超过该条数直接快进，避免长流水永远追不上（spec §6） */
const MAX_BACKLOG = 5;

export function useRunPlayback(
  items: Ref<StreamItem[]>,
  epoch: Ref<number>,
): {
  visibleCount: Ref<number>;
  typing: Ref<{ at: number; chars: number } | null>;
  fresh: Ref<Set<number>>;
  backlog: ComputedRef<number>;
  fastForward: () => void;
} {
  const visibleCount = ref(0);
  const typing = ref<{ at: number; chars: number } | null>(null);
  /** 实时播放中出队的下标 —— 渲染层据此挂滑入动画，历史条目不挂（不整屏闪一次） */
  const fresh = ref<Set<number>>(new Set());

  /** history：下一次 items 变化按历史快照消费；live：正常逐条播放 */
  let mode: 'history' | 'live' = 'history';
  /** 下一个待出队的下标 */
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;

  const backlog = computed(() => Math.max(0, items.value.length - visibleCount.value));

  function stopAll() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
    typing.value = null;
  }

  /** 历史快照：全部立即可见，不打字机 */
  function snapshot(len: number) {
    stopAll();
    cursor = len;
    visibleCount.value = len;
  }

  function fastForward() {
    stopAll();
    cursor = items.value.length;
    visibleCount.value = cursor;
  }

  function scheduleNext(delay: number) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      playOne();
    }, delay);
  }

  function ensurePlaying() {
    if (timer !== null || tick !== null) return;
    if (cursor >= items.value.length) return;
    scheduleNext(GAP_MS);
  }

  function playOne() {
    if (cursor >= items.value.length) return;
    // 每出一条前查积压：连发事件直接快进（spec §6 快进阈值）
    if (items.value.length - cursor > MAX_BACKLOG) {
      fastForward();
      return;
    }
    const at = cursor;
    const item = items.value[at];
    cursor = at + 1;
    visibleCount.value = cursor;
    fresh.value.add(at);

    if (item.kind === 'text' && item.text.length > 0) {
      // 打字机：整段容器已滑入（tl-enter），逐字推进正文
      const { tickMs, charsPerTick } = typePace(item.text.length);
      typing.value = { at, chars: 0 };
      tick = setInterval(() => {
        // 打字期间也可能积压：同样触发快进
        if (items.value.length - cursor > MAX_BACKLOG) {
          fastForward();
          return;
        }
        const t = typing.value;
        if (!t) return;
        const next = t.chars + charsPerTick;
        if (next >= item.text.length) {
          stopAll();
          scheduleNext(TEXT_GAP_MS);
        } else {
          typing.value = { at, chars: next };
        }
      }, tickMs);
    } else {
      // tool / init / stderr / result：整行滑入后按间隔出下一条
      scheduleNext(GAP_MS);
    }
  }

  // —— 顺序敏感：epoch watcher 必须先于 items watcher 注册 ——
  // store 在历史赋值后同步 bump epoch，同一 flush 里先执行 epoch（置 history），
  // 紧接着的 items 变化才会被当成历史快照消费，而不是实时回放。
  watch(
    epoch,
    () => {
      mode = 'history';
      fresh.value = new Set();
      snapshot(items.value.length);
    },
    { immediate: true },
  );

  watch(
    items,
    (arr) => {
      const len = arr.length;
      // run 切换 / closeRun 清空：收缩到新长度（mode 交给 epoch 置位）
      if (len < visibleCount.value) {
        stopAll();
        cursor = len;
        visibleCount.value = len;
        return;
      }
      // 历史赋值（openRun 拉取完成）：立即全显，然后转入 live
      if (mode === 'history') {
        snapshot(len);
        mode = 'live';
        return;
      }
      if (len > cursor) ensurePlaying();
    },
    { immediate: true },
  );

  onBeforeUnmount(stopAll);

  return { visibleCount, typing, fresh, backlog, fastForward };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/renderer && npx vitest run src/composables/useRunPlayback.test.ts`
Expected: PASS（5 个用例）。若「切 run」用例失败，优先检查 epoch / items 两个 watcher 的注册顺序与 `mode` 流转，不要放宽断言。

- [ ] **Step 5: 类型检查**

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误。

---

### Task 5: RunStreamView 接线（props 改造 + 播放消费 + 快进按钮 + 平滑滚动）

**Files:**
- Modify: `src/renderer/src/components/tasks/RunStreamView.vue`
- Modify: `src/renderer/src/components/tasks/TaskDetailPane.vue:59-66,87-99`
- Modify: `src/renderer/src/components/tasks/TasksPane.vue:15-33`

**Interfaces:**
- Consumes: `streamItems` / `streamEpoch`（Task 3）、`useRunPlayback`（Task 4）、`isNearBottom`（Task 2）。
- Produces:
  - `RunStreamView` props: `{ run: RunDto; items: StreamItem[]; epoch: number; isLatest?: boolean }`（`events` prop 删除）
  - `TaskDetailPane` props 增加 `items: StreamItem[]`、`epoch: number`，删除 `events`

- [ ] **Step 1: 改 TaskDetailPane 与 TasksPane 的传参**

`TaskDetailPane.vue`：

1. props（89-99 行）中 `events: EventEnvelope[]` 替换为：

```ts
  items: StreamItem[]
  /** 历史加载代数：透传给 RunStreamView，播放队列据此区分历史/实时 */
  epoch: number
```

2. type import（87 行）：`EventEnvelope` 换成 `StreamItem`（`RunDto, TaskDto` 保留）。
3. 模板 59-66 行：

```html
      <RunStreamView
        v-if="activeRun"
        :run="activeRun"
        :items="items"
        :epoch="epoch"
        :is-latest="isLatest"
        @cancel="$emit('cancel', activeRun.id)"
        @latest="$emit('view-latest')"
      />
```

`TasksPane.vue` 模板 15-33 行的 `TaskDetailPane` 上：

- 删掉 `:events="store.events"`
- 加上 `:items="store.streamItems"` 与 `:epoch="store.streamEpoch"`

- [ ] **Step 2: 改 RunStreamView 脚本**

`RunStreamView.vue` script 区逐块替换：

1. import 行（114-119 行）：

```ts
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import Markdown from '../trace/Markdown.vue'
import ToolStepCard from './ToolStepCard.vue'
import { formatDuration } from '../../utils/tasks'
import { isNearBottom } from '../../utils/playback'
import { useRunPlayback } from '../composables/useRunPlayback'
import type { RunDto, StreamItem } from '../../types/tasks'
```

2. props / emits（121-127 行）：

```ts
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
```

3. 播放队列 + 可见列表（替换 134-143 行的 `all` / `items` computed）：

```ts
const items = computed(() => props.items)
const epoch = computed(() => props.epoch)
const pb = useRunPlayback(items, epoch)
const { visibleCount, typing, backlog, fastForward } = pb

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
```

4. toolCount / errorCount（145-149 行）把 `all.value` 换成 `items.value`（统计不受播放进度影响）：

```ts
const toolCount = computed(() => items.value.filter((i) => i.kind === 'tool').length)
const errorCount = computed(
  () => items.value.filter((i) => i.kind === 'tool' && i.status === 'error').length,
)
```

5. 滚动（223-233 行）：

```ts
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
```

6. watch 区（236-256 行）：保留 run.id 与 run.status 两个 watch，把 events 长度 watch 换成播放进度 watch，并加终态快进：

```ts
/** 换 run 要重置视图态：展开态的下标是随 run 变的，跟着跨 run 会串到别的块上。 */
watch(
  () => props.run.id,
  () => {
    expanded.value = new Set()
    now.value = Date.now()
    // 正在跑的 run 跟到底（看最新）；已结束的历史 run 从顶部开始读
    following = props.run.status === 'running'
    if (following) void scrollToBottom()
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

/** 出新条目 / 打字机推进时，贴底才跟随（上滚暂停、回底恢复由 onScroll 维护） */
watch(
  [visibleCount, () => typing.value?.chars],
  () => {
    if (!following) return
    void scrollToBottom()
  },
)
```

7. `onBeforeUnmount` 保留（ticker 清理；播放队列的 timer 由 composable 自己的 `onBeforeUnmount` 清）。

- [ ] **Step 3: 改 RunStreamView 模板**

1. 循环源（30、108 行）：`v-for="item in items"` → `v-for="item in shown"`；空态判断 `items.length === 0` → `shown.length === 0`。
2. runhead（21 行「取消」按钮之前）插入快进按钮：

```html
      <button v-if="backlog > 0" class="btn" title="事件积压，立即显示全部" @click="fastForward">
        立即显示 {{ backlog }}
      </button>
```

3. 正文分支（56-62 行）加打字光标：

```html
        <div v-else-if="item.kind === 'text'" class="text-line">
          <Markdown
            :text="item.text"
            class="md-text"
            :max-len="NO_FOLD"
            :max-lines="NO_FOLD"
          />
          <span v-if="typing && typing.at === item.at" class="caret" />
        </div>
```

4. 事件体容器（25 行）加空态 class：

```html
    <div ref="bodyEl" class="sbody" :class="{ 'empty-body': shown.length === 0 }" @scroll="onScroll">
```

5. 文件头注释（1-8 行）更新为：

```html
<!-- 运行流水：把一次 run 的事件流重放成 agent 化的时间轴视图。
     - store 增量 flatten（streamItems），本组件不再全量 flatten
     - useRunPlayback 播放队列：历史直接全显，实时事件逐条出场（正文打字机、其余 80ms 间隔滑入）
     - 积压 >5 条或点「立即显示」快进；终态先快进再通知
     - 工具调用 / 思考 / 诊断输出默认折叠（无 Edit/Write 例外）
     - 正文与终局结果永不自动折叠（NO_FOLD），running 时贴底跟随，上滚暂停 -->
```

- [ ] **Step 4: 加样式**

`RunStreamView.vue` `<style scoped>` 追加（同时把原 `.text-line` 缺的容器补上；`.caret` 已有样式保留）：

```css
/* 打字机进行中的正文：块级容器 + 行尾光标 */
.text-line { position: relative; }
```

空态居中的两条规则本任务先加上（Task 9 会补齐另外两处空态）：

```css
/* 空态时事件体撑满并居中（spec §4：始终在右栏正中） */
.stream { min-height: 100%; }
.sbody.empty-body { flex: 1; display: flex; align-items: center; justify-content: center; }
```

- [ ] **Step 5: 类型检查 + 全量渲染层测试**

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误。

Run: `cd src/renderer && npx vitest run`
Expected: PASS（新增 store / playback / useRunPlayback 测试全绿，无回归）。

- [ ] **Step 6: 手动验证**

Run: `npm run dev`，打开「任务」→ 一个有历史的 run：
- 历史一次性全显（不打字机回放）；
- 点「立即执行」，新事件逐条出场、正文逐字出现、积压时出现「立即显示 N」按钮；
- 上滚停止跟随，滚回底部恢复；
- 运行结束瞬间队列快进。
验证后停掉：`npm run dev:stop`。

---

### Task 6: 时间轴版式（版式 C）+ 节点着色

**Files:**
- Modify: `src/renderer/src/styles/theme.css`（light 31-38 行附近、dark 170-177 行附近各加一个变量）
- Modify: `src/renderer/src/components/tasks/RunStreamView.vue`（模板包时间轴壳 + 样式）

**Interfaces:**
- Consumes: `fresh`（Task 4，`pb` 解构里补上）。
- Produces: 无下游依赖（纯视觉）。

- [ ] **Step 1: theme.css 加「思考」节点色**

light 段（`--status-warn-bg` 之后，37-38 行附近）加：

```css
  /* 思考节点（运行流水时间轴）：紫 */
  --status-thinking: #BF5AF2;
```

dark 段（176-177 行附近）加：

```css
  --status-thinking: #BF5AF2;
```

（两段都必须加，否则暗色主题回退失败。）

- [ ] **Step 2: 模板包时间轴壳**

`RunStreamView.vue` 循环体：`<template v-for ...>` 内的全部分支包进一个 `div.tl-item`（分支的 v-if / v-else-if 链保持连续，只是共同多一层父节点），key 仍为 `run.id + ':' + item.at`：

```html
      <template v-for="item in shown" :key="run.id + ':' + item.at">
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
          <!-- ……原有 init / hook / thinking / text / tool / stderr / result 分支原样搬进来，内容不改 …… -->
        </div>
      </template>
```

script 中把 `fresh` 加进解构：`const { visibleCount, typing, backlog, fastForward, fresh } = pb`。

- [ ] **Step 3: 时间轴样式**

`RunStreamView.vue` `<style scoped>` 追加：

```css
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
```

- [ ] **Step 4: 验证**

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误。

Run: `npm run dev` 人工过一遍：节点连线连续、思考紫/工具橙/正文蓝/完成绿/错误红、最后一条无悬空线、子代理缩进仍在时间轴内。看完 `npm run dev:stop`。

---

### Task 7: ToolStepCard 统一默认折叠 + 展开高度过渡

**Files:**
- Modify: `src/renderer/src/components/tasks/ToolStepCard.vue`
- Test: `src/renderer/src/components/tasks/ToolStepCard.test.ts`（新建）

**Interfaces:**
- Consumes: 无（组件内部改动）。
- Produces: DOM 结构变为 `.step-wrap > .step + .open(.on) > .open-in > .open-pad`（Task 8 的动效不依赖它，但改名要同步 Task 9 前的手测）。

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/components/tasks/ToolStepCard.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolStepCard from './ToolStepCard.vue';
import type { StreamItem } from '../../types/tasks';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

const bash: ToolItem = {
  id: 't1', name: 'Bash', summary: 'npm test', status: 'ok',
  input: { command: 'npm test' }, output: 'ok', subagent: false,
};

describe('ToolStepCard', () => {
  it('Bash 默认折叠', async () => {
    const w = mount(ToolStepCard, { props: { item: bash } });
    expect(w.find('.open').classes()).not.toContain('on');
    await w.find('.step').trigger('click');
    expect(w.find('.open').classes()).toContain('on');
  });

  it('Edit / Write 也默认折叠（去掉自动展开的例外），点开仍渲染 diff', async () => {
    const edit: ToolItem = {
      id: 't2', name: 'Edit', summary: 'a.ts', status: 'ok',
      input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      output: 'diff', subagent: false, delta: { add: 1, del: 1 },
    };
    const w = mount(ToolStepCard, { props: { item: edit } });
    expect(w.find('.open').classes()).not.toContain('on');
    await w.find('.step').trigger('click');
    expect(w.find('.open').classes()).toContain('on');
    expect(w.find('.open').html()).toContain('diff-del');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/components/tasks/ToolStepCard.test.ts`
Expected: FAIL，Edit 用例 `.open` 带 `on`（现状默认展开）。

- [ ] **Step 3: 实现**

`ToolStepCard.vue`：

1. 模板 `.open` 区块（22-28 行）替换：

```html
    <div class="open" :class="{ on: open }">
      <div class="open-in">
        <div class="open-pad">
          <div class="io"><pre>{{ inputText }}</pre></div>
          <div v-if="item.output !== undefined" class="io">
            <pre v-if="isDiff" v-html="diffHtml" />
            <pre v-else>{{ item.output }}</pre>
          </div>
        </div>
      </div>
    </div>
```

2. 脚本（47-49 行）：

```ts
/** 全部工具默认折叠 —— 无 Edit/Write 例外（spec §2 决策 A），diff 点开照常渲染 */
const isDiffTool = computed(() => props.item.name === 'Edit' || props.item.name === 'Write')
const open = ref(false)
```

3. 样式：删除 `.step-wrap > .open { border-top: 1px solid var(--border); padding: 8px 10px; }`，追加：

```css
/* 展开/收起高度过渡：grid 0fr→1fr 不需要预知内容高度 */
.open {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows .25s ease;
}
.open.on { grid-template-rows: 1fr; }
.open-in { overflow: hidden; min-height: 0; }
.open-pad { border-top: 1px solid var(--border); padding: 8px 10px; }
/* reset.css 在系统「减少动态效果」时把动画压到 0.01ms；展开过渡是操作反馈，仍需保持（照 spinner 豁免先例） */
@media (prefers-reduced-motion: reduce) {
  .open { transition: grid-template-rows .25s ease !important; }
}
```

4. 文件头注释（1-3 行）更新：

```html
<!-- 单条工具调用的 StepCard：全部默认折叠成一行，靠 tname + summ 辨认「这步在干嘛」。
     Edit / Write 也默认折叠（无例外），点开后仍按 diff 渲染输出。
     左侧竖条按 tool_use.id 的色相着色（useIdHue），同一 id 的卡片颜色一致。 -->
```

5. 同步 `RunStreamView.vue` 文件头注释里「Edit / Write 例外」的旧说法（若 Task 5 已改则跳过）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/renderer && npx vitest run src/components/tasks/ToolStepCard.test.ts`
Expected: PASS（2 个用例）。

---

### Task 8: 流水动效（行滑入 + 状态呼吸点 + reduced-motion 豁免）

**Files:**
- Modify: `src/renderer/src/components/tasks/RunStreamView.vue`（style + runhead pill）

**Interfaces:**
- Consumes: `fresh` → `tl-enter` class（Task 6 已接）。
- Produces: 无。

- [ ] **Step 1: 加关键帧与豁免**

`RunStreamView.vue` `<style scoped>` 追加：

```css
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
   流水出场与运行呼吸是状态反馈动画，仍需保持（照 NewSessionDialog spinner 豁免先例） */
@media (prefers-reduced-motion: reduce) {
  .tl-item.tl-enter { animation: task-slide .35s ease both !important; }
  .runhead .pill.running { animation: task-pulse 1.4s ease-out infinite !important; }
}
```

- [ ] **Step 2: 验证**

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误。

Run: `npm run dev` 人工验证（注意：用户系统关闭了 Windows 动画，**这些动效必须照常播放**，这正是豁免的目的）：
- 实时新行从下方滑入；
- running 时状态 pill 呼吸脉冲，终态停止；
- 历史加载不触发整屏滑入（fresh 不含历史下标）。

看完 `npm run dev:stop`。

---

### Task 9: 空态始终居中于右栏

**Files:**
- Modify: `src/renderer/src/components/tasks/TasksPane.vue:150-156`
- Verify: `src/renderer/src/components/tasks/TaskDetailPane.vue:67-75`（「还没运行过」blank，预期已居中，只验证不改）

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: TasksPane 空态居中**

`TasksPane.vue` `<style scoped>` 的 `.empty-detail` 替换：

```css
/* 「还没有任务」始终在右栏正中，随窗体尺寸跟随（spec §4）。
   .blank 的 height:100% 在居中容器里会撑满，覆盖为 auto 让内容块自然居中。 */
.empty-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  background: var(--bg-primary);
}
.empty-detail .blank {
  height: auto;
  min-height: min(300px, 100%);
}
```

（`RunStreamView` 的「这次运行还没有事件」已在 Task 5 Step 4 用 `.empty-body` 处理。）

- [ ] **Step 2: 三种空态人工核验**

Run: `npm run dev`，逐一验证并记录结果：
1. 删光所有任务 → 「还没有任务」在右栏水平 + 垂直居中；
2. 新建未运行任务 → 「这个任务还没运行过」在右栏居中（TaskDetailPane `.blank` 的 `height:100%` 应已生效，不居中则给 `.dbody > .blank` 补 `width: 100%`）；
3. 打开一个无事件的 run（或历史 run 事件被清）→ 「这次运行还没有事件」居中；
4. 拖动窗口大小 → 三者都跟随居中。

看完 `npm run dev:stop`。

- [ ] **Step 3: 类型检查**

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误。

---

### Task 10: 全量回归 + 验收

**Files:** 无新改动（只跑验证；发现问题回对应任务修）。

- [ ] **Step 1: 三套检查全绿**

Run: `cd src/renderer && npx vitest run`
Expected: PASS。

Run: `cd src/renderer && npx vue-tsc --noEmit`
Expected: 无错误。

Run: `npm run test:main`
Expected: PASS（含 `tests/main/tasks/flatten.test.ts`，主进程未动也必须确认）。

- [ ] **Step 2: 对照 spec 验收清单人工过一遍**

Run: `npm run dev`，对照 `docs/superpowers/specs/2026-09-28-tasks-stream-redesign-design.md` §2 决策表逐项打勾：

- [ ] tool 全部默认折叠为一行（含 Edit/Write），点开有 0.25s 高度过渡
- [ ] 打字机只回放实时事件，打开历史直接全显
- [ ] 时间轴节点着色：正文蓝 / 思考紫 / 工具橙 / 完成绿 / 错误红
- [ ] 动效五件套：滑入、打字机、呼吸点、展开过渡、自动滚动跟随（系统关动画也照常播放）
- [ ] 空态三处居中且随窗体变化
- [ ] 积压 >5 快进、「立即显示 N」按钮、终态先快进
- [ ] 切 run 无串台（打字机/展开态/动画 class 不跨 run 残留）

看完 `npm run dev:stop`。

- [ ] **Step 3: 汇报**

向用户汇报验收结果与改动文件清单，**等待用户审阅后再提交**（不要自行 git commit）。
