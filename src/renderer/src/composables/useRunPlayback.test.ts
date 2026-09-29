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
