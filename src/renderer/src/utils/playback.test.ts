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
