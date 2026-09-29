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

  // —— 顺序敏感：epoch watcher 用 flush:'sync'，在 epoch 赋值的同步瞬间翻转 mode ——
  // store 在同一同步块里先赋 items、后 bump epoch；而 Vue 的 pre-flush job 按触发
  // （赋值）顺序执行、与 watcher 注册顺序无关，items watcher 必先跑。改成 sync 后，
  // epoch 一落地 mode 就置 'history'（此时 items.value 已是新值），紧随其后的
  // items watcher 才会把这次变化当成历史快照消费，随后转入 live。
  watch(
    epoch,
    () => {
      mode = 'history';
      fresh.value = new Set();
      snapshot(items.value.length);
    },
    { immediate: true, flush: 'sync' },
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
