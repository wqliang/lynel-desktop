// 增量推送路径：多次 OnTasksRunEvent 推送后 streamItems ≡ 全量 flatten（spec §3.1）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flattenRunEvents } from '../utils/tasks';
import type { EventEnvelope, NormalizedEventDto } from '../types/tasks';

const h = vi.hoisted(() => ({
  runEventCb: null as ((p: unknown) => void) | null,
  runChangedCb: null as ((p: unknown) => void) | null,
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
    OnTasksRunChanged: vi.fn((cb: (p: unknown) => void) => {
      h.runChangedCb = cb;
      return off;
    }),
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
  h.runChangedCb = null;
  h.runEvents = [];
});

/** 最小 RunDto：只填 store 逻辑会碰的字段 */
const runRow = (id: string, taskId = 't1') =>
  ({
    id, taskId, trigger: 'auto', status: 'running', queuedAt: 1, startedAt: 1, finishedAt: null,
    sessionId: null, resumeUsed: null, exitCode: null, isError: null, resultSubtype: null,
    resultText: null, numTurns: null, durationMs: null, totalCostUsd: null, usageJson: null,
    error: null, eventCount: 0,
  }) as import('../types/tasks').RunDto;

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

describe('自动触发的新 run 自动跟随（定时任务不经 runNow，靠 runChanged 推送）', () => {
  it('停在默认最新视图时，新 run 到达自动切详情且事件进流水', async () => {
    h.runEvents = PART1.map((e, i) => evt(e, i));
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();
    // 摆出「任务详情开着，停在上一次 run（= runs[0] 默认视图）」
    store.activeTaskId = 't1';
    store.runs = [runRow('r-old')];
    await store.openRun('r-old');

    // scheduler 自动建了新 run：只推 runChanged，没有 runNow IPC 回来
    h.runChangedCb!(runRow('r-new'));

    expect(store.activeRunId).toBe('r-new');
    // 切过去后新 run 的事件能进流水（不再被 activeRunId 过滤丢弃）
    h.runEventCb!({ runId: 'r-new', events: PART2 });
    expect(store.streamItems).toEqual(flattenRunEvents(PART2));
  });

  it('用户钉在更早的历史 run 上阅读时，不打断（新 run 只入列表）', async () => {
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();
    store.activeTaskId = 't1';
    store.runs = [runRow('r-newest'), runRow('r-mid'), runRow('r-old')];
    await store.openRun('r-old'); // 用户点了历史第 3 行

    h.runChangedCb!(runRow('r-next'));

    expect(store.activeRunId).toBe('r-old'); // 不抢
    expect(store.runs[0]?.id).toBe('r-next'); // 但列表已插入
  });

  it('该任务还没有任何 run（首跑）时也自动打开', async () => {
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();
    store.activeTaskId = 't1';
    store.runs = [];
    store.activeRunId = null;

    h.runChangedCb!(runRow('r-first'));

    expect(store.activeRunId).toBe('r-first');
  });

  it('不属于当前任务的 run 不切详情', async () => {
    const { useTasksStore } = await import('./tasks');
    const store = useTasksStore();
    store.bindPush();
    store.activeTaskId = 't1';
    store.runs = [runRow('r-old')];
    await store.openRun('r-old');

    h.runChangedCb!(runRow('r-other', 't2'));

    expect(store.activeRunId).toBe('r-old');
  });
});
