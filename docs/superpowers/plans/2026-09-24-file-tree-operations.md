# 文件树基础文件操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复文件树 + 按钮总在根目录新建的缺陷，并补齐选中态、右键菜单（空白/目录/文件三上下文）、剪切复制粘贴、拖拽移动、Reveal in Explorer、F2/Delete 快捷键等 VSCode 风格基础文件操作。

**Architecture:** 状态（选中态、内部剪贴板、拖拽瞬态）收编进 `stores/files.ts`；右键菜单抽成数据驱动组件 `TreeContextMenu.vue`；主进程 `src/main/files.ts` 新增 `copyEntries`（copy/move、同名自动重命名、子孙目录校验）与 `file:copy` / `file:reveal` / `file:clipWrite` / `file:clipRead` 四个 IPC；渲染层新增纯函数 `utils/fileTree.ts`。同名冲突一律自动重命名，永不覆盖。

**Tech Stack:** Electron (ipcMain/ipcRenderer/contextBridge)、Vue 3 `<script setup>`、Pinia setup style、vitest（主进程 `tests/main/`，渲染层 `src/renderer` 下 jsdom + @vue/test-utils）、HTML5 Drag and Drop。

**Spec:** `docs/superpowers/specs/2026-09-24-file-tree-operations-design.md`

## Global Constraints

- 所有回复、代码注释、commit message 用简体中文。
- 每次 commit 前在仓库内设置 local git identity：`git config user.name "<name>"` / `git config user.email "<email>"`（本仓库已设 `walleliu1016` / `walleliu1016@users.noreply.github.com`，直接复用）。
- 一个 task 一个 commit，格式 `<type>: <subject>`（feat/fix/refactor/test/docs/chore）。
- commit 前必须全绿：`npm run test:main` 与 `cd src/renderer && npx vue-tsc --noEmit`；改渲染层时还要跑 `cd src/renderer && npx vitest run`。
- `useElectron.ts` 是唯一接触 `window.electronAPI` 的文件；其他文件一律 `import { X } from '../composables/useElectron'`。
- 图标统一 `@lucide/vue` 经 `components/Icon.vue`；**新增图标前必须在 Icon.vue `icons` 映射注册**（import 一行 + 映射一行），未注册键不得使用。
- 样式用 `styles/theme.css` CSS 变量（可用：`--bg-selected`、`--accent`、`--accent-soft-border`、`--bg-hover`、`--status-error` 等），不硬编码颜色。
- 错误返回 error / reject / toast，不抛未捕获异常；store 层管理失败一律 `pushToast({ level: 'error', source: 'file', message: ... })`。
- Pinia `ref<Record<K,V>>` 更新用整体 spread；`tree` / `expanded` / `clipboard` 等 ref 赋新引用（保持现有风格）。
- 不提交诊断文件（`diag-*.mjs`、`shot-*.png`）、构建产物。
- 主进程纯函数进 `src/main/files.ts`，测试镜像到 `tests/main/files.test.ts`。
- 同名冲突处理：**自动重命名（`name - 副本.ext`、`name - 副本 (2).ext`），永不覆盖**；移动同名也重命名。
- 多选、拖拽到 Lynel 外部、从桌面拖入、E2E、冲突对话框：**明确不做**（spec §明确不做）。

---

### Task 1: 主进程 copyEntries（复制/移动 + 自动重命名 + 安全校验）

**Files:**
- Modify: `src/main/files.ts`（在 `deleteEntry` 之后、watcher 区之前追加）
- Test: `tests/main/files.test.ts`

**Interfaces:**
- Consumes: `resolveEntry(workDir, relPath)`（已有，越界校验）。
- Produces（Task 2 依赖）:
  ```ts
  export function uniqueDestName(destDir: string, name: string): string
  // 目标目录内生成不冲突名：原名可用返回原名；否则 `stem - 副本.ext`、`stem - 副本 (2).ext`...（上限 999，超过抛错）
  // 点开头文件（.gitignore）整名当 stem；目录（无扩展名）同理

  export async function copyEntries(
    srcPaths: string[],
    destWorkDir: string,
    destParentRel: string,
    mode: 'copy' | 'move',
  ): Promise<{ ok: string[]; failed: { path: string; error: string }[] }>
  // ok = 相对 destWorkDir 的新 relPath 列表（正斜杠）
  // 逐个 try 不整体回滚；源不存在 → failed error `源文件不存在：${src}`
  // destDir = resolveEntry(destWorkDir, destParentRel)（空串 = workDir 根）
  // 目标是源自身或其子目录 → failed error `目标不能是源自身或其子目录`
  // move 且 path.dirname(src) === destDir（同目录拖拽）→ no-op，ok 返回原 relPath
  // copy: fs.cp(recursive)；move: fs.rename，catch code==='EXDEV' 回退 cp+rm
  ```

- [ ] **Step 1: 写失败测试**

在 `tests/main/files.test.ts` 顶部 import 行追加 `uniqueDestName, copyEntries`，文件末尾追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/files.test.ts`
Expected: FAIL，`uniqueDestName` / `copyEntries` 未导出（import 报错）。

- [ ] **Step 3: 实现**

在 `src/main/files.ts` 的 `deleteEntry` 函数之后追加：

```ts
/** 目标目录内生成不冲突文件名：原名 → `stem - 副本.ext` → `stem - 副本 (2).ext`...（永不覆盖） */
export function uniqueDestName(destDir: string, name: string): string {
  const exists = (n: string) => fs.existsSync(path.join(destDir, n));
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const first = `${stem} - 副本${ext}`;
  if (!exists(first)) return first;
  for (let i = 2; i <= 999; i++) {
    const cand = `${stem} - 副本 (${i})${ext}`;
    if (!exists(cand)) return cand;
  }
  throw new Error('同名副本过多');
}

export interface CopyEntriesResult {
  ok: string[];
  failed: { path: string; error: string }[];
}

/** 复制/移动多个源到 destWorkDir/destParentRel；逐个处理不整体回滚。
 *  同名自动重命名（含 move），目标为源自身或子目录时拒绝（防递归爆炸）。 */
export async function copyEntries(
  srcPaths: string[],
  destWorkDir: string,
  destParentRel: string,
  mode: 'copy' | 'move',
): Promise<CopyEntriesResult> {
  const ok: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const destDir = resolveEntry(destWorkDir, destParentRel);
  const relOf = (name: string) => (destParentRel ? `${destParentRel}/${name}` : name);
  for (const src of srcPaths) {
    try {
      const resolvedSrc = path.resolve(src);
      try {
        await fs.promises.lstat(resolvedSrc);
      } catch {
        throw new Error(`源文件不存在：${src}`);
      }
      if (destDir === resolvedSrc || destDir.startsWith(resolvedSrc + path.sep)) {
        throw new Error('目标不能是源自身或其子目录');
      }
      const base = path.basename(resolvedSrc);
      if (mode === 'move' && path.dirname(resolvedSrc) === destDir) {
        ok.push(relOf(base)); // 同目录移动 = no-op
        continue;
      }
      const name = uniqueDestName(destDir, base);
      const dest = path.join(destDir, name);
      if (mode === 'copy') {
        await fs.promises.cp(resolvedSrc, dest, { recursive: true });
      } else {
        try {
          await fs.promises.rename(resolvedSrc, dest);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === 'EXDEV') {
            await fs.promises.cp(resolvedSrc, dest, { recursive: true });
            await fs.promises.rm(resolvedSrc, { recursive: true, force: true });
          } else throw e;
        }
      }
      ok.push(relOf(name));
    } catch (e) {
      failed.push({ path: src, error: (e as Error)?.message ?? String(e) });
    }
  }
  return { ok, failed };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/files.test.ts`
Expected: PASS（原有用例 + 新增全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/main/files.ts tests/main/files.test.ts
git commit -m "feat: 主进程 copyEntries 复制/移动与同名自动重命名"
```

---

### Task 2: IPC 接线（file:copy / file:reveal / file:clipWrite / file:clipRead）+ preload + useElectron

**Files:**
- Modify: `src/main/files.ts`（`registerFilesIpc` 内 + 模块顶部 import）
- Modify: `src/main/preload.ts`（`fileUnwatch` 之后追加 4 个方法）
- Modify: `src/renderer/src/composables/useElectron.ts`（`FileChanged` 之后追加导出）
- Test: `tests/main/files.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `copyEntries(srcPaths, destWorkDir, destParentRel, mode)`。
- Produces（Task 4 依赖，useElectron 导出）:
  ```ts
  export interface FileCopyResult { ok: string[]; failed: { path: string; error: string }[] }
  export const FileCopy = (srcPaths: string[], destWorkDir: string, destParentRel: string, mode: 'copy' | 'move'): Promise<FileCopyResult>
  export const FileReveal = (workDir: string, relPath: string): Promise<{ ok: true }>
  export const FileClipWrite = (paths: string[]): Promise<{ ok: true }>
  export const FileClipRead = (): Promise<string[]>   // 主进程已过滤不存在的路径
  export const ClipboardWrite = (text: string)        // 已有，复制路径文本用它
  ```
  - preload 对应 `fileCopy` / `fileReveal` / `fileClipWrite` / `fileClipRead`。
  - IPC channel：`file:copy`、`file:reveal`、`file:clipWrite`、`file:clipRead`。
  - FileNameW 纯函数（可测）：
    ```ts
    export function buildFileNameW(paths: string[]): Buffer   // UTF-16LE，每路径 \0 结尾，整体再补 \0
    export function parseFileNameW(buf: Buffer): string[]     // utf16le split('\0') filter(Boolean)
    export function revealEntry(workDir: string, relPath: string, show: (p: string) => void): void
    // = show(resolveEntry(workDir, relPath))，show 注入便于单测
    ```

- [ ] **Step 1: 写失败测试**

`tests/main/files.test.ts` import 追加 `buildFileNameW, parseFileNameW, revealEntry`，并 `import { ipcMain } from 'electron'` 不需要（不测 handler 注册，与现有 `registerFilesIpc` 一致）。文件末尾追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/files.test.ts`
Expected: FAIL，`buildFileNameW` 未导出。

- [ ] **Step 3: 实现主进程**

`src/main/files.ts`：

1. 顶部 import 改为 `import { ipcMain, clipboard, shell } from 'electron';`
2. `copyEntries` 之后追加：

```ts
/** Windows 剪贴板文件列表格式：UTF-16LE，每路径 \0 结尾、整体补 \0 */
export function buildFileNameW(paths: string[]): Buffer {
  const chunks = paths.map((p) => Buffer.from(p + '\0', 'utf16le'));
  return Buffer.concat([...chunks, Buffer.from('\0', 'utf16le')]);
}

export function parseFileNameW(buf: Buffer): string[] {
  if (buf.length < 2) return [];
  return buf.toString('utf16le').split('\0').filter(Boolean);
}

/** 在系统资源管理器中显示并选中条目（show 注入便于测试） */
export function revealEntry(workDir: string, relPath: string, show: (p: string) => void): void {
  show(resolveEntry(workDir, relPath));
}
```

3. `registerFilesIpc()` 内 `file:unwatch` handler 之后追加：

```ts
ipcMain.handle('file:copy', async (_e, srcPaths: string[], destWorkDir: string, destParentRel: string, mode: 'copy' | 'move') =>
  copyEntries(srcPaths, destWorkDir, destParentRel, mode));

ipcMain.handle('file:reveal', (_e, workDir: string, relPath: string) => {
  revealEntry(workDir, relPath, (p) => shell.showItemInFolder(p));
  return { ok: true };
});

// 复制/剪切时同步写系统剪贴板：先写 \n 拼接的路径文本，win32 再写 FileNameW。
// 顺序有讲究：Electron 每次 write* 独立打开剪贴板（EmptyClipboard 后写入），
// 后写者胜 —— FileNameW 放最后，资源管理器外部粘贴才可用；
// writeBuffer 抛错时 text 仍在，即 spec 的「回退拼接文本」
ipcMain.handle('file:clipWrite', (_e, paths: string[]) => {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  if (!list.length) return { ok: true };
  clipboard.writeText(list.join('\n'));
  if (process.platform === 'win32') {
    try { clipboard.writeBuffer('FileNameW', buildFileNameW(list)); } catch { /* text 兜底已写 */ }
  }
  return { ok: true };
});

// 读系统剪贴板路径：先 FileNameW 再 text 按行回退；过滤不存在的源，
// 渲染层粘贴前无需再发 IPC 校验
ipcMain.handle('file:clipRead', () => {
  let list: string[] = [];
  if (process.platform === 'win32') {
    try { list = parseFileNameW(clipboard.readBuffer('FileNameW')); } catch { /* 回退 text */ }
  }
  if (!list.length) {
    list = (clipboard.readText() || '').split(/\r?\n/)
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return list.filter((p) => { try { fs.statSync(p); return true; } catch { return false; } });
});
```

`src/main/preload.ts`：`fileUnwatch` 之后追加：

```ts
fileCopy: (srcPaths: string[], destWorkDir: string, destParentRel: string, mode: 'copy' | 'move') =>
  ipcRenderer.invoke('file:copy', srcPaths, destWorkDir, destParentRel, mode),
fileReveal: (workDir: string, relPath: string) => ipcRenderer.invoke('file:reveal', workDir, relPath),
fileClipWrite: (paths: string[]) => ipcRenderer.invoke('file:clipWrite', paths),
fileClipRead: () => ipcRenderer.invoke('file:clipRead') as Promise<string[]>,
```

`src/renderer/src/composables/useElectron.ts`：`FileChanged` 之后追加：

```ts
export interface FileCopyResult { ok: string[]; failed: { path: string; error: string }[] }
export const FileCopy = (srcPaths: string[], destWorkDir: string, destParentRel: string, mode: 'copy' | 'move') =>
  api().fileCopy(srcPaths, destWorkDir, destParentRel, mode) as Promise<FileCopyResult>;
export const FileReveal = (workDir: string, relPath: string) => api().fileReveal(workDir, relPath);
export const FileClipWrite = (paths: string[]) => api().fileClipWrite(paths);
export const FileClipRead = (): Promise<string[]> => api().fileClipRead();
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/main/files.test.ts` → PASS
Run: `cd src/renderer && npx vue-tsc --noEmit` → PASS（preload 的 `ElectronAPI = typeof api` 自动带上新方法）。

- [ ] **Step 5: Commit**

```bash
git add src/main/files.ts src/main/preload.ts src/renderer/src/composables/useElectron.ts tests/main/files.test.ts
git commit -m "feat: 文件复制/显示/剪贴板路径 IPC 接线"
```

---

### Task 3: 渲染层纯函数 utils/fileTree.ts

**Files:**
- Create: `src/renderer/src/utils/fileTree.ts`
- Test: `src/renderer/src/utils/fileTree.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces（Task 4/5/6 依赖）:
  ```ts
  export function parentOf(rel: string): string
  // 'a/b/c.ts' → 'a/b'；'a.ts' → ''；'' → ''
  export function baseName(rel: string): string
  // 'a/b/c.ts' → 'c.ts'；'a.ts' → 'a.ts'
  export function resolveCreateTarget(selected: string | null, isDir: boolean | null): string
  // selected null → ''；isDir true → selected；否则 parentOf(selected)（isDir null = 条目已不存在，当文件走父目录）
  export function absJoin(base: string, rel: string): string
  // 'G:\work\repo' + 'src/a.ts' → 'G:\work\repo/src/a.ts'（去 base 尾部分隔符 + '/' 连接；Node fs 接受混合分隔符）
  export interface MenuTarget { kind: 'blank' | 'dir' | 'file'; relPath: string; name: string; parentRel: string }
  ```

- [ ] **Step 1: 写失败测试**

创建 `src/renderer/src/utils/fileTree.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/utils/fileTree.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `src/renderer/src/utils/fileTree.ts`：

```ts
/** 文件树纯路径工具：主/渲染层不能互 import，这里只服务渲染层 */

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

/** + 按钮目标目录：选中目录→自身，选中文件→父目录，无选中→根 */
export function resolveCreateTarget(selected: string | null, isDir: boolean | null): string {
  if (!selected) return ''
  if (isDir === true) return selected
  return parentOf(selected)
}

/** workDir(可能带 \) + relPath(正斜杠) → 可交给 Node fs 的绝对路径 */
export function absJoin(base: string, rel: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return rel ? `${trimmed}/${rel}` : trimmed
}

export interface MenuTarget {
  kind: 'blank' | 'dir' | 'file'
  relPath: string
  name: string
  parentRel: string
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/renderer && npx vitest run src/utils/fileTree.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/utils/fileTree.ts src/renderer/src/utils/fileTree.test.ts
git commit -m "feat: 文件树纯路径工具 parentOf/resolveCreateTarget/absJoin"
```

---

### Task 4: store 选中态 + 内部剪贴板 + 动作集

**Files:**
- Modify: `src/renderer/src/stores/files.ts`
- Modify mock（补新导出，缺一个就会报 "No 'X' export is defined on the mock"）:
  - `src/renderer/src/stores/files.test.ts`
  - `src/renderer/src/components/code/CodeView.test.ts`
  - `src/renderer/src/components/code/RightWorkspacePane.test.ts`
  - （以 `grep -rl "useFilesStore" src/renderer/src --include=*.test.ts` 结果为准，逐一补齐）
- Test: `src/renderer/src/stores/files.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `FileCopy` / `FileReveal` / `FileClipWrite` / `FileClipRead` / `ClipboardWrite`（useElectron）；Task 3 的 `parentOf` / `absJoin`。
- Produces（Task 5/6 依赖）:
  ```ts
  // state
  selectedRelPath: Ref<string | null>
  createAtRequest: Ref<number>            // 取代 rootCreateRequest（+ 按钮 ++ 触发）
  // 注意：rootCreateRequest 本 task 暂保留不删 —— FileTree/CodeView 的引用在 Task 6 才切换，
  // 此处删除会让 vue-tsc 在 Task 4 结束时失败。Task 6 随引用切换一并删除。
  clipboard: Ref<{ op: 'cut' | 'copy'; paths: string[] } | null>  // 绝对路径；切会话保留
  dragRel: Ref<string | null>             // 拖拽瞬态：源 relPath
  dropTargetRel: Ref<string | null>       // 拖拽瞬态：落点目录 relPath
  // actions
  select(rel: string | null): void
  entryIsDir(rel: string): boolean | null // 从 tree 查；查不到 → null
  setClipboard(relPath: string, op: 'cut' | 'copy'): Promise<void>   // 内部剪贴板 + FileClipWrite 同步系统
  pasteInto(destParentRel: string): Promise<void>
  moveEntry(srcRel: string, destParentRel: string): Promise<void>    // 拖拽落点
  revealEntry(relPath: string): Promise<void>
  copyPath(relPath: string, absolute: boolean): Promise<void>        // 复制路径/相对路径（ClipboardWrite）
  collapseAll(): void
  refreshAll(): Promise<void>             // CodeView.onRefresh 迁入（DRY，菜单「刷新」共用）
  ```
  - `pasteInto`：内部剪贴板空时 `FileClipRead()` 回退；仍空 → `pushToast({ level: 'warn', source: 'file', message: '剪贴板中的源文件不存在或没有可粘贴的路径' })` 且不发 copy IPC；成功（`ok.length > 0`）后清 `clipboard`、展开并刷新目标目录、`selectedRelPath = ok[0]`；`failed` 非空 → error toast（文案含首条 error）。
  - `moveEntry`：`FileCopy([abs], wd, destParentRel, 'move')`；成功刷新源父目录 + 目标目录并选中 `ok[0]`（与 applyCopyResult 一致，不判断原选中）；失败 error toast `移动失败：...`。
  - 生命周期：`setSession` 重置 `selectedRelPath = null`、`createAtRequest = 0`、`dragRel/dropTargetRel = null`（**clipboard 保留**）；`renameEntry` 中 selected 等于 oldRel 时迁移到 newRel；`deleteEntry` 中 selected 等于 relPath 时置 null。

- [ ] **Step 1: 补三个 mock + 写失败 store 测试**

三个 mock 文件的 `vi.mock(...useElectron...)` 工厂内 `FileChanged` 之后统一追加：

```ts
FileCopy: vi.fn(() => Promise.resolve({ ok: [], failed: [] })),
FileReveal: vi.fn(() => Promise.resolve({ ok: true })),
FileClipWrite: vi.fn(() => Promise.resolve({ ok: true })),
FileClipRead: vi.fn(() => Promise.resolve([])),
ClipboardWrite: vi.fn(() => Promise.resolve()),
```

`src/renderer/src/stores/files.test.ts`：顶部 mock 区追加 `vi.mock('../composables/useToast', () => ({ pushToast: vi.fn() }))`，import 追加：

```ts
import { pushToast } from '../composables/useToast'
import { FileCopy, FileClipWrite, FileClipRead } from '../composables/useElectron'
```

文件末尾追加：

```ts
describe('files store · 选中态', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('setSession 重置选中', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('src/a.ts')
    expect(store.selectedRelPath).toBe('src/a.ts')
    await store.setSession('s2', '/other')
    expect(store.selectedRelPath).toBe(null)
  })

  it('clipboard 跨会话保留（切会话不清）', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('a.ts', 'copy')
    await store.setSession('s2', '/other')
    expect(store.clipboard?.op).toBe('copy')
  })

  it('renameEntry 把选中迁移到新 relPath', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('src/a.ts')
    await store.renameEntry('src/a.ts', 'b.ts')
    expect(store.selectedRelPath).toBe('src/b.ts')
  })

  it('deleteEntry 删除选中项时清空选中', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('a.ts')
    await store.deleteEntry('a.ts')
    expect(store.selectedRelPath).toBe(null)
  })
})

describe('files store · 剪贴板动作', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('setClipboard 记绝对路径并同步系统剪贴板', async () => {
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('src/a.ts', 'cut')
    expect(store.clipboard).toEqual({ op: 'cut', paths: ['/repo/src/a.ts'] })
    expect(FileClipWrite).toHaveBeenCalledWith(['/repo/src/a.ts'])
  })

  it('copyPath 绝对/相对走 ClipboardWrite', async () => {
    const { ClipboardWrite } = await import('../composables/useElectron')
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.copyPath('src/a.ts', true)
    expect(ClipboardWrite).toHaveBeenCalledWith('/repo/src/a.ts')
    await store.copyPath('src/a.ts', false)
    expect(ClipboardWrite).toHaveBeenCalledWith('src/a.ts')
  })

  it('pasteInto 用内部剪贴板 copy 粘贴：成功后清剪贴板、选中第一个新条目、刷新目标', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('src/a.ts', 'copy')
    await store.pasteInto('dest')
    expect(FileCopy).toHaveBeenCalledWith(['/repo/src/a.ts'], '/repo', 'dest', 'copy')
    expect(store.clipboard).toBe(null)
    expect(store.selectedRelPath).toBe('dest/a.ts')
  })

  it('cut 粘贴走 move 模式', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('src/a.ts', 'cut')
    await store.pasteInto('dest')
    expect(FileCopy).toHaveBeenCalledWith(['/repo/src/a.ts'], '/repo', 'dest', 'move')
  })

  it('内部剪贴板空时回退 FileClipRead；都空则 toast 且不发 copy', async () => {
    vi.mocked(FileClipRead).mockResolvedValueOnce([])
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.pasteInto('')
    expect(FileCopy).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', source: 'file' }))
  })

  it('FileClipRead 回退成功：用读到的路径 copy', async () => {
    vi.mocked(FileClipRead).mockResolvedValueOnce(['D:/x/y.ts'])
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['y.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.pasteInto('')
    expect(FileCopy).toHaveBeenCalledWith(['D:/x/y.ts'], '/repo', '', 'copy')
  })

  it('部分失败：toast error，成功的条目仍生效', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [{ path: '/x/g.ts', error: '源文件不存在：/x/g.ts' }] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    await store.setClipboard('a.ts', 'copy')
    await store.pasteInto('dest')
    expect(store.selectedRelPath).toBe('dest/a.ts')
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
  })

  it('moveEntry 刷新源父与目标目录并迁移选中', async () => {
    vi.mocked(FileCopy).mockResolvedValueOnce({ ok: ['dest/a.ts'], failed: [] })
    const store = useFilesStore()
    await store.setSession('s1', '/repo')
    store.select('src/a.ts')
    await store.moveEntry('src/a.ts', 'dest')
    expect(FileCopy).toHaveBeenCalledWith(['/repo/src/a.ts'], '/repo', 'dest', 'move')
    expect(store.selectedRelPath).toBe('dest/a.ts')
  })
})
```

注意：`FileCopy`/`pushToast` 等 mock 在 `beforeEach` 里 `vi.clearAllMocks()` 以免串扰（沿用文件内现有清理惯例，没有就在本 describe 的 beforeEach 加 `vi.clearAllMocks()`）；`vi.spyOn(window, 'confirm')` 的还原沿用 `vi.restoreAllMocks()` 或在 afterEach 显式 restore。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/stores/files.test.ts`
Expected: FAIL，`select` / `clipboard` / `createAtRequest` 等不存在。

- [ ] **Step 3: 实现 store**

`src/renderer/src/stores/files.ts`：

1. import 区追加：

```ts
import { pushToast } from '../composables/useToast'   // 已有则跳过
import { FileCopy, FileReveal, FileClipWrite, FileClipRead, ClipboardWrite } from '../composables/useElectron'
import { parentOf, absJoin } from '../utils/fileTree'   // resolveCreateTarget 在 FileTree 用，store 不导入
```

2. `rootCreateRequest` 声明**下方追加**（不删旧声明，Task 6 切换引用后再删）：

```ts
/** 工具条「新建文件」请求计数：+1 触发树按选中态弹行内输入（接替 rootCreateRequest，
 *  旧实现硬编码根目录，现跟随 selectedRelPath 解析目标） */
const createAtRequest = ref(0)
/** 树选中项（单选；多选不做）。点击行设置，setSession 重置，rename/delete 迁移或清除 */
const selectedRelPath = ref<string | null>(null)
/** 应用内文件剪贴板：绝对路径列表。切会话保留（跨会话复制是合理场景） */
const clipboard = ref<{ op: 'cut' | 'copy'; paths: string[] } | null>(null)
/** 拖拽瞬态：源 relPath / 落点目录 relPath（null = 未在拖） */
const dragRel = ref<string | null>(null)
const dropTargetRel = ref<string | null>(null)
```

3. `setSession` 中 `rootCreateRequest.value = 0` 一行**之后追加**：

```ts
createAtRequest.value = 0
selectedRelPath.value = null
dragRel.value = null
dropTargetRel.value = null
// clipboard 刻意不清：跨会话粘贴
```

4. `renameEntry` 成功分支（`openFiles` 迁移处）追加：

```ts
if (selectedRelPath.value === oldRel) selectedRelPath.value = newRel
```

5. `deleteEntry` 成功分支（`clearDraft` 之后）追加：

```ts
if (selectedRelPath.value === relPath) selectedRelPath.value = null
```

6. `deleteEntry` 之后追加动作集：

```ts
/** 设置选中项（null 取消选中） */
function select(rel: string | null) {
  selectedRelPath.value = rel
}

/** 从已加载的 tree 判断条目是否目录；查不到（未加载/已删除）返回 null */
function entryIsDir(rel: string): boolean | null {
  const parent = parentOf(rel)
  const name = rel.slice(parent ? parent.length + 1 : 0)
  const e = tree.value[parent]?.find((x) => x.name === name)
  return e ? e.isDir : null
}

/** 复制/剪切：写内部剪贴板并同步系统剪贴板（外部粘贴依赖） */
async function setClipboard(relPath: string, op: 'cut' | 'copy') {
  const wd = workDir.value
  if (!wd || !relPath) return
  const paths = [absJoin(wd, relPath)]
  clipboard.value = { op, paths }
  await FileClipWrite(paths).catch(() => {}) // 系统剪贴板失败不阻塞内部粘贴
}

/** 复制路径（绝对）/ 复制相对路径 → 系统剪贴板文本 */
async function copyPath(relPath: string, absolute: boolean) {
  const wd = workDir.value
  if (!wd) return
  try {
    await ClipboardWrite(absolute ? absJoin(wd, relPath) : relPath)
  } catch (e: any) {
    pushToast({ level: 'error', source: 'file', message: `复制路径失败：${e?.message ?? e}` })
  }
}

async function applyCopyResult(
  r: { ok: string[]; failed: { path: string; error: string }[] },
  destParentRel: string,
  failLabel: string,
) {
  if (r.ok.length) {
    if (destParentRel && !expanded.value.has(destParentRel)) {
      expanded.value = new Set([...expanded.value, destParentRel])
    }
    await loadDir(destParentRel)
    selectedRelPath.value = r.ok[0]
  }
  if (r.failed.length) {
    pushToast({ level: 'error', source: 'file', message: `${failLabel}：${r.failed[0].error}` })
  }
}

/** 粘贴到 destParentRel（菜单上下文决定：dir=自身 / file=父 / blank=根）。
 *  内部剪贴板优先，空则回退系统剪贴板路径；成功（有 ok）后清内部剪贴板。 */
async function pasteInto(destParentRel: string) {
  const wd = workDir.value
  if (!wd) return
  let paths = clipboard.value?.paths ?? []
  const op = clipboard.value?.op ?? 'copy'
  if (!paths.length) {
    paths = await FileClipRead().catch(() => [])
    if (!paths.length) {
      pushToast({ level: 'warn', source: 'file', message: '剪贴板中的源文件不存在或没有可粘贴的路径' })
      return
    }
  }
  try {
    const r = await FileCopy(paths, wd, destParentRel, op === 'cut' ? 'move' : 'copy')
    if (r.ok.length) clipboard.value = null
    await applyCopyResult(r, destParentRel, '粘贴失败')
  } catch (e: any) {
    pushToast({ level: 'error', source: 'file', message: `粘贴失败：${e?.message ?? e}` })
  }
}

/** 拖拽落点移动（安全校验在主进程 copyEntries，此处只透传结果） */
async function moveEntry(srcRel: string, destParentRel: string) {
  const wd = workDir.value
  if (!wd || !srcRel) return
  const srcParent = parentOf(srcRel)
  try {
    const r = await FileCopy([absJoin(wd, srcRel)], wd, destParentRel, 'move')
    if (r.ok.length) {
      await loadDir(srcParent)
    }
    await applyCopyResult(r, destParentRel, '移动失败')
  } catch (e: any) {
    pushToast({ level: 'error', source: 'file', message: `移动失败：${e?.message ?? e}` })
  }
}

/** 系统资源管理器中显示 */
async function revealEntry(relPath: string) {
  const wd = workDir.value
  if (!wd) return
  try {
    await FileReveal(wd, relPath)
  } catch (e: any) {
    pushToast({ level: 'error', source: 'file', message: `在资源管理器中显示失败：${e?.message ?? e}` })
  }
}

/** 全部折叠（菜单「全部折叠」） */
function collapseAll() {
  expanded.value = new Set()
}

/** 刷新根 + 所有已展开目录（工具条与菜单「刷新」共用） */
async function refreshAll() {
  const dirs = new Set([''])
  for (const d of expanded.value) dirs.add(d)
  await Promise.all(Array.from(dirs).map((d) => loadDir(d).catch(() => {})))
}
```

7. `resolveCreateTarget` 的调用放在 FileTree（Task 6），store 只提供状态与 `entryIsDir` 查询。
8. return 对象追加：`createAtRequest, selectedRelPath, clipboard, dragRel, dropTargetRel, select, entryIsDir, setClipboard, copyPath, pasteInto, moveEntry, revealEntry, collapseAll, refreshAll`；**保留 `rootCreateRequest`**（Task 6 切换 FileTree/CodeView 引用后才删除）。

- [ ] **Step 4: 跑渲染层测试**

Run: `cd src/renderer && npx vitest run`
Expected: PASS（新用例 + 三个补过 mock 的旧文件；若其他文件报缺导出，同样补 mock 后重跑）。

- [ ] **Step 5: 类型检查 + Commit**

Run: `cd src/renderer && npx vue-tsc --noEmit` → PASS

```bash
git add src/renderer/src/stores/files.ts src/renderer/src/stores/files.test.ts src/renderer/src/components/code/CodeView.test.ts src/renderer/src/components/code/RightWorkspacePane.test.ts
git commit -m "feat: 文件树选中态与内部剪贴板 store 动作"
```

（若 Step 4 补了其他 test 的 mock，一并 add。）

---

### Task 5: Icon 注册 + TreeContextMenu.vue 菜单组件

**Files:**
- Modify: `src/renderer/src/components/Icon.vue`（import 区 + `icons` 映射）
- Create: `src/renderer/src/components/code/TreeContextMenu.vue`
- Test: `src/renderer/src/components/code/TreeContextMenu.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `MenuTarget` 类型。
- Produces（Task 6 依赖）:
  ```ts
  // props
  { target: MenuTarget; x: number; y: number; showPaste: boolean }  // showPaste：2026-09-28 修复轮已删（paste 改为始终渲染，可见性由 store pasteInto 三级回退兜底）
  // emits
  (e: 'action', action: string, target: MenuTarget): void
  // action ∈ 'new-file'|'new-folder'|'open'|'copy-path'|'copy-relpath'|'copy'|'cut'|'paste'|'rename'|'reveal'|'delete'|'collapse-all'|'refresh'
  (e: 'close'): void   // 点外部 / document contextmenu
  ```
  - 新注册图标键：`file-plus`(FilePlus)、`folder-plus`(FolderPlus)、`link`(Link)、`scissors`(Scissors)、`clipboard-paste`(ClipboardPaste)、`eye`(Eye)、`chevrons-down-up`(ChevronsDownUp)。已验证 `@lucide/vue` 均导出。
  - 菜单项（spec §第 2 节）：
    - blank：新建文件、新建文件夹 ── 全部折叠、刷新
    - dir：新建文件、新建文件夹 ── 复制路径、复制相对路径 ── 复制、剪切、paste* ── 重命名、在资源管理器中显示、删除(danger)
    - file：打开 ──（同 dir 的 2~5 组）
    - \* `showPaste=false` 时隐藏 paste（无分隔线残留）（2026-09-28 修复轮已删：paste 改为始终渲染，可见性由 store pasteInto 三级回退兜底）

- [ ] **Step 1: Icon 注册（先行，组件依赖）**

`src/renderer/src/components/Icon.vue`：

1. import 列表按字母序插入 7 个：`ChevronsDownUp`（`ChevronUp` 旁）、`ClipboardPaste`（`Clock` 旁）、`Eye`（`Expand` 旁）、`FilePlus`（`FileCode` 旁）、`FolderPlus`（`FolderOpen` 旁）、`Link`（`Link2Off` 旁）、`Scissors`（`Search` 旁）。
2. `icons` 映射按现有键序插入：

```ts
'chevrons-down-up': ChevronsDownUp,
'clipboard-paste': ClipboardPaste,
eye: Eye,
'file-plus': FilePlus,
'folder-plus': FolderPlus,
link: Link,
scissors: Scissors,
```

- [ ] **Step 2: 写失败组件测试**

创建 `src/renderer/src/components/code/TreeContextMenu.test.ts`：

```ts
import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, afterEach } from 'vitest'
import TreeContextMenu from './TreeContextMenu.vue'
import type { MenuTarget } from '../../utils/fileTree'

// Icon stub 渲染成 <i> 而非 <span>：labels() 用 `.menu-item span` 取文案，
// stub 若也是 span 会混进空字符串导致 toEqual 失败
vi.mock('../Icon.vue', () => ({ default: { name: 'IconStub', props: ['name', 'size'], template: '<i />' } }))

const blank: MenuTarget = { kind: 'blank', relPath: '', name: '', parentRel: '' }
const dir: MenuTarget = { kind: 'dir', relPath: 'src', name: 'src', parentRel: '' }
const file: MenuTarget = { kind: 'file', relPath: 'src/a.ts', name: 'a.ts', parentRel: 'src' }

function labels(w: ReturnType<typeof mount>): string[] {
  return w.findAll('.menu-item span').map((x) => x.text())
}

describe('TreeContextMenu', () => {
  // 2026-09-28 修复轮：showPaste prop 已删（paste 始终渲染，可见性由 store pasteInto 三级回退兜底），
  // 下列用例中的 showPaste 参数为历史计划记录，实际组件 prop 已不存在
  afterEach(() => { vi.restoreAllMocks() })

  it('blank 上下文：新建两项 + 折叠/刷新，无复制粘贴', () => {
    const w = mount(TreeContextMenu, { props: { target: blank, x: 0, y: 0, showPaste: false } })
    expect(labels(w)).toEqual(['新建文件', '新建文件夹', '全部折叠', '刷新'])
  })

  it('dir 上下文：含新建/路径/剪贴板/管理项，showPaste=false 时无粘贴', () => {
    const w = mount(TreeContextMenu, { props: { target: dir, x: 0, y: 0, showPaste: false } })
    const l = labels(w)
    expect(l).toContain('新建文件夹')
    expect(l).toContain('复制相对路径')
    expect(l).toContain('剪切')
    expect(l).toContain('在资源管理器中显示')
    expect(l).not.toContain('粘贴')
  })

  it('file 上下文：首项是打开，无新建项', () => {
    const w = mount(TreeContextMenu, { props: { target: file, x: 0, y: 0, showPaste: true } })
    const l = labels(w)
    expect(l[0]).toBe('打开')
    expect(l).not.toContain('新建文件')
    expect(l).toContain('粘贴')
  })

  it('点击菜单项 emit action + target，点删除项带 danger 样式', async () => {
    const w = mount(TreeContextMenu, { props: { target: file, x: 0, y: 0, showPaste: false } })
    const rename = w.findAll('.menu-item').find((i) => i.text().includes('重命名'))!
    await rename.trigger('click')
    expect(w.emitted('action')?.[0]).toEqual(['rename', file])
    const del = w.findAll('.menu-item').find((i) => i.text().includes('删除'))!
    expect(del.classes()).toContain('danger')
  })

  it('视口右缘收拢：x 贴近 innerWidth 时样式不溢出', () => {
    const w = mount(TreeContextMenu, {
      props: { target: dir, x: window.innerWidth - 1, y: window.innerHeight - 1, showPaste: false },
    })
    const left = parseInt(w.find('.ctx-menu').attributes('style')!.match(/left:\s*(-?\d+)px/)![1], 10)
    expect(left).toBeLessThanOrEqual(window.innerWidth - 240)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd src/renderer && npx vitest run src/components/code/TreeContextMenu.test.ts`
Expected: FAIL，组件不存在。

- [ ] **Step 4: 实现组件**

创建 `src/renderer/src/components/code/TreeContextMenu.vue`：

```vue
<script lang="ts">
export interface MenuNode {
  kind: 'item' | 'sep'
  action?: string
  label?: string
  icon?: string
  danger?: boolean
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '../Icon.vue'
import type { MenuTarget } from '../../utils/fileTree'

const props = defineProps<{
  target: MenuTarget
  x: number
  y: number
  /** 内部剪贴板非空时显示「粘贴」（空则隐藏而非 disabled）（2026-09-28 修复轮已删：paste 改为始终渲染，可见性由 store pasteInto 三级回退兜底） */
  showPaste: boolean
}>()
const emit = defineEmits<{
  (e: 'action', action: string, target: MenuTarget): void
  (e: 'close'): void
}>()

/** 三种上下文的菜单结构（数据驱动，加菜单项只改这里） */
const nodes = computed<MenuNode[]>(() => {
  const t = props.target
  const sep: MenuNode = { kind: 'sep' }
  const tail: MenuNode[] = [
    sep,
    { kind: 'item', action: 'copy-path', label: '复制路径', icon: 'link' },
    { kind: 'item', action: 'copy-relpath', label: '复制相对路径', icon: 'link' },
    sep,
    { kind: 'item', action: 'copy', label: '复制', icon: 'copy' },
    { kind: 'item', action: 'cut', label: '剪切', icon: 'scissors' },
    ...(props.showPaste ? [{ kind: 'item', action: 'paste', label: '粘贴', icon: 'clipboard-paste' } as MenuNode] : []), // 2026-09-28 修复轮已删 showPaste 三元：paste 始终渲染，可见性由 store pasteInto 三级回退兜底
    sep,
    { kind: 'item', action: 'rename', label: '重命名', icon: 'pencil' },
    { kind: 'item', action: 'reveal', label: '在资源管理器中显示', icon: 'eye' },
    { kind: 'item', action: 'delete', label: '删除', icon: 'trash', danger: true },
  ]
  if (t.kind === 'blank') {
    return [
      { kind: 'item', action: 'new-file', label: '新建文件', icon: 'file-plus' },
      { kind: 'item', action: 'new-folder', label: '新建文件夹', icon: 'folder-plus' },
      sep,
      { kind: 'item', action: 'collapse-all', label: '全部折叠', icon: 'chevrons-down-up' },
      { kind: 'item', action: 'refresh', label: '刷新', icon: 'refresh-cw' },
    ]
  }
  if (t.kind === 'file') {
    return [
      { kind: 'item', action: 'open', label: '打开', icon: 'file-text' },
      ...tail,
    ]
  }
  return [
    { kind: 'item', action: 'new-file', label: '新建文件', icon: 'file-plus' },
    { kind: 'item', action: 'new-folder', label: '新建文件夹', icon: 'folder-plus' },
    ...tail,
  ]
})

/** 视口右/下缘收拢（菜单实际宽度按 240 估） */
const style = computed(() => ({
  left: `${Math.min(props.x, window.innerWidth - 240)}px`,
  top: `${Math.min(props.y, window.innerHeight - 260)}px`,
}))

function onItemClick(action?: string) {
  if (!action) return
  emit('action', action, props.target)
  emit('close')
}

// 点菜单外 / 别处右键 → 关闭。组件只在菜单打开时挂载（父级 v-if），
// mounted/unmounted 天然对应开关
function onDocClick(e: MouseEvent) {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) emit('close')
}
function onDocCtx() {
  emit('close')
}
const menuEl = ref<HTMLElement | null>(null)
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('contextmenu', onDocCtx)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('contextmenu', onDocCtx)
})
</script>

<template>
  <div ref="menuEl" class="ctx-menu" :style="style" @click.stop @contextmenu.prevent.stop>
    <template v-for="(n, i) in nodes" :key="i">
      <div v-if="n.kind === 'sep'" class="menu-sep" />
      <div
        v-else
        class="menu-item"
        :class="{ danger: n.danger }"
        @click="onItemClick(n.action)"
      >
        <Icon :name="n.icon!" :size="13" />
        <span>{{ n.label }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-panel);
}
.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
  cursor: pointer;
}
.menu-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.menu-item.danger { color: var(--status-error); }
.menu-item.danger:hover { background: var(--status-error-soft); }
</style>
```

注意：现有 `FileTree.vue` 里 `.ctx-menu` / `.menu-item` / `.menu-sep` 样式与 document 监听在 Task 6 迁走后删除；本组件先自带动画需求无（用户系统关闭动画，见 memory reduced-motion-env —— 不加过渡动画）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src/renderer && npx vitest run src/components/code/TreeContextMenu.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Icon.vue src/renderer/src/components/code/TreeContextMenu.vue src/renderer/src/components/code/TreeContextMenu.test.ts
git commit -m "feat: 文件树右键菜单组件与七个新图标注册"
```

---

### Task 6: FileTree 接线（选中态、三上下文右键、+ 按钮修复、菜单分发）

**Files:**
- Modify: `src/renderer/src/components/code/FileTree.vue`
- Modify: `src/renderer/src/components/code/CodeView.vue`（`onNewFile` / `onRefresh`）
- Modify: `src/renderer/src/stores/files.ts`（删除已无引用的 `rootCreateRequest`：声明、`setSession` 重置行、return 行）
- Test: 无新增组件测试（FileTree 递归 + provide 结构无既有测试基建；以 store/menu 单测 + vue-tsc + 手动验收覆盖）

**Interfaces:**
- Consumes: Task 3 `MenuTarget` / `parentOf` / `baseName` / `resolveCreateTarget`；Task 4 store 全部新动作；Task 5 `TreeContextMenu`。
- Produces: 修复后的行为（spec §第 1、2 节）—— + 按钮按选中态解析目标目录；行上/空白右键弹三态菜单；点击行设置选中并高亮。

- [ ] **Step 1: FileTree.vue script 改造**

1. import 追加（`MenuNode` 不需要，只 import 默认组件）：

```ts
import TreeContextMenu from './TreeContextMenu.vue'
import { parentOf, baseName, absJoin, resolveCreateTarget, type MenuTarget } from '../../utils/fileTree'
```

2. 顶层 `MenuState` 接口替换为：

```ts
interface MenuState {
  x: number
  y: number
  target: MenuTarget
}
```

3. `onRowClick` 中 `if (editing.value) return` 之后、分派前加 `store.select(entryRel(entry))`：

```ts
function onRowClick(entry: TreeEntry) {
  if (editing.value) return // 编辑态下避免误触
  const rel = entryRel(entry)
  store.select(rel)
  if (entry.isDir) store.toggleExpand(rel, true)
  else store.openFile(rel)
}
```

4. `openMenu` 替换为：

```ts
function openMenu(e: MouseEvent, entry: TreeEntry) {
  // fixed 定位浮层；视口收拢交给 TreeContextMenu
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    target: {
      kind: entry.isDir ? 'dir' : 'file',
      relPath: entryRel(entry),
      name: entry.name,
      parentRel: props.relPath,
    },
  }
}

/** 空白处右键（根容器）：目标 = 根。行上已 .stop 不会冒泡到这里 */
function openBlankMenu(e: MouseEvent) {
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    target: { kind: 'blank', relPath: '', name: '', parentRel: '' },
  }
}
```

5. 菜单动作函数区（`menuNewFile` 等 4 个）整体替换为统一 `onMenuAction`：

```ts
/** 菜单动作分发：目标目录语义 dir=自身 / file=父 / blank=根 */
function dirOf(t: MenuTarget): string {
  if (t.kind === 'dir') return t.relPath
  if (t.kind === 'file') return t.parentRel
  return ''
}

function startRenameAt(t: MenuTarget) {
  editing.value = {
    kind: 'rename',
    parentRel: t.parentRel,
    isDir: t.kind === 'dir',
    name: t.name,
    oldRel: t.relPath,
  }
}

function onMenuAction(action: string, t: MenuTarget) {
  closeMenu() // TreeContextMenu 自己也 emit close，这里兜底保证状态清干净
  switch (action) {
    case 'new-file': startCreate(dirOf(t), false); break
    case 'new-folder': startCreate(dirOf(t), true); break
    case 'open': store.openFile(t.relPath); break
    case 'copy-path': void store.copyPath(t.relPath, true); break
    case 'copy-relpath': void store.copyPath(t.relPath, false); break
    case 'copy': void store.setClipboard(t.relPath, 'copy'); break
    case 'cut': void store.setClipboard(t.relPath, 'cut'); break
    case 'paste': void store.pasteInto(dirOf(t)); break
    case 'rename': startRenameAt(t); break
    case 'reveal': void store.revealEntry(t.relPath); break
    case 'delete': void store.deleteEntry(t.relPath); break
    case 'collapse-all': store.collapseAll(); break
    case 'refresh': void store.refreshAll(); break
  }
}
```

6. 删除 document 监听区（`menuEl` / `onDocClick` / `onDocCtx` / 对应 mounted/unmounted 注册）—— 关闭逻辑已内聚进 TreeContextMenu。
7. `rootCreateRequest` watch 替换为（仍只在根实例响应）：

```ts
// 工具条「新建文件」按钮联动：+1 时按选中态解析目标目录弹行内输入
// （旧实现硬编码根目录；现在 选中目录→该目录 / 选中文件→父 / 无选中→根）。
// 仅 v > old 防止 setSession 清零造成误触发；editing 由所有实例共享（provide），
// 但 ghost 行只在 parentRel 匹配的实例渲染，根实例触发即可。
watch(
  () => store.createAtRequest,
  (v, old) => {
    if (v > old && isRoot) {
      const sel = store.selectedRelPath
      startCreate(resolveCreateTarget(sel, sel ? store.entryIsDir(sel) : null), false)
    }
  },
)
```

8. （保留现有 `startCreate` / `submitEdit` / `cancelEdit` / `isEditingEntry` / `creatingHere` / 聚焦逻辑不动。）

- [ ] **Step 2: FileTree.vue template 改造**

1. 根容器：

```html
<div
  v-if="isRoot"
  ref="fileTreeEl"
  class="file-tree"
  tabindex="-1"
  @contextmenu.prevent.stop="openBlankMenu($event)"
  @click="fileTreeEl?.focus()"
>
  <div v-if="!store.workDir" class="tree-empty">无工作目录</div>
  <TreeRow
    v-else-if="(store.tree['']?.length ?? 0) > 0 || creatingHere"
    :rel-path="''"
    :depth="0"
  />
  <div v-else class="tree-empty">空</div>

  <TreeContextMenu
    v-if="menu"
    :target="menu.target"
    :x="menu.x"
    :y="menu.y"
    :show-paste="!!store.clipboard"  <!-- 2026-09-28 修复轮已删：paste 改为始终渲染，可见性由 store pasteInto 三级回退兜底 -->
    @action="onMenuAction"
    @close="closeMenu"
  />
</div>
```

要点：
- `creatingHere` 让「空目录点 +」也能看到 ghost 行（spec §第 1 节空状态共存）。
- `@contextmenu.prevent.stop` 防冒泡到 document 的 contextmenu 监听（否则刚开就自我关闭）。
- **`@click` 不带 `.self`**（不是只有点空白才聚焦）：点行的 click 会冒泡到容器，容器必须拿焦点，否则焦点停在 body、`@keydown` 永远不触发，F2/Delete/Esc 全部失效。编辑输入框与菜单都有 `@click.stop`，不会被误聚焦抢走焦点。

2. script 加 `const fileTreeEl = ref<HTMLElement | null>(null)`，根容器绑定 `ref="fileTreeEl"`（Step 1 模板已含）。
3. 行 `@contextmenu.prevent.stop="openMenu($event, entry)"` 保持不变。
4. 行 class 对象追加两个键（Task 7 还会加 drop-target）：

```ts
{
  'is-dir': entry.isDir,
  active: !entry.isDir && store.activeRelPath === entryRel(entry),
  selected: store.selectedRelPath === entryRel(entry),
  cut: store.clipboard?.op === 'cut' && store.clipboard.paths.includes(absJoin(store.workDir, entryRel(entry))),
}
```

（`absJoin` 已在 Step 1.1 的 import 中引入，此处无需再加。）
5. 删除模板中旧的内联菜单块（`<div v-if="menu" ref="menuEl" class="ctx-menu">...` 整块，含 4 个 `menuXxx` 调用）。
6. style 区删除 `.ctx-menu` / `.menu-item`（及 `.menu-sep` 若有）——已迁入 TreeContextMenu。追加：

```css
.row.selected {
  background: var(--bg-selected);
  box-shadow: inset 0 0 0 1px var(--accent-soft-border);
}
.row.cut { opacity: 0.5; }
.file-tree:focus { outline: none; }
```

- [ ] **Step 3: CodeView.vue 改造 + store 清理 rootCreateRequest**

`CodeView.vue`：

```ts
function onNewFile() {
  store.createAtRequest++
}

function onRefresh() {
  void store.refreshAll()   // 原内联刷新逻辑迁 store（菜单「刷新」共用，DRY）
}
```

`stores/files.ts`（此时 FileTree/CodeView 引用已全部切换，`rootCreateRequest` 成死代码，三处删除）：

1. 删除 `const rootCreateRequest = ref(0) ...` 声明（含行尾注释）；
2. 删除 `setSession` 内 `rootCreateRequest.value = 0` 一行（`createAtRequest.value = 0` 已在其后追加，Task 4）；
3. return 对象中删除 `rootCreateRequest`。

- [ ] **Step 4: 类型检查 + 渲染层测试**

Run: `cd src/renderer && npx vue-tsc --noEmit` → PASS（`rootCreateRequest` 无残余引用）
Run: `cd src/renderer && npx vitest run` → PASS

- [ ] **Step 5: 手动冒烟（dev 起后在右栏文件树验证）**

```bash
npm run dev
```

- [ ] 选中目录后点 + → ghost 行出现在该目录下（不再总是根目录）
- [ ] 选中文件后点 + → 父目录；无选中点 + → 根目录
- [ ] 空仓库点 + → 根部 ghost 行可见（非空态文案挡住）
- [ ] 目录行 / 文件行 / 空白处右键 → 三套菜单符合 spec 表格
- [ ] 复制路径 / 复制相对路径 → 粘贴板内容正确
- [ ] 剪切后行半透明；粘贴成功后行恢复、toast 无报错

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/code/FileTree.vue src/renderer/src/components/code/CodeView.vue src/renderer/src/stores/files.ts
git commit -m "fix: 文件树+按钮跟随选中态新建，右键菜单三上下文接线"
```

---

### Task 7: 拖拽移动 + 键盘快捷键

**Files:**
- Modify: `src/renderer/src/components/code/FileTree.vue`
- Test: 无新增（拖拽逻辑以主进程 copyEntries 单测 + 手动验收覆盖；快捷键为 DOM 接线）

**Interfaces:**
- Consumes: store `dragRel` / `dropTargetRel` / `moveEntry` / `select` / `entryIsDir`；utils `parentOf` / `baseName`。
- Produces（spec §第 4 节）: 行可拖、目录行高亮落点、落点调 `moveEntry`；F2 重命名 / Delete 删除 / Esc 关菜单或取消选中；树容器可聚焦。

- [ ] **Step 1: 拖拽 handlers（script）**

在 `closeMenu` 附近追加：

```ts
// ---------- 拖拽移动（HTML5 DnD；单文件拖拽，多选不做） ----------
function onDragStart(e: DragEvent, entry: TreeEntry) {
  const rel = entryRel(entry)
  store.dragRel = rel
  e.dataTransfer?.setData('text/plain', rel)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

/** 落点目录：目录行=自身，文件行=其父目录 */
function dropDirOf(entry: TreeEntry): string {
  const rel = entryRel(entry)
  return entry.isDir ? rel : parentOf(rel)
}

/** 拒绝自我拖拽与拖入自身子孙（防递归爆炸；主进程 copyEntries 仍会兜底校验） */
function isIllegalDrop(src: string, dest: string): boolean {
  return !src || dest === src || dest.startsWith(src + '/') || dest === parentOf(src)
  // dest === parentOf(src) = 同目录移动，no-op 没意义，也拒绝高亮
}

function onDragOver(e: DragEvent, entry: TreeEntry) {
  const src = store.dragRel
  if (!src) return
  const dest = dropDirOf(entry)
  if (isIllegalDrop(src, dest)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  store.dropTargetRel = dest
}

function onDrop(e: DragEvent, entry: TreeEntry) {
  e.preventDefault()
  const src = store.dragRel
  const dest = dropDirOf(entry)
  store.dragRel = null
  store.dropTargetRel = null
  if (!src || isIllegalDrop(src, dest)) return
  void store.moveEntry(src, dest)
}

function onDragEnd() {
  store.dragRel = null
  store.dropTargetRel = null
}
```

- [ ] **Step 2: 行属性接线（template）**

行 div 追加：

```html
:draggable="!(editing && isEditingEntry(entry))"
@dragstart="onDragStart($event, entry)"
@dragover="onDragOver($event, entry)"
@drop="onDrop($event, entry)"
@dragend="onDragEnd()"
```

行 class 对象追加 `'drop-target': store.dropTargetRel === entryRel(entry) && entry.isDir`。

style 追加：

```css
.row.drop-target {
  background: var(--accent-soft-bg);
  box-shadow: inset 0 0 0 2px var(--accent);
}
.row.dragging { opacity: 0.4; }
```

`onDragStart` 里同时无法直接加 `.dragging` 类（行 class 绑定可加）：`dragging: store.dragRel === entryRel(entry)`。

- [ ] **Step 3: 键盘快捷键（script + 根容器）**

script 追加：

```ts
// ---------- 快捷键（树容器聚焦时生效；input 内不劫持） ----------
function onTreeKeydown(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
  const sel = store.selectedRelPath
  if (e.key === 'F2') {
    if (!sel) return
    e.preventDefault()
    startRenameAt({
      kind: store.entryIsDir(sel) === true ? 'dir' : 'file',
      relPath: sel,
      name: baseName(sel),
      parentRel: parentOf(sel),
    })
  } else if (e.key === 'Delete') {
    if (!sel) return
    e.preventDefault()
    void store.deleteEntry(sel)
  } else if (e.key === 'Escape') {
    if (menu.value) { closeMenu(); return }
    e.preventDefault()
    store.select(null)
  }
}
```

根容器追加 `@keydown="onTreeKeydown"`（Step 6 Task 6 的模板上加）。

- [ ] **Step 4: 类型检查 + 测试**

Run: `cd src/renderer && npx vue-tsc --noEmit` → PASS
Run: `cd src/renderer && npx vitest run` → PASS

- [ ] **Step 5: 手动冒烟**

- [ ] 拖文件到另一目录行 → 高亮蓝框，松手后文件出现在目标目录、源目录刷新
- [ ] 拖到自身 / 自身子目录 / 自身父目录 → 无高亮无反应
- [ ] 拖拽中途 Esc 或拖出 → `dragend` 清态，无残留高亮
- [ ] 点行选中后按 F2 → 行内重命名；Delete → 确认框删除
- [ ] 树内按 Esc → 先关菜单（开着时），再取消选中
- [ ] 编辑输入框内按 F2/Delete/Esc → 走输入框自身逻辑，不被劫持

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/code/FileTree.vue
git commit -m "feat: 文件树拖拽移动与 F2/Delete/Esc 快捷键"
```

---

### Task 8: 全量验证 + 规格对照收尾

**Files:**
- 无新改动（发现问题则回对应 task 修复后重跑）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 可合并的完整交付。

- [ ] **Step 1: 主进程全量**

Run: `npm run test:main`
Expected: 全绿（git.test.ts 在高负载下偶发超时，失败则单独重跑 `npx vitest run tests/main/git.test.ts` 确认）。

- [ ] **Step 2: 渲染层全量 + 类型**

Run: `cd src/renderer && npx vitest run` → 全绿
Run: `cd src/renderer && npx vue-tsc --noEmit` → 全绿

- [ ] **Step 3: spec 对照清单逐项勾验（手动，dev 模式）**

- [ ] + 按钮：选中目录/选中文件/无选中 三分支（spec §第 1 节）
- [ ] 三上下文菜单项与 spec §第 2 节表格逐项一致，paste 始终渲染 + 三级回退（应用内剪贴板 → FileClipRead 系统剪贴板 → 都空 toast『剪贴板为空』）
- [ ] 复制/剪切后系统剪贴板含路径（Win+V 实际表现以真机为准：Windows 每次 clipboard 写独立 EmptyClipboard，FileNameW 最终写入后 text 格式被清）；切会话剪贴板保留
- [ ] 粘贴同名 → `- 副本`；连续同名 → `- 副本 (2)`；从资源管理器复制的路径能粘入（spec §第 3 节）
- [ ] 粘贴后选中第一个新条目
- [ ] Reveal in Explorer 打开资源管理器并选中
- [ ] 全部折叠 / 刷新（工具条与菜单行为一致）
- [ ] 拖拽安全规则（自身/子孙/同目录）+ F2/Delete/Esc（spec §第 4 节）
- [ ] 错误路径：粘贴空剪贴板 warn toast；部分失败 error toast（spec §第 5 节）
- [ ] 样式：选中高亮与激活蓝底可区分、剪切半透明、无硬编码颜色、无新增动画（reduced-motion）

- [ ] **Step 4: 最终 commit（如有微调）**

```bash
git add -u
git commit -m "chore: 文件树操作 spec 对照微调"
# 无改动则跳过
```
