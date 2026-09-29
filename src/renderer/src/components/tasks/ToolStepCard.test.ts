import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolStepCard from './ToolStepCard.vue';
import type { StreamItem } from '../../types/tasks';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

const bash: ToolItem = {
  kind: 'tool', id: 't1', name: 'Bash', summary: 'npm test', status: 'ok',
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
      kind: 'tool', id: 't2', name: 'Edit', summary: 'a.ts', status: 'ok',
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
