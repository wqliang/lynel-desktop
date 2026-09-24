import { describe, it, expect } from 'vitest'
import { parentOf, baseName, resolveCreateTarget, absJoin } from './fileTree'

describe('parentOf / baseName', () => {
  it('嵌套路径', () => {
    expect(parentOf('a/b/c.ts')).toBe('a/b')
    expect(baseName('a/b/c.ts')).toBe('c.ts')
  })
  it('根级条目', () => {
    expect(parentOf('a.ts')).toBe('')
    expect(baseName('a.ts')).toBe('a.ts')
  })
  it('空串', () => {
    expect(parentOf('')).toBe('')
    expect(baseName('')).toBe('')
  })
})

describe('resolveCreateTarget', () => {
  it('无选中 → 根', () => {
    expect(resolveCreateTarget(null, null)).toBe('')
  })
  it('选中目录 → 该目录', () => {
    expect(resolveCreateTarget('src/utils', true)).toBe('src/utils')
  })
  it('选中文件 → 父目录', () => {
    expect(resolveCreateTarget('src/utils/time.ts', false)).toBe('src/utils')
  })
  it('选中根级文件 → 根', () => {
    expect(resolveCreateTarget('a.ts', false)).toBe('')
  })
  it('isDir null（条目已消失）按文件处理', () => {
    expect(resolveCreateTarget('src/gone.ts', null)).toBe('src')
  })
})

describe('absJoin', () => {
  it('base 无尾分隔符', () => {
    expect(absJoin('G:\\work\\repo', 'src/a.ts')).toBe('G:\\work\\repo/src/a.ts')
  })
  it('base 带尾斜杠不重复', () => {
    expect(absJoin('G:/work/repo/', 'a.ts')).toBe('G:/work/repo/a.ts')
  })
  it('rel 为空返回 base', () => {
    expect(absJoin('G:\\work\\repo', '')).toBe('G:\\work\\repo')
  })
})
