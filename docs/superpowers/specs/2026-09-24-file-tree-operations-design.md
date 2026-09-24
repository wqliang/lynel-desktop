# 文件树基础文件操作 设计文档

日期：2026-09-24
状态：已与用户逐节确认

## 背景与问题

1. **+ 按钮 bug**：`CodeView.vue` 工具条的「新建文件」按钮只做 `store.rootCreateRequest++`，`FileTree.vue` 监听后硬编码 `startCreate('', false)`，无条件在**根目录**弹新建行。且文件树没有「选中项」概念，不存在"当前目录"。
2. **右键菜单不完整**：现有右键菜单仅在行上触发（目录行有新建/重命名/删除，文件行只有重命名/删除）；**空白处右键无任何反应**；缺少复制路径、剪切/复制/粘贴、拖拽移动、资源管理器显示、键盘快捷键等 VSCode 基础能力。

## 需求清单（用户确认）

- [x] + 按钮跟随选中项（VSCode 语义）
- [x] 空白处右键菜单（新建文件/文件夹、全部折叠、刷新）
- [x] 复制路径 / 复制相对路径
- [x] 剪切 / 复制 / 粘贴（应用内剪贴板为主，兼容系统剪贴板路径）
- [x] 拖拽移动
- [x] Reveal in Explorer（`shell.showItemInFolder`）
- [x] 快捷键 F2 重命名 / Delete 删除 / Esc 取消选中
- [x] 粘贴/移动同名自动重命名（永不覆盖）
- [x] 既有「重命名 / 删除 / 目录上新建」保留不动

## 方案选型

选 **方案 B：模块化扩展**（放弃 A「全堆进 FileTree」与 C「通用命令注册表」）：

- 状态（选中、剪贴板）收编进 `stores/files.ts`。
- 右键菜单抽成 `TreeContextMenu.vue`，按 `target: dir | file | blank` 三种上下文数据驱动渲染。
- 主进程新增 `file:copy`（含 move 模式）与 `file:reveal` 两个 IPC。
- 拖拽用 HTML5 DnD 绑在行上；快捷键在树容器 `keydown`。

理由：菜单上下文三分支是复杂度中心，组件化后加菜单项只是加一行数据；其余状态本就在 store 里顺势收编。

---

## 第 1 节：选中态 + 按钮跟随

**选中态（`stores/files.ts`）**

- 新增 `selectedRelPath = ref<string | null>(null)`。
- 点击行 = 选中该行：目录点击同时展开、文件点击同时打开 tab（原行为不变，仅多记录选中）。
- 选中高亮与现有激活文件 `.active` 蓝底**区分**（独立 `.row.selected` 样式，边框/浅底，用 CSS 变量）。
- 生命周期：
  - `setSession` 切会话 → 重置 `null`。
  - `renameEntry` → 迁移到新 relPath；`deleteEntry` / watcher 删除 → 清空（若是被删项）。
- 树内按 Esc → 取消选中。

**+ 按钮**

- 废弃 `rootCreateRequest`，改为 `createAtRequest = ref<number>(0)`；`CodeView.vue` 只 `++`。
- `FileTree.vue` 监听递增后按选中态解析目标目录（纯函数 `resolveCreateTarget(selected, workDir?)`，返回目标父目录 relPath）：
  - 选中**目录** → 该目录；
  - 选中**文件** → 其父目录；
  - 无选中 → 根 `''`。
- 未展开的目录先展开（现有 `startCreate` 已处理）。
- 新建流程**不改变选中态**；新建提交成功后不自动跳转选中。

**空状态**：根为空显示「空」文案时，+ 仍能在 `''` 弹 ghost 行——注意模板 `v-if / v-else-if` 顺序，空文案与 ghost 行可共存。

---

## 第 2 节：右键菜单（`TreeContextMenu.vue`）

**三种上下文的菜单项**：

| 上下文 | 触发 | 菜单项（自上而下，含分隔线） |
|---|---|---|
| `blank` | 根容器 / 空白处右键（现 `@contextmenu.prevent` 改为弹菜单） | 新建文件、新建文件夹 ── 全部折叠、刷新 |
| `dir` | 目录行右键 | 新建文件、新建文件夹 ── 复制路径、复制相对路径 ── 复制、剪切、粘贴* ── 重命名、在资源管理器中显示、删除 |
| `file` | 文件行右键 | 打开 ── 复制路径、复制相对路径 ── 复制、剪切、粘贴* ── 重命名、在资源管理器中显示、删除 |

\* `paste` 仅剪贴板非空时渲染（隐藏，而非 disabled）。

**组件接口**：

```ts
props: {
  target: { kind: 'blank' | 'dir' | 'file'; relPath: string; parentRel: string } | null
  x: number
  y: number
}
emits: {
  (e: 'action', action: string, target: Target): void
  (e: 'close'): void
}
```

- 动作名：`new-file` / `new-folder` / `copy-path` / `copy-relpath` / `copy` / `cut` / `paste` / `rename` / `reveal` / `delete` / `collapse-all` / `refresh` / `open`。
- 组件**只负责渲染**，不碰 store；具体逻辑由 `FileTree.vue` 收到 `action` 后分发。
- 定位：复用现有视口边缘收拢逻辑（搬进组件）。
- 菜单显示期间选中态不变；点项后先 `close` 再执行。

---

## 第 3 节：剪贴板 + 粘贴 + 自动重命名

**剪贴板状态（store，应用级）**：

```ts
clipboard = ref<{ op: 'cut' | 'copy'; paths: string[] } | null>(null)
```

- 复制/剪切时同步写系统剪贴板：Windows `clipboard.writeBuffer('FileNameW', ...)`，回退 `\n` 拼接绝对路径文本。
- 被剪切的行加半透明 `.row.cut` 样式（CSS 变量）。
- 粘贴成功后清空内部剪贴板；**切会话不清**（跨会话复制是合理场景，源路径绝对寻址）。
- 源允许在当前 workDir **之外**（用户确认①：外部剪贴板路径可粘入）。

**粘贴目标目录**：菜单上下文决定——`dir` → 粘进该目录；`file` → 粘进其父目录；`blank` → 根。

**粘贴后选中**（用户确认②）：选中**第一个新条目**，方便立即 F2/Delete。

**IPC `file:copy`（主进程 `src/main/files.ts` 新增）**：

```
file:copy(srcPaths: string[], destWorkDir: string, destParentRel: string, mode: 'copy' | 'move')
  => { ok: string[]; failed: { path: string; error: string }[] }   // ok = 新 relPath 列表
```

- 逐个 try，不做整体原子性；返回成功/失败明细。
- **自动重命名（主进程）**：目标已存在 → `name - 副本.ext`；再存在 → `name - 副本 (2).ext`，循环至不冲突（上限 999）。扩展名用 `lastIndexOf('.')` 分割；目录直接加后缀。**move 同名同样重命名，永不覆盖**。
- copy：`fs.cp(src, dest, { recursive: true })`；move：优先 `fs.rename`，`EXDEV` 回退 copy + 删源。
- 越界校验：目标经 `resolveEntry(workDir, rel)`；外部源仅校验存在性。

---

## 第 4 节：拖拽移动 + 快捷键 + 其余动作

**拖拽（HTML5 DnD，仅渲染层）**：

- 行 `draggable`；`dragstart` 记 `{ paths: [该行], mode: 'move' }`；**不写系统剪贴板、不清内部剪贴板**。
- 目录行 `dragover` → preventDefault + `drop-target` 高亮；`drop` → 走 `file:copy(mode: 'move')`，同名重命名同一套逻辑。
- 拖到文件行 → 目标解析为该文件的父目录。
- 拖出树外 / 到空白 → 忽略（不支持拖到桌面等外部目标，YAGNI）。
- **安全规则**：禁止自我拖拽与拖入自身子孙目录（`a/` → `a/b/` 会递归爆炸）——主进程 rename 前校验：目标 ≠ 源、目标不在源之下，违规 reject → toast。
- **多选拖拽不做**（无多选机制，YAGNI；批量用剪切/粘贴）。

**快捷键（树容器 `keydown`）**：

- `F2` → 对 `selectedRelPath` 行内重命名（复用 `editing`）。
- `Delete` → 对 `selectedRelPath` 删除（复用 `deleteEntry` 确认框）。
- `Esc` → 取消选中。
- 容器 `tabindex="-1"`，点树空白处 focus 容器。
- 事件目标是 `input`/`textarea` 时不劫持。

**其余小项**：

- `copy-path`：绝对路径写系统剪贴板文本；`copy-relpath`：relPath 写系统剪贴板文本（都不动内部剪贴板）。
- `reveal`：新 IPC `file:reveal(workDir, relPath)` → `shell.showItemInFolder(resolveEntry(...))`。
- `collapse-all`：`expanded = new Set()`；`refresh`：重拉根 + 所有已展开目录。
- `open`（仅 file 上下文）：`openFile(relPath)`，VSCode 习惯，保留。

---

## 第 5 节：错误处理 + 测试

**错误处理（store 层 toast，不抛未捕获）**：

- 失败一律 `pushToast({ level: 'error', source: 'file', message: '粘贴失败/移动失败/…：${msg}' })`，对齐现有文案格式。
- `file:copy` 部分失败：成功的生效，汇总 toast（列前几个失败项）。
- 外部剪贴板源不存在/不可读：粘贴前校验，toast「剪贴板中的源文件不存在」，不发 IPC。
- 拖拽安全违规：主进程 reject → toast。

**测试**：

- 主进程（`tests/main/files.test.ts` 扩展）：
  - `copyEntry` 复制文件 / 递归复制目录；
  - 自动重命名：单冲突 → `- 副本`、连续冲突 → `副本 (2)`、无扩展名目录；
  - move 同名重命名；目标=源、目标在源之下 → reject；
  - 新入口均走 `resolveEntry` 越界校验。
- 渲染层（vitest）：
  - store：选中态设置/会话重置/rename·delete 迁移；剪贴板 set/clear/跨会话保留；粘贴后选中第一个新条目；
  - `resolveCreateTarget` 三分支（目录/文件/无选中）纯函数直测；
  - `TreeContextMenu`：三种上下文菜单项快照、空剪贴板隐藏 paste。
- 不做 E2E（现有基建未覆盖文件树，YAGNI）。

---

## 影响文件

| 层 | 文件 | 改动 |
|---|---|---|
| 渲染 | `stores/files.ts` | 选中态、剪贴板、`createAtRequest`、copy/paste/collapse/refresh actions |
| 渲染 | `components/code/FileTree.vue` | 选中交互、快捷键、拖拽、菜单分发；菜单标记迁出 |
| 渲染 | `components/code/TreeContextMenu.vue` | **新增**，数据驱动菜单 |
| 渲染 | `components/code/CodeView.vue` | + 按钮改 `createAtRequest` |
| 主进程 | `src/main/files.ts` | `file:copy`（含 move、自动重命名、子孙校验）、`file:reveal` |
| 主进程 | `src/main/preload.ts` | 暴露 `FileCopy` / `FileReveal` |
| 渲染 | `composables/useElectron.ts` | 类型化转发 |
| 样式 | `FileTree.vue` scoped | `.selected` / `.cut` / `.drop-target` |

## 明确不做（YAGNI）

- 多选（Shift/Ctrl 点选）与多选拖拽；
- 拖拽到 Lynel 之外 / 从桌面拖入（外部进入走系统剪贴板粘贴已覆盖）;
- 通用命令注册表框架；
- E2E 测试；
- 替换/跳过式同名冲突对话框（统一自动重命名）。
