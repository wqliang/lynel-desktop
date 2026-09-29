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
