# 右栏「文件」Markdown 预览 +「Git」工作区优化方案（评审稿）

> **状态：待评审。本轮只做代码调研与方案设计，未改动任何业务代码。**
> 日期：2026-11-10 ｜ 适用版本：`package.json` 0.0.34 ｜ 所有路径相对仓库根
> 参照物：`NanmiCoder/cc-haha`（开源 Claude Code 桌面工作台）的「改动逐个文件审阅」与「隔离 Worktree」

---

## 0. 结论先行

1. **「文件」不是文件浏览器，它已经是一个 Monaco 轻量 IDE**：文件树、多 Tab、编辑保存、语法高亮、Git diff、项目终端全都有。所谓「实现 md 渲染」，实际只差**一层预览壳**，不需要新编辑器、不需要新依赖。
2. **最轻量方案 = 零新增依赖 + 零新增 Monaco 实例**：复用已装的 `marked ^18` + `DOMPurify ^3`，预览用纯 DOM `v-html`；三模式只是**同一编辑器的布局切换**（不重建、不卸载）。包体积增量约 0，运行时只多一个 div。
3. **`pull` / `commit` / `push` 已经实现**（`git.ts` 的 `remoteOp` + `commit`），问题不在功能，而在**入口被埋了 4 层且两级默认折叠**；**`worktree` 是唯一真正的新增能力**，且必须先修 `.git` 为文件时的 watcher 兼容。
4. **变更清单 + 左右双栏 diff 已经存在**（`GitPanel` 四组列表 + Monaco `DiffEditor`）。缺的是：一级入口、IDEA 式树形清单/复选/批量、inline（上下）diff 切换、变更导航，以及 cc-haha 式**「本轮改动」聚合与整轮撤销**。
5. **入口方案推荐 A**：把右栏顶部那颗「文件」标识换成 **「文件 | Git」并排分段控件**，Git 上移为右栏顶层视图，与文件互斥但 `v-show` 保活。这是唯一能同时解决「好找」和「面积够用」的方案。
6. **工作量：约 15–20 人日**（1 名熟悉本仓库的开发者，含单测与回归）；**P1 约 6–8 人日**即可交付「md 三模式 + Git 并排入口 + 常规操作显性化」的可用版本。建议分 3 期评审验收。

---

## 1. 现状盘点（代码级，已逐文件核对）

### 1.1 右栏真实形态

`HomeView.vue:248-254` 挂载 `RightWorkspacePane`，其内部层级：

```
会话 tab → session-content
├─ .session-left：终端 / Trace 子页
└─ aside.right-pane（files.splitOpen 控制，默认收起）
   ├─ .right-head：「文件」标识(点击折叠树) + FileTabs + 全屏/收起
   └─ CodeView
      ├─ .main-row：文件树(300px) + FileEditorPanel
      │              ├─ CodeEditor.vue   （唯一直立 Monaco 实例）
      │              └─ CodeDiffView.vue（唯一 DiffEditor，只读）
      └─ BottomPanel（**默认折叠**）
         ├─ Git tab → GitPanel.vue（869 行，变更列表 + 历史图 + 提交表单）
         └─ 终端 tab → ProjectTerminal.vue（xterm + PTY）
```

> 注：`AGENTS.md:16` 写的「右侧 Trace 面板 200px」已过时，Trace 现在是 `.session-left` 里的子页；右栏是可拖宽的会话工作区（`min 320px`，首次展开取容器 50%）。

### 1.2 「文件」能力矩阵

| 能力 | 现状 | 位置 |
|---|---|---|
| 文件树（惰性单层、递归、右键、拖拽、新建/改名/删除） | ✅ | `code/FileTree.vue` 516 行、`main/files.ts` |
| 查看 / 编辑 / 保存（Ctrl+S、脏标记、草稿、外部变更冲突条） | ✅ | `code/CodeEditor.vue`、`stores/files.ts` |
| 语法高亮（Monarch + TextMate，含 `.md` 源码着色） | ✅ | `monaco/setup.ts`、`textmate.ts`、`syntaxes/markdown.tmLanguage.json` |
| Git diff（Monaco 双栏只读） | ✅ | `code/CodeDiffView.vue:52-61` |
| 安全（路径越界、1MB 截断、二进制判定、ignore 清单、recursive watch 150ms 合帧） | ✅ | `main/files.ts:7-44,262-302` |
| **Markdown / 富文本渲染预览** | ❌ **没有** | 全仓 `marked` 只被 `trace/Markdown.vue`、`GuideTab.vue` 引用，`components/code/` 零引用 |
| 图片 / PDF / 二进制预览 | ❌ | `CodeEditor.vue:218` 直接提示「二进制文件，无法编辑」 |

### 1.3 「Git」能力矩阵

主进程 `main/git.ts`（942 行）用 `simple-git` 包装系统 git CLI，21+ 个 `git:*` IPC，`{ok:true}|{ok:false,error}` 契约，`withWorkDir` 空目录纵深防御，全程 argv 数组不拼 shell。

| 能力 | 现状 | 位置 |
|---|---|---|
| status（四组：冲突/暂存/更改/未跟踪）、stage / unstage / discard（**已支持 paths[] 批量**） | ✅ | `git.ts:121-259`、`GitPanel.vue:211-241` |
| **commit**（Ctrl+Enter、提交说明、二次确认 reset hard） | ✅ | `git.ts:264-268`、`GitPanel.vue:270-286` |
| **fetch / pull / push** | ✅ | `git.ts:271-291`、`GitPanel.vue:192-200`（三个 13px 图标按钮） |
| 分支创建/切换/删除、stash、reset、提交历史图、提交详情 | ✅ | `git.ts:561-692,424-520` |
| 变更文件 → diff（HEAD↔工作区 / HEAD↔index / `<hash>^`↔`<hash>`） | ✅ | `GitPanel.vue:43-55` → `stores/files.ts:openDiff` |
| **左右双栏 diff** | ✅ 硬编码 | `CodeDiffView.vue:56` `renderSideBySide: true` |
| **上下 / inline（unified）diff** | ❌ | 全仓无 `renderSideBySide: false`、无切换控件 |
| 变更清单的树形目录分组 / 复选 / 批量 / 右键 | ❌ | 现在是 4 组**平铺列表**（`GitPanel.vue:212-240`） |
| `git diff`（hunk 级、重命名检测、diffstat、部分暂存） | ❌ | diff 靠 `git show <rev>:<path>` 取两份全文交给 Monaco 计算 |
| **`git worktree *`** | ❌ **完全没有** | 代码里的 `WORKTREE` 只是 diff 右侧哨兵「取工作区文件」，不是多工作树 |
| linked worktree 兼容 | ❌ 有 Bug | `git.ts:790` 硬编码 `${workDir}/.git`；linked worktree 里 `.git` 是**文件**，watcher 直接失效 → 操作后面板不自动刷新 |
| fetch/pull/push 超时 | ❌ | `git.ts:270` 注释明确「调用方负责禁用按钮」，无任何 timeout |

### 1.4 为什么 Git 入口「很不显眼」

四层嵌套 + 两级默认折叠 + 一个被注释掉的按钮：

| 层 | 开关 | 默认 |
|---|---|---|
| ① 必须处于会话 tab | `activeType === 'session'` | — |
| ② 右栏展开 | `stores/files.ts:68` `splitOpen = ref(false)` | **收起** |
| ③ 底部面板展开 | `BottomPanel.vue:45-53` `loadCollapsed()` 无 localStorage 时 `return true` | **折叠** |
| ④ 点「Git」标签 | `BottomPanel.vue:133-140` | 展开后默认已选中 |

补充佐证：
- `HomeView.vue:196-207` 原本最直观的「展开 Workspace」按钮**整段被注释下线**；
- 收起态只剩右缘一个 13px 纯图标按钮（`RightWorkspacePane.vue:141-145`），无文字、无变更数提示；
- Git 变更数徽章 `gitBadge` **只在展开态渲染**（`BottomPanel.vue:139`），收起时用户看不到「有 N 个未提交变更」；
- 侧边栏、全局 Tab、菜单、设置、快捷键里**都没有 Git 入口**；
- 导航层级上 Git 是「文件」的**孙节点**，不是兄弟节点。

### 1.5 关键不变量（改动前必须确认，均由现有代码/设计文档明确）

1. **全应用同一时刻只允许一个直立 Monaco 实例**，且 `FileEditorPanel.vue:7-10` 是**唯一编辑器宿主**（`docs/superpowers/specs/2026-09-22-terminal-file-split-design.md:45-55`）。`CodeEditor.vue:18-21` 用模块级 `editor` + `editorHost` 保证单实例。
2. **一律 `v-show` 保活**：Monaco、DiffEditor、xterm/PTY 缓冲不能因切视图被卸载（`RightWorkspacePane.vue:165`、`BottomPanel.vue:159`、`FileEditorPanel.vue:23`）。改 `v-if` 会丢终端 buffer、重建 Monaco。
3. **Monaco 在 `display:none` 下会被布局成 0×0**，从隐藏态回来必须补 `requestAnimationFrame(() => editor.layout())`（`CodeEditor.vue:151-162` 有专门注释）。三模式切换必然踩这个坑。
4. **`CodeView.vue:45-46` 注释：展开文件树的唯一入口是右栏顶部「文件」标识 tab**（`onLabelClick` 翻转 `files.collapsed`）；工具条只有「折叠」按钮。把 `.ws-label` 改成「文件 | Git」分段后**必须在工具条补一个「展开文件树」入口**，否则树折叠后无法恢复 —— 这是最易漏的回归点。
5. **三层 IPC 必须同步**：`main/preload.ts`（通道）↔ `renderer/composables/useElectron.ts`（唯一 API 出口，类型从主进程反向 `import type`）↔ `main/git.ts` / `main/files.ts`（handler + 类型）。
6. 前端禁止直接 `window.electronAPI.X()`；样式用 `theme.css` CSS 变量；图标走 `components/Icon.vue`；Pinia `ref<Record>` 更新用整体 spread。
7. 主进程错误返回 `{ok:false,error}`，不抛未捕获异常；`git` 命令一律 argv 数组。
8. `session.workDir` 一经创建固定，PTY 的 cwd 只在 spawn 时设一次（`pty.ts:533-537`），**运行中不能切换工作目录**。

---

## 2. 需求拆解与验收口径

### 2.1 文件：md 三模式

| 模式 | 视图 | 可编辑 |
|---|---|---|
| `editor` | 仅 Monaco 源码（现状，零变化） | ✅ |
| `editor&preview` | 左 Monaco / 右渲染预览，默认 1:1，可拖 | ✅ |
| `preview` | 仅渲染结果，隐藏编辑器（仍保活） | ❌（只读预览，Ctrl+S 不触发） |

触发条件：仅当 `activeRelPath` 以 `.md` / `.markdown` 结尾；其它文件**完全走现有路径，行为零变化**。验收：切换不重建 Monaco、不丢草稿/脏标记/撤销栈、不丢 Ctrl+S。

### 2.2 Git：入口 / 常规操作 / 审阅

- **入口**：与「文件」并排、一级可见、带未提交变更数徽章。
- **常规操作**：`pull` / `commit` / `push` 一眼可见、有文字或明确 tooltip、有 busy/结果反馈；`worktree` 可查看/切换/新建。
- **IDEA 习惯**：打开即见「修改的文件清单或文件树」，按目录分组，可多选、勾选、右键，点击即在右侧看 diff。
- **cc-haha 习惯**：能快速看「哪些文件被改了」，支持**上下 diff 与左右双栏 diff** 查看。

### 2.3 参照物核对：cc-haha 的「审阅」到底是什么

GitHub README 原文（已联网核对）：

> 「**改动逐个文件审阅**：右侧工作区列出**本轮改动**，点开就是**带语法高亮的 Diff**，**整轮可撤销**。」
> 「**分支 / Worktree 启动**：新会话可以选择仓库分支，并决定用**当前工作树还是隔离 Worktree**。」

关键差异：cc-haha 审阅的是 **「本轮（Agent 这一轮）改动」**，不是 `git status` 全量工作区变更。本项目恰好有对应数据源 —— API 网关阶段事件 / `~/.lynel-desktop/projects/<encoded>/<sid>-calls.jsonl` / 前端 `stores/trace.ts` 里的 `tool_use`（`Write` / `Edit` / `NotebookEdit` 的 `file_path`），可按 session + turn 聚合出「本轮被写过的文件」。

因此建议审阅面板提供**两个数据源可切换**：

| 口径 | 来源 | 现状 | 价值 |
|---|---|---|---|
| 工作区变更 | `git status`（四组） | ✅ 已实现 | 提交前的完整清单 |
| **本轮改动** | 阶段事件 / calls.jsonl 聚合，或 hook 的 Write/Edit 路径 | ❌ 需新增 | Agent 改了什么、一键放弃这一轮 |

「整轮撤销」不需要新 git 能力：现有 `discard(paths[])` 已支持批量（`git.ts:197-259`），把「本轮文件列表」整个丢进去 + 二次确认即可。

### 2.4 两处歧义（影响工作量，请评审确认）

| 歧义 | 理解 A | 理解 B | 成本差 |
|---|---|---|---|
| 「上下 different」 | **inline / unified diff**：同一个编辑器里删除行在上、新增行在下（Monaco `renderSideBySide:false`） | 上下堆叠两个独立编辑器（original 上 / modified 下） | A ≈ **0.5 人日**（一个 option）；B ≈ 3 人日且**违反单 Monaco 实例不变量** |
| 「审阅」口径 | 只要 git 全量变更清单 + diff | 还要 cc-haha 式「本轮改动 + 整轮撤销」 | 差 ≈ 1.5–2 人日 |

**本方案按 A + 「两者都要，可切换」设计**，若评审选 B / 只要 git 口径，相应减项。

---

## 3. 选型与方案细节

### 3.1 md 三模式：选型

#### 三条实现路径对比

| 路径 | 做法 | 新增依赖 | 新增 Monaco 实例 | 改动面 | 资源开销 | 结论 |
|---|---|---|---|---|---|---|
| **A. 复用单实例 + 纯 DOM 预览** ✅ | 在 `CodeEditor.vue` 内加模式布局；新增 `code/MarkdownPreview.vue` 用 `marked`+`DOMPurify`+`v-html` | **0** | **0** | 小（3 文件 + store 1 字段） | 最低：一个 div + 一次同步 parse | **推荐** |
| B. 新增 `MdEditorPane.vue` 自带 Monaco | 按扩展名分流到新组件 | 0 | **+1**，破坏不变量 | 中 | 两个编辑器常驻 | ❌ |
| C. WYSIWYG（tiptap / lexical / ProseMirror） | 所见即所得编辑 | +2~3 | +1 | 大 | 高（常驻富文本引擎） | ❌ 违背「最轻量」 |

#### 渲染策略对比

| 策略 | 说明 | 结论 |
|---|---|---|
| `marked.parse` → `DOMPurify.sanitize` → `v-html` | 依赖已在 bundle（Vite 共享 chunk），纯 DOM、无 worker、无 WASM | ✅ |
| 直接复用 `trace/Markdown.vue` | **有 `fold`：>800 字符 / >18 行就折成 `<details>`**，会把正常 md 文件正文折起来；且缺 `img` / 表格 / 任务列表样式、依赖未定义的 `--font-mono` | ⚠️ 必须 fork 一份，不能原样复用 |
| `markdown-it` + 插件 / `shiki` 高亮 / Mermaid / KaTeX | 新依赖 + WASM/渲染器常驻开销 | ❌ 放 P3 可选 |

#### 推荐实现（路径 A）

```
CodeEditor.vue（唯一 Monaco 实例，不新增、不 dispose）
├─ .md-mode-bar       三模式分段控件（仅 .md 显示；复用 base.css 的 .seg-group/.seg）
└─ .md-body (flex)
   ├─ .editor-host    ← ref="editorEl" 必须**常驻同一 DOM 节点**，只用 v-show / CSS 控制宽度
   └─ <MarkdownPreview :text="..." /> （预览区 v-show）
```

- **模式状态**：`stores/files.ts` 加 `mdMode: 'editor'|'split'|'preview'`（默认 `split`），放入 `SessionWorkspace` 按会话记忆 + `localStorage` 全局兜底。
- **预览文本来源**：直接取 `drafts[relPath] ?? activeFile.content`，**不额外读文件、不走 IPC**。已有 `onModelChange()` 把草稿写回 store，天然驱动响应式预览。
- **轻量/省资源 7 条硬措施**：
  1. 零新增依赖、零新增 chunk（marked/DOMPurify 已被 Trace 面板引入）；
  2. 零新增 Monaco 实例，编辑器与预览共享同一 model；
  3. 预览输入 150ms debounce + `requestAnimationFrame` 合并，连续打字不做全量 parse；
  4. `marked.parse(t, { async:false })` 同步执行，不起 worker / 不引 WASM；
  5. 大文档保护：>200KB 或 >5000 行时降级为「仅渲染前 N 行 + 提示」，避免每次按键重建上万 DOM 节点（现有 1MB 截断只读策略继续生效）；
  6. `preview` 模式下用 `v-show` 隐藏编辑器宿主（不卸载），切回时 `rAF(() => editor.layout())` 补布局；
  7. 不做 WYSIWYG、不做图片上传、不做代码块语法高亮（一期用 `pre` 底色即可）。
- **保存 / 脏标记 / Ctrl+S / 外部变更冲突条**：全部沿用现有链路，不重复实现；`preview` 模式屏蔽 Ctrl+S（无编辑焦点）。
- **滚动同步**：P2 可选，用 `scrollTop / (scrollHeight - clientHeight)` 比例单向同步（编辑器 → 预览），带 `syncing` 标志防抖循环，约 20 行。

#### 安全与相对资源（必须处理）

`.md` 是用户/外部内容，**必须 DOMPurify**（`GuideTab.vue:15` 未净化，但那是构建期自带的指南文档，不可照搬）。三个具体风险：

1. `<img src="./a.png">` / 相对链接在 `v-html` 里按页面 origin 解析 → 开发态 `http://localhost:5173` 404、打包态相对 `app.asar` 找不到，**图片必然不显示**；
2. `<a>` 点击在 Electron 里不能用 `target="_blank"`（会开新 BrowserWindow），需委托到 `shell.openExternal` 且限定 http/https；
3. DOMPurify 默认策略要补：协议白名单、禁 `on*`、禁外链任意 `file://`。

**推荐做法（约 60 行）**：`marked` 自定义 renderer 把相对资源改写成 `lynel-file:///<abs>` → 主进程 `protocol.handle('lynel-file', ...)` 校验路径在 `workDir` 内后**返回文件流**（不读进内存、不转 base64，最省资源）。
**P1 降级做法（零主进程改动）**：相对图片渲染为占位 + `title` 提示绝对路径，仅放行 http(s)/data 图片 —— 列为评审点 Q4。

### 3.2 Git 入口：三方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 顶部「文件 \| Git」分段 + Git 上移主区** | `.ws-label` → 分段控件；`CodeView` 主体按 `activeWorkspaceView` 用 `v-show` 切换「文件工作区 / Git 工作区」；`GitPanel` 从底部上移；`BottomPanel` 只留终端 | 一级入口、变更清单与 diff 有完整右栏宽度、层级等同 IDEA 的 Project / Commit 工具窗口并列 | 需动 4 个组件 + 补「展开文件树」入口 | ✅ **推荐** |
| B. 顶部加「Git」按钮，点击展开底部 Git 面板 | 改动最小 | 面积仍是 320px 高折叠区、层级仍深、双栏 diff 挤、需要滚动定位 | 仅作兜底 |
| C. 左侧栏图标 / 全局 Tab | 最显眼 | Git 是 **per-session / per-workDir** 的，脱离会话上下文会切换错仓库 | ❌ |

推荐 A 的目标布局见 `../../preview/right-panel-before-after.svg`。要点：

- **分段控件复用 `styles/base.css:35-42` 的 `.seg-group/.seg`**，与现有视觉一致；Git 段带 `git.totalChanges` 徽章（**收起态也要显示**，解决「看不到有变更」）。
- `activeWorkspaceView: 'file'|'git'` 存 `stores/files.ts`，纳入 `SessionWorkspace` 按会话记忆；切到 Git 时**自动展开右栏**（`splitOpen=true`）。
- `v-show` 保活：文件工作区、Git 工作区、底部终端三者都不卸载，Monaco / DiffEditor / PTY buffer 全保留。
- **底部 Git tab 一期保留兼容**（老用户肌肉记忆），但点击时改为「切到 Git 顶层视图」；二期移除，底部只留终端。
- **必须补**：`CodeView.vue` 工具条加「展开文件树」按钮（因为原入口 `.ws-label` 被改成视图切换，见 §1.5 第 4 条）。
- 顺手恢复 `HomeView.vue:196-207` 被注释的「展开 Workspace」按钮，改为「展开工作区」并带上变更数徽章（可选，见 Q7）。

### 3.3 常规操作：现有能力显性化 + 补齐

| 操作 | 现状 | 优化 |
|---|---|---|
| pull | `pull()` 无选项、无超时，藏在一个 13px 图标里 | 顶栏**带文字**的 `Pull` 按钮 + 选项（`--rebase` / `--ff-only`）+ 结果 toast；主进程 `remoteOp` 加 `opts` 参数与 **60s 超时 / 可取消**（现在完全无超时，网络异常会永久 busy） |
| commit | 提交框在 320px 折叠区底部，易被忽略 | 移到 Git 工作区顶部工具区；补 `amend` 勾选、勾选文件即暂存（IDEA 习惯）、「提交并推送」；保留 Ctrl+Enter |
| push | `push()` 无 upstream/force 概念 | 补「首次推送自动 `-u`」、`--force-with-lease` 需二次确认、**默认禁用裸 `--force`** |
| 通用 | `busyOp` 只禁用按钮 | 顶栏进度指示 + 失败原因面板（保留 `{ok:false,error}` 契约） |

#### worktree（唯一真正的新能力）

主进程 `git.ts` 新增（全部 argv 数组，过 `withWorkDir`，`runOp` 包装）：

| 函数 | 命令 | 说明 |
|---|---|---|
| `worktreeList` | `git worktree list --porcelain` | 解析 `worktree <path>` / `HEAD` / `branch` / `detached` / `locked`，标出当前 workDir |
| `worktreeAdd` | `git worktree add [-b <branch>] <path> [startPoint]` | 路径必须由用户选择或由仓库同级目录规则生成；**禁止输出到仓库内部**；分支已被其它 worktree checkout 时 git 会报错，UI 原样展示 |
| `worktreeRemove` | `git worktree remove [--force] <path>` | 需二次确认，`--force` 仅在有未提交改动时提示 |
| `worktreePrune` | `git worktree prune` | 清理失效元数据 |

**必要前置修复**：`watchGit()`（`git.ts:788-807`）改为 `git rev-parse --absolute-git-dir` 拿真实 gitdir，再监听 `<gitDir>/HEAD`、`<gitDir>/index`、`<gitDir>/refs`（linked worktree 的 `.git` 是文件，现实现必然失效）。同时把字符串 `${workDir}/.git` 换成 `path.join`。

**UI**：顶栏 worktree 下拉（列出全部 worktree + 当前分支 + locked 标记）+「新建 worktree」对话框（选路径 / 选或新建分支 / 起始点）。

**会话绑定约束（重要）**：`session.workDir` 与 PTY cwd 运行时固定（§1.5 第 8 条），**不允许在已运行的会话里切换 worktree**。因此：
- P2 只做「查看 / 新建 / 移除 / 清理」+「**复制路径以便新建会话**」；
- P3 才做 cc-haha 式「**新建会话时选择 worktree 隔离启动**」，届时改 `NewSessionDialog` / `session.newSession()` 的 workDir 传参，不动运行中会话。

### 3.4 审阅：IDEA 清单 + cc-haha 本轮改动

目标布局见 `../../preview/git-review-workspace.svg`，三栏：

```
┌─ 顶栏：分支▾ │ worktree▾ │ Pull │ Commit │ Push │ 刷新 │ 更多(worktree管理) ─┐
├─ 左：变更清单（树形，可拖宽 240–480px）                                    │
│   ▸ src/renderer/src/components/code   (3)                                │
│      ☑ M  GitPanel.vue        [暂存][丢弃]                                 │
│   ▸ src/main                  (1)                                         │
│      ☐ M  git.ts                                                          │
│   分组：冲突 / 暂存的更改 / 更改 / 未跟踪（保留现有四组语义）                │
│   数据源切换：[工作区变更] [本轮改动]                                      │
│   底部：☐ amend  [提交说明................] [提交] [提交并推送]            │
├─ 中/右：diff 预览区                                                        │
│   文件头 + [上下 inline] [左右双栏] 切换 + ←上一处 / 下一处→ + 变更计数     │
│   Monaco DiffEditor（同一个实例，updateOptions 切换 renderSideBySide）      │
└─ 底部（可切 Tab）：提交历史图 / 终端（沿用现有 BottomPanel，v-show 保活）   ┘
```

要点：

- **变更清单树**：复用 `FileTree.vue` 的图标映射与行样式，新增 `code/ChangeTree.vue`（按 `/` 拆路径建树，目录节点显示变更数，叶子显示状态字母 + 复选 + hover 操作）；复选集合存 `stores/git.ts`，批量 stage/unstage/discard 直接调现有 `git.stage(paths[])` 等（**已支持数组**）。
- **diff 两种视图**：把 `CodeDiffView.vue:56` 的 `renderSideBySide: true` 改为响应式 `diffLayout: 'inline'|'side'`，用 `diffEditor.updateOptions({ renderSideBySide: ... })` 切换 —— **Monaco 原生能力，零新增依赖、零新增实例、约 0.5 人日**；偏好存 localStorage。
- **变更导航**：Monaco `DiffEditor` 的 `getLineChanges()` / `revealLine` 实现「上一处/下一处」，成本约 1 人日。
- **内嵌预览区**：IDEA 习惯是「点清单即在右侧看 diff」，现在是「打开成一个 diff tab 且与编辑器互斥」（`FileEditorPanel.vue:17-18`）。建议 **P1 保留现有 tab 行为**（改动小），**P2** 在 Git 工作区内做一个内嵌 diff 区；两种入口共用 `stores/files.ts:openDiff()` 与同一个 `CodeDiffView`，不新增 DiffEditor 实例。
- **本轮改动 + 整轮撤销**：从阶段事件 / `calls.jsonl` 按 session+turn 聚合 `tool_use`（Write/Edit/NotebookEdit 的 `file_path`），去重后与 `git status` 取交集展示；「放弃本轮」= `discard(本轮文件列表)` + 二次确认（复用现有 `discard` 批量能力）。

### 3.5 需要新增 / 扩展的 IPC 清单（三层同步）

| 通道 | preload | useElectron | 主进程 | 期次 |
|---|---|---|---|---|
| `git:remoteOp` 扩展 `opts`（rebase/ff/upstream/forceWithLease/timeout） | 改类型 | 改签名 | `remoteOp()` | P1 |
| `git:commit` 扩展 `amend` | 改类型 | 改签名 | `commit()` | P1 |
| `git:worktreeList` / `Add` / `Remove` / `Prune`（4 个） | +4 | +4 | +4 函数 +4 handler | P2 |
| `app:openExternal`（预览区的链接点击） | +1 | +1 | `shell.openExternal` + http(s) 白名单 | P1 |
| `lynel-file://` 自定义协议（相对图片，可选） | — | — | `protocol.handle` + workDir 白名单 | P1 可选 |
| 本轮改动聚合（可选） | — | — | 新增 `git:turnChanges` 或直接由前端 `trace` store 聚合，倾向**前端聚合，零 IPC** | P3 |

---

## 4. 改动面清单（文件级 WBS）

> ✅ 新增 ｜ ✏️ 修改 ｜ ⚠️ 需谨慎（触碰不变量）

| # | 文件 | 类型 | 改动内容 | 期次 |
|---|---|---|---|---|
| 1 | `renderer/src/components/code/MarkdownPreview.vue` | ✅ | marked + DOMPurify + 完整排版样式（img/table/task-list/代码块），无 fold | P1 |
| 2 | `renderer/src/components/code/CodeEditor.vue` | ⚠️ ✏️ | 加 `mdMode` 布局；**保持 `editorEl` 单节点常驻**；切模式补 `layout()`；preview 屏蔽 Ctrl+S | P1 |
| 3 | `renderer/src/stores/files.ts` | ✏️ | `mdMode`、`activeWorkspaceView`、`diffLayout`，纳入 `SessionWorkspace` | P1 |
| 4 | `renderer/src/styles/code.css` / `base.css` | ✏️ | 三模式布局、分段控件、状态色（全部 CSS 变量） | P1 |
| 5 | `renderer/src/components/code/RightWorkspacePane.vue` | ⚠️ ✏️ | `.ws-label` → 「文件 \| Git」分段 + 变更数徽章；移除 `onLabelClick` 折叠树 | P1 |
| 6 | `renderer/src/components/code/CodeView.vue` | ⚠️ ✏️ | 主体按视图 `v-show`；**工具条补「展开文件树」**；保留 `BottomPanel` 挂载 | P1 |
| 7 | `renderer/src/components/code/BottomPanel.vue` | ✏️ | Git tab 改为「切到 Git 顶层视图」；默认折叠态仍显示徽章 | P1 |
| 8 | `renderer/src/components/code/GitWorkspaceView.vue` | ✅ | Git 顶层视图容器（顶栏 + 变更清单 + diff 区） | P1 |
| 9 | `renderer/src/components/code/GitPanel.vue` | ⚠️ ✏️ | 869 行重排：顶栏/pull/commit/push 显性化；清单抽到 `ChangeTree`；历史图收为可切 Tab | P1/P2 |
| 10 | `renderer/src/stores/git.ts` | ✏️ | 选中集合、批量操作、`worktrees`、`diffLayout`、`turnChanges` | P1/P2 |
| 11 | `main/git.ts` | ✏️ | `remoteOp` 选项+超时、`commit` amend、worktree ×4、**`watchGit` 修复**、IPC 注册 | P1/P2 |
| 12 | `main/preload.ts` / `renderer/composables/useElectron.ts` | ✏️ | 三层同步（新通道 + 类型） | P1/P2 |
| 13 | `main/app.ts` / `index.ts` | ✏️ | 注册 `lynel-file` 协议（可选）、`openExternal` handler | P1 可选 |
| 14 | `renderer/src/components/code/CodeDiffView.vue` | ⚠️ ✏️ | `renderSideBySide` 响应式切换、`updateOptions`、变更导航 | P2 |
| 15 | `renderer/src/components/code/ChangeTree.vue` | ✅ | 树形变更清单（复选/批量/右键/状态色/图标复用） | P2 |
| 16 | `renderer/src/components/code/WorktreeMenu.vue` + 对话框 | ✅ | worktree 列表/新建/移除/清理 | P2 |
| 17 | `renderer/src/components/Icon.vue` | ✏️ | 新增 `git-pull-request` / `git-fork` / `columns-2` / `rows-2` 等映射 | P1 |
| 18 | `views/HomeView.vue` | ✏️ | 恢复「展开工作区」按钮（可选）；`rightFullscreen` 对 Git 视图同样生效 | P1 可选 |
| 19 | `tests/main/git.test.ts` | ✏️ | worktree 全链路（**真实临时 git 仓库**，不 mock）、remoteOp 选项、超时 | P1/P2 |
| 20 | 前端单测（`stores/files.test.ts` 等） | ✏️ | `mdMode` 记忆、`activeWorkspaceView`、选中集合、diff 偏好 | 全程 |
| 21 | `docs/changelog/` | ✅ | 变更记录 | 每期 |

**不改动**：`main/files.ts`（读写链路完全复用）、`FileTree.vue` 的树逻辑、`monaco/*`（复用单实例）、`session.ts` / `pty.ts`（P2 不动，避免破坏 cwd 不变量）。

---

## 5. 工作量评估与分期

> 口径：1 名熟悉本仓库的开发者；含自测、单测、`vue-tsc --noEmit` 回归；不含需求反复与 UI 视觉走查多轮。

| 工作包 | 内容 | 人日 | 期次 |
|---|---|---|---|
| W1 | md 预览组件 + 三模式布局 + 模式状态/记忆 + 大文档保护 + 布局坑修复 | 2.5–3 | **P1** |
| W2 | md 安全与相对资源（自定义协议 / P1 降级 0.2）+ 链接外跳 | 0.5–1 | **P1** |
| W3 | Git 顶部双 tab 入口 + Git 上移 + 底部兼容 + 补展开树入口 + 徽章 | 2–2.5 | **P1** |
| W4 | pull/commit/push 显性化 + 选项 + 超时/进度/错误面板 | 1.5–2 | **P1** |
| W5 | worktree 全链路（4 函数 + 4 IPC + watcher 修复 + UI + 真实仓库测试） | 3–4 | P2 |
| W6 | 变更清单树（分组/复选/批量/右键/状态色） | 2–3 | P2 |
| W7 | inline ↔ 双栏 diff 切换 + 变更导航 + Git 区内嵌 diff 预览 | 2–3 | P2 |
| W8 | 本轮改动聚合 + 一键放弃本轮 | 1.5–2 | P3 |
| W9 | 回归 / 单测补全 / 文档 / changelog（分摊在各期，不重复计） | 1–1.5 | 全程 |
| | **P1 小计** | **6.5–8.5** | 可用版 |
| | **P2 小计** | **7–10** | 完整审阅 + worktree |
| | **P3 小计** | **1.5–2** | cc-haha 对齐 |
| | **合计** | **≈ 15–20 人日** | |

**里程碑与门禁**
- P1 结束：md 三模式可用、Git 与文件并排且一眼可见、pull/commit/push 带文字与反馈；门禁 `npm run test:main` + `cd src/renderer && npx vue-tsc --noEmit` 全绿。
- P2 结束：worktree 可管理、审阅清单树 + 两种 diff 视图；补 `tests/main/git.test.ts` 的 linked worktree 用例。
- P3 结束：本轮改动 + 整轮撤销；可选「新建会话选 worktree 隔离启动」另立需求（涉及 `session.ts` / `NewSessionDialog`，约 +3 人日，未计入合计）。

---

## 6. 风险与不变量校验清单

| 风险 | 触发点 | 缓解 |
|---|---|---|
| **Monaco 重建 / 空白** | 三模式切换、文件↔Git 视图切换后编辑器区 0×0 | `editorEl` 常驻、`v-show`、`rAF(layout())`；参照 `CodeEditor.vue:151-162` |
| **破坏单实例不变量** | 新增第二个编辑器宿主 / 内嵌 diff 区 | 顶层视图与内嵌 diff 共用同一 `CodeDiffView`；`FileEditorPanel` 仍是唯一宿主 |
| **文件树折叠后无法展开** | `.ws-label` 改为视图切换，丢掉 `onLabelClick` | `CodeView` 工具条补「展开文件树」按钮（§1.5 第 4 条） |
| **PTY / 终端 buffer 丢失** | 改 `v-if` 卸载 `BottomPanel` / `CodeView` | 一律 `v-show` |
| **XSS / 任意文件读取** | 渲染用户 `.md`、相对图片协议 | 必须 DOMPurify；`lynel-file` 协议做 `workDir` 内白名单；`<a>` 走 `shell.openExternal` + http(s) 白名单 |
| **linked worktree watcher 失效** | `.git` 是文件 | `rev-parse --absolute-git-dir`，P2 强制前置 |
| **运行中切 worktree 导致 PTY cwd 不一致** | 会话运行中切目录 | 只允「新建会话时选」，不改运行中 `session.workDir`（§1.5 第 8 条） |
| **force push / hard reset / discard 不可逆** | 新增按钮 | 二次确认 + 文案列具体对象；默认禁用裸 `--force`，用 `--force-with-lease` |
| **pull/push 无超时导致永久 busy** | 网络异常 | 主进程加超时 + 前端可取消/重置 busy |
| **空 workDir 打到应用自身仓库** | 新增 IPC | 全部过 `withWorkDir`（`git.ts:835-842`），渲染层再拦一次 |
| **三层 IPC 不同步** | 新通道 | preload / useElectron / 主进程类型一次改齐，类型从主进程反向 import |

---

## 7. 评审决策点（请逐条确认后我再编码）

| # | 决策 | 推荐 | 影响 |
|---|---|---|---|
| Q1 | 「上下 different」= inline/unified（ Monaco 一 option ）还是上下两个独立编辑器？ | **inline/unified** | 0.5 vs 3 人日；后者违反单实例不变量 |
| Q2 | 「审阅」口径：仅 git 全量变更 / 还要 cc-haha 式「本轮改动 + 整轮撤销」？ | **两者可切换，P1 先 git，P3 补本轮** | ±1.5–2 人日 |
| Q3 | Git 入口方案 A / B / C？ | **A（顶部并排 + 上移主区）** | W3 工作量 |
| Q4 | md 相对图片/链接一期是否支持？ | **P1 降级（占位），P2 上自定义协议** | ±0.8 人日 |
| Q5 | worktree 范围：查看/切换 / + 新建删除 / + 新会话隔离启动？ | **P2 做到新建删除；隔离启动另立需求** | ±3 人日 |
| Q6 | 三模式偏好粒度：全局 / 按会话 / 按文件？默认模式？ | **全局偏好 + 按会话记忆，默认 `editor&preview`** | 小 |
| Q7 | 底部 Git tab 与「展开 Workspace」按钮如何处理？ | **一期保留兼容（点击跳顶层），二期移除；恢复顶部展开按钮** | 小 |
| Q8 | 提交历史图去留？ | **收为 Git 工作区底部可切 Tab，不删除** | 小 |
| Q9 | 代码块语法高亮 / Mermaid / KaTeX 是否要？ | **一期不要**（保「最轻量」） | 大 |
| Q10 | 是否接受 P1 / P2 / P3 分期，还是一次性全做？ | **分期，P1 先评审验收** | 交付节奏 |

---

## 附录 A：关键代码索引

| 主题 | 路径:行 |
|---|---|
| 右栏容器 / 「文件」标识 | `renderer/src/components/code/RightWorkspacePane.vue:124-168`（`:149` `.ws-label`、`:141-145` 收起入口） |
| 唯一编辑器宿主 | `renderer/src/components/code/FileEditorPanel.vue:7-30` |
| 单 Monaco 实例 / 布局坑 | `renderer/src/components/code/CodeEditor.vue:18-21, 57-79, 151-162, 215-227` |
| DiffEditor 硬编码双栏 | `renderer/src/components/code/CodeDiffView.vue:52-61` |
| md 渲染器（不可原样复用） | `renderer/src/components/trace/Markdown.vue:29-39`（fold）、`:42-135`（样式） |
| 文件树展开唯一入口 | `renderer/src/components/code/CodeView.vue:42-46`（注释） |
| Git 入口 / 默认折叠 | `renderer/src/components/code/BottomPanel.vue:43-58, 118-161` |
| Git 面板 / 顶栏 / 变更列表 / 提交 | `renderer/src/components/code/GitPanel.vue:22-55, 171-287` |
| 工作区状态 | `renderer/src/stores/files.ts:35-75`（`:65` activeView、`:68` splitOpen、`:56` diffRequest） |
| pull/commit/push | `main/git.ts:264-291` |
| watcher 硬编码 `.git` | `main/git.ts:788-807` |
| IPC 注册 / 空目录防线 | `main/git.ts:830-942` |
| 被注释的展开按钮 | `renderer/src/views/HomeView.vue:196-207` |
| 三段式挂载 | `renderer/src/views/HomeView.vue:216-254` |
| 依赖 | `renderer/package.json:13-31`（marked / dompurify / monaco-editor / vscode-textmate） |
| 门禁 | `npm run test:main`；`cd src/renderer && npx vue-tsc --noEmit`；CI `.github/workflows/build.yml:53-57` |

## 附录 B：示意图

- `../../preview/right-panel-before-after.svg` —— 现状 4 层入口 vs 目标顶部并排
- `../../preview/md-three-modes.svg` —— md 三模式布局与资源约束
- `../../preview/git-review-workspace.svg` —— Git 审阅工作区目标布局

## 附录 C：实现落地修订（相对评审稿）

评审稿保留原决策记录，此处只记最终实现与之不同的地方：

| 议题 | 评审稿 | 最终实现 |
|---|---|---|
| Q3 视图切换粒度 | `CodeView` 主体整体换成 Git 顶层视图 | **只换左栏**（文件树 ↔ `GitChangesPane`），右侧 `FileEditorPanel` 常驻。整块替换会让 `openDiff()` 打开在已被隐藏的编辑器区里，用户看不到 diff |
| Q7 底部 Git tab | 一期保留跳转入口，二期移除 | **已移除**：顶部「文件 \| Git」分段是唯一入口，底部不再有「Git 工作区」按钮与重复徽章 |
| Q8 提交历史图 | 收为 Git 工作区底部可切 Tab | **收为 Git 工作区右侧内容区**：`FileEditorPanel` 的第三个 `v-show` 视图（编辑器 / diff / 历史互斥），开关在 `GitChangesPane` 工具条「历史」按钮；`openDiff()` 自动关历史，点历史里的文件能立刻看到 diff。底部面板只剩终端 |
| 单实例约束 | 不新增 Monaco / DiffEditor | 保持：历史图是纯 DOM，三个视图共用同一个 `FileEditorPanel` 宿主，均为 `v-show` 保活 |

`GitPanel.vue` 的 `view='full'` 分支因此已无调用者，保留作历史实现，后续可单独清理。
