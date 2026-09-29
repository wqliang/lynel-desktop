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
