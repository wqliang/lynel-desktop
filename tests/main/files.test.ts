// tests/main/files.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isIgnored, detectBinary, listDir, resolveEntry, readFileEntry, writeFileEntry, createEntry, renameEntry, deleteEntry, startWatch, stopWatch, MAX_TEXT_SIZE, uniqueDestName, copyEntries, buildFileNameW, parseFileNameW, revealEntry } from '../../src/main/files.js'
import { getBus } from '../../src/main/events.js'

describe('isIgnored', () => {
  it('忽略常见目录', () => {
    expect(isIgnored('node_modules')).toBe(true)
    expect(isIgnored('.git')).toBe(true)
    expect(isIgnored('dist')).toBe(true)
    expect(isIgnored('__pycache__')).toBe(true)
  })
  it('忽略 *.log / *.lock / *.min.js', () => {
    expect(isIgnored('app.log')).toBe(true)
    expect(isIgnored('package-lock.json')).toBe(true)
    expect(isIgnored('bundle.min.js')).toBe(true)
  })
  it('不忽略普通文件/目录', () => {
    expect(isIgnored('src')).toBe(false)
    expect(isIgnored('main.ts')).toBe(false)
    expect(isIgnored('README.md')).toBe(false)
  })
})

describe('detectBinary', () => {
  it('含 NUL 字节判定二进制', () => {
    expect(detectBinary(Buffer.from([0x68, 0x69, 0x00, 0x0a]))).toBe(true)
  })
  it('纯文本非二进制', () => {
    expect(detectBinary(Buffer.from('hello world\n第二行'))).toBe(false)
  })
})

describe('listDir', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-files-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  it('目录在前、名称排序、过滤忽略项', () => {
    fs.mkdirSync(path.join(tmp, 'src'))
    fs.mkdirSync(path.join(tmp, 'node_modules'))
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a')
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{}')
    const entries = listDir(tmp)
    expect(entries.map((e) => e.name)).toEqual(['src', 'a.txt'])
    expect(entries[0].isDir).toBe(true)
  })
})

describe('resolveEntry', () => {
  it('阻止相对路径越界', () => {
    const base = path.join(os.tmpdir(), 'lynel-base')
    fs.mkdirSync(base, { recursive: true })
    expect(() => resolveEntry(base, '../escape.txt')).toThrow(/越界/)
  })
  it('空 relPath 返回 workDir 本身', () => {
    expect(resolveEntry('/tmp/foo', '')).toBe(path.resolve('/tmp/foo'))
  })
})

describe('文件操作', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-files-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('write 后 read 往返一致', async () => {
    const f = path.join(tmp, 'a.txt')
    await writeFileEntry(f, '你好 world')
    const r = await readFileEntry(f)
    expect(r.content).toBe('你好 world')
    expect(r.binary).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.size).toBeGreaterThan(0)
  })

  it('超大文本标记 truncated 且截断', async () => {
    const f = path.join(tmp, 'big.txt')
    await fs.promises.writeFile(f, 'x'.repeat(1024 * 1024 + 10))
    const r = await readFileEntry(f)
    expect(r.truncated).toBe(true)
    expect(r.binary).toBe(false)
    expect(r.content.length).toBeLessThan(1024 * 1024 + 10)
  })

  it('二进制文件标记 binary', async () => {
    const f = path.join(tmp, 'bin.dat')
    await fs.promises.writeFile(f, Buffer.from([0x01, 0x02, 0x00, 0x03]))
    const r = await readFileEntry(f)
    expect(r.binary).toBe(true)
  })

  it('超大文件只读前 1MB+1 字节，不整读入内存', async () => {
    const f = path.join(tmp, 'huge.txt')
    // 前 1MB+1 字节为文本，之后填充大量 NUL（旧实现整读会误判/内存尖峰）
    const head = Buffer.alloc(MAX_TEXT_SIZE + 1, 0x61) // 'a'
    const tail = Buffer.alloc(MAX_TEXT_SIZE, 0x00)
    await fs.promises.writeFile(f, Buffer.concat([head, tail]))
    const spy = vi.spyOn(fs.promises, 'readFile')
    try {
      const r = await readFileEntry(f)
      expect(spy).not.toHaveBeenCalled() // 不整读，只做定长读取
      expect(r.truncated).toBe(true)
      expect(r.binary).toBe(false)
      expect(r.size).toBe(MAX_TEXT_SIZE * 2 + 1)
      expect(r.content.length).toBe(MAX_TEXT_SIZE)
    } finally {
      spy.mockRestore()
    }
  })

  it('create 文件/目录，rename 改名', async () => {
    await createEntry(path.join(tmp, 'f.ts'), false)
    expect(fs.existsSync(path.join(tmp, 'f.ts'))).toBe(true)
    await createEntry(path.join(tmp, 'd'), true)
    expect(fs.statSync(path.join(tmp, 'd')).isDirectory()).toBe(true)
    await renameEntry(tmp, 'f.ts', 'g.ts')
    expect(fs.existsSync(path.join(tmp, 'g.ts'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'f.ts'))).toBe(false)
  })

  it('delete 文件与目录（递归）', async () => {
    const f = path.join(tmp, 'x.ts')
    await writeFileEntry(f, 'x')
    await deleteEntry(f)
    expect(fs.existsSync(f)).toBe(false)
    const d = path.join(tmp, 'dir')
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(d, 'sub', 'a.js'), 'a')
    await deleteEntry(d)
    expect(fs.existsSync(d)).toBe(false)
  })
})

describe('file watcher', () => {
  let tmp: string
  let events: Array<{ workDir: string; relPath: string }>

  // getBus 是进程级单例，事件在 afterEach 移除监听，避免跨用例串扰
  function handler(ev: { workDir: string; relPath: string }): void {
    events.push(ev)
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-watch-'))
    events = []
    getBus().on('file:changed', handler)
  })

  afterEach(async () => {
    getBus().off('file:changed', handler)
    await stopWatch(tmp)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // 等 chokidar 完成初始化，避免写入落在初始扫描窗口内被 ignoreInitial 吞掉
  async function waitReady(): Promise<void> {
    await new Promise((r) => setTimeout(r, 500))
  }

  // 等待目标事件出现；覆盖 150ms 合帧延迟 + chokidar 抖动，timeout 放宽避免 flaky
  async function waitEvent(relPath: string): Promise<{ workDir: string; relPath: string }> {
    return vi.waitFor(() => {
      const hit = events.find((e) => e.workDir === tmp && e.relPath === relPath)
      if (!hit) throw new Error('未收到 file:changed 事件')
      return hit
    }, { timeout: 3000 })
  }

  it('修改文件触发 file:changed，relPath 用正斜杠', async () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'v1')
    startWatch(tmp)
    await waitReady()
    fs.writeFileSync(f, 'v2')
    const ev = await waitEvent('a.txt')
    expect(ev.workDir).toBe(tmp)
    expect(ev.relPath).toBe('a.txt')
  })

  it('忽略 node_modules 内的文件写入', async () => {
    const nm = path.join(tmp, 'node_modules')
    fs.mkdirSync(nm, { recursive: true })
    startWatch(tmp)
    await waitReady()
    // 先写一个普通文件确认 watcher 已生效
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'a')
    await waitEvent('keep.txt')
    // 向忽略目录写文件，不应产生任何 file:changed 事件
    fs.writeFileSync(path.join(nm, 'dep.js'), 'x')
    await new Promise((r) => setTimeout(r, 600))
    expect(events.some((e) => e.workDir === tmp && e.relPath.startsWith('node_modules'))).toBe(false)
  })

  it('stopWatch 后不再触发事件', async () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'v1')
    startWatch(tmp)
    await waitReady()
    fs.writeFileSync(f, 'v2')
    await waitEvent('a.txt') // 确认 watcher 已生效
    await stopWatch(tmp)
    const before = events.length
    fs.writeFileSync(f, 'v3')
    await new Promise((r) => setTimeout(r, 600))
    expect(events.length).toBe(before)
  })
})

describe('uniqueDestName', () => {
  let dest: string
  beforeEach(() => { dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-unique-')) })
  afterEach(() => { fs.rmSync(dest, { recursive: true, force: true }) })

  it('无冲突返回原名', () => {
    expect(uniqueDestName(dest, 'a.ts')).toBe('a.ts')
  })
  it('单次冲突加「- 副本」，扩展名保留', () => {
    fs.writeFileSync(path.join(dest, 'a.ts'), 'x')
    expect(uniqueDestName(dest, 'a.ts')).toBe('a - 副本.ts')
  })
  it('连续冲突递增 (2)', () => {
    fs.writeFileSync(path.join(dest, 'a.ts'), 'x')
    fs.writeFileSync(path.join(dest, 'a - 副本.ts'), 'x')
    expect(uniqueDestName(dest, 'a.ts')).toBe('a - 副本 (2).ts')
  })
  it('点开头文件整名当 stem', () => {
    fs.writeFileSync(path.join(dest, '.gitignore'), 'x')
    expect(uniqueDestName(dest, '.gitignore')).toBe('.gitignore - 副本')
  })
  it('目录无扩展名直接加后缀', () => {
    fs.mkdirSync(path.join(dest, 'src'))
    expect(uniqueDestName(dest, 'src')).toBe('src - 副本')
  })
})

describe('copyEntries', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-copy-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('copy 文件到目标目录，返回新 relPath，源保留', async () => {
    const srcDir = path.join(root, 'src'); fs.mkdirSync(srcDir)
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello')
    const destDir = path.join(root, 'dest'); fs.mkdirSync(destDir)
    const r = await copyEntries([path.join(srcDir, 'a.ts')], root, 'dest', 'copy')
    expect(r.failed).toEqual([])
    expect(r.ok).toEqual(['dest/a.ts'])
    expect(fs.readFileSync(path.join(destDir, 'a.ts'), 'utf8')).toBe('hello')
    expect(fs.existsSync(path.join(srcDir, 'a.ts'))).toBe(true)
  })

  it('copy 目标已同名：自动重命名不覆盖', async () => {
    const srcDir = path.join(root, 'src'); fs.mkdirSync(srcDir)
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'new')
    const destDir = path.join(root, 'dest'); fs.mkdirSync(destDir)
    fs.writeFileSync(path.join(destDir, 'a.ts'), 'old')
    const r = await copyEntries([path.join(srcDir, 'a.ts')], root, 'dest', 'copy')
    expect(r.ok).toEqual(['dest/a - 副本.ts'])
    expect(fs.readFileSync(path.join(destDir, 'a.ts'), 'utf8')).toBe('old')
    expect(fs.readFileSync(path.join(destDir, 'a - 副本.ts'), 'utf8')).toBe('new')
  })

  it('copy 目录递归（根下已有同名 → 副本）', async () => {
    const srcDir = path.join(root, 'lib'); fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'sub', 'b.js'), 'x')
    const r = await copyEntries([srcDir], root, '', 'copy')
    expect(r.failed).toEqual([])
    expect(r.ok).toEqual(['lib - 副本'])
    expect(fs.readFileSync(path.join(root, 'lib - 副本', 'sub', 'b.js'), 'utf8')).toBe('x')
    expect(fs.existsSync(path.join(root, 'lib', 'sub', 'b.js'))).toBe(true) // 源保留
  })

  it('move 跨目录改路径，move 同名也重命名不覆盖', async () => {
    const a = path.join(root, 'a'); fs.mkdirSync(a)
    const b = path.join(root, 'b'); fs.mkdirSync(b)
    fs.writeFileSync(path.join(a, 't.ts'), 'src')
    fs.writeFileSync(path.join(b, 't.ts'), 'dest')
    const r = await copyEntries([path.join(a, 't.ts')], root, 'b', 'move')
    expect(r.failed).toEqual([])
    expect(r.ok).toEqual(['b/t - 副本.ts'])
    expect(fs.existsSync(path.join(a, 't.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(b, 't.ts'), 'utf8')).toBe('dest')
    expect(fs.readFileSync(path.join(b, 't - 副本.ts'), 'utf8')).toBe('src')
  })

  it('move 同目录 = no-op，不产生副本', async () => {
    const a = path.join(root, 'a'); fs.mkdirSync(a)
    fs.writeFileSync(path.join(a, 't.ts'), 'x')
    const r = await copyEntries([path.join(a, 't.ts')], root, 'a', 'move')
    expect(r.failed).toEqual([])
    expect(r.ok).toEqual(['a/t.ts'])
    expect(fs.readdirSync(a)).toEqual(['t.ts'])
  })

  it('目标是源子目录：拒绝且源完好', async () => {
    const lib = path.join(root, 'lib'); fs.mkdirSync(path.join(lib, 'sub'), { recursive: true })
    const r = await copyEntries([lib], root, 'lib/sub', 'move')
    expect(r.ok).toEqual([])
    expect(r.failed[0].error).toContain('目标不能是源自身或其子目录')
    expect(fs.existsSync(path.join(lib, 'sub'))).toBe(true)
  })

  it('move 目标父目录=源自身：拒绝且源未被动', async () => {
    const a = path.join(root, 'a'); fs.mkdirSync(a)
    fs.writeFileSync(path.join(a, 't.ts'), 'x')
    // 源是目录 a，目标父目录也是 a —— 等于把 a 移进 a 自己
    const r = await copyEntries([a], root, 'a', 'move')
    expect(r.ok).toEqual([])
    expect(r.failed[0].error).toContain('目标不能是源自身或其子目录')
    expect(fs.readFileSync(path.join(a, 't.ts'), 'utf8')).toBe('x') // 源完好
    expect(fs.readdirSync(a)).toEqual(['t.ts']) // 没有产生任何新条目
  })

  it('move 目标父目录在源之下（a/ → a/b/）：拒绝且源未被动', async () => {
    const a = path.join(root, 'a'); fs.mkdirSync(a)
    fs.writeFileSync(path.join(a, 't.ts'), 'x')
    const r = await copyEntries([a], root, 'a/b', 'move')
    expect(r.ok).toEqual([])
    expect(r.failed[0].error).toContain('目标不能是源自身或其子目录')
    expect(fs.existsSync(path.join(a, 'b'))).toBe(false) // 目标未创建
    expect(fs.readFileSync(path.join(a, 't.ts'), 'utf8')).toBe('x') // 源完好
  })

  it('源不存在进 failed，错误文案含「源文件不存在」', async () => {
    const r = await copyEntries([path.join(root, 'ghost.ts')], root, '', 'copy')
    expect(r.ok).toEqual([])
    expect(r.failed[0].error).toContain('源文件不存在')
  })

  it('destParentRel 空串 = workDir 根', async () => {
    fs.writeFileSync(path.join(root, 'r.ts'), 'x')
    // 源在根下、目标也是根 —— 同目录 copy 产生副本
    const r = await copyEntries([path.join(root, 'r.ts')], root, '', 'copy')
    expect(r.ok).toEqual(['r - 副本.ts'])
  })
})

describe('FileNameW 编解码', () => {
  it('往返一致（多路径）', () => {
    const paths = ['G:/work/a.ts', 'G:/work/目录 b/c.ts']
    expect(parseFileNameW(buildFileNameW(paths))).toEqual(paths)
  })
  it('单路径', () => {
    expect(parseFileNameW(buildFileNameW(['D:/x.txt']))).toEqual(['D:/x.txt'])
  })
  it('空 buffer 返回空数组', () => {
    expect(parseFileNameW(Buffer.alloc(0))).toEqual([])
  })
})

describe('revealEntry', () => {
  it('把 resolveEntry 结果交给 show', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-reveal-'))
    const show = vi.fn()
    revealEntry(base, 'src/a.ts', show)
    expect(show).toHaveBeenCalledWith(path.join(base, 'src', 'a.ts'))
    fs.rmSync(base, { recursive: true, force: true })
  })
  it('越界路径直接抛错，不调用 show', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lynel-reveal-'))
    const show = vi.fn()
    expect(() => revealEntry(base, '../evil.ts', show)).toThrow(/越界/)
    expect(show).not.toHaveBeenCalled()
    fs.rmSync(base, { recursive: true, force: true })
  })
})
