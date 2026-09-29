# 定时任务运行流水重设计（流式 · 动效 · agent 化渲染）

日期：2026-09-28
状态：已与用户逐项确认

---

## 1. 背景与目标

任务详情的运行流水（`RunStreamView`）目前有五个问题，本次重设计逐项解决：

1. **不流畅**：`stores/tasks.ts` 每次收到 `tasks:runEvent` 都整数组替换，`RunStreamView` 的 `computed(flattenRunEvents)` 全量重算（累计 O(n²)），卡片逐个重渲染 —— 卡顿感的主要来源。
2. **无动效**：`styles/tasks.css` 没有任何 transition/animation，事件出现、状态切换都是硬跳。
3. **空态不居中**：`TasksPane.vue` 的 `.empty-detail` 是 flex 但没写 justify/align，`.blank` 没有 `flex:1`，「还没有任务」贴左不随窗体居中。
4. **tool 展示过重**：Edit/Write 类 tool 卡默认自动展开（`RunStreamView.vue:48-49`），与其余 tool 行为不一致。
5. **不像 agent**：整体是「带 mono 状态头的日志流」，不是 agent 对话观感。

## 2. 已确认的设计决策（用户逐项拍板）

| 议题 | 决策 |
|---|---|
| tool 折叠 | **方案 A**：统一默认折叠为一行摘要（如 `⚙ Bash · npm run build ✓ 128s`），点开看详情；去掉 Edit/Write 自动展开 |
| 流式观感 | **方案 B**：除增量渲染外，加模拟流式节奏 —— 正文逐字打字机、行间隔出队 |
| 内容版式 | **方案 C · 时间轴精修**：保留时间轴骨架，节点按类型着色，正文用正常 UI 字体 + Markdown 渲染 |
| 动效 | **A–E 全要**：行滑入、打字机、状态呼吸点、tool 展开过渡、自动滚动跟随 |
| 实现路线 | **方案一 · 纯渲染层改造**：增量 flatten + 渲染层播放队列，主进程零改动 |

草图存档：`.superpowers/brainstorm/39393-1790569308/content/`（agent-render.html / animation.html）。

## 3. 架构与数据流

### 3.1 增量 flatten（性能修复）

- `stores/tasks.ts` 的 run events 改为追加式存储，每个 run 记 flatten 游标 `flattenedCount`。
- `OnTasksRunEvent` 收到推送后**只对新增 events 调用 flatten**，结果 push 进已有 items；不再整数组替换 + 全量 `computed(flattenRunEvents)`。
- `openRun` 首次 `tasks:runEvents` 全量拉取时 flatten 一次，作为游标初值。
- 一致性不变量：任意多次增量 flatten 的结果 ≡ 对同一序列全量 flatten 一次的结果（用单测锁死）。

### 3.2 播放队列 `useRunPlayback`（新增 composable）

职责：以 flatten 后的 items 为源，按节奏控制 `visibleCount`，只负责「怎么出场」，不负责「内容是什么」。

- 出队节奏按 item 类型：
  - `text`：整段容器先滑入定位，随后逐字打字机（约 12ms/字）；长文本加速，单段总时长封顶 ~1.5s；末尾显示光标。已显示过的段不再有打字机。
  - `thinking` / `init` / `tool` / `stderr`：整行滑入，间隔 ~80ms。
  - `result`：滑入 + 完成块高亮。
- **只回放实时事件**：`openRun` 拉到的历史直接全部显示（不做打字机回放）；播放队列只对「store 追加的新 events」生效。切换 run 时队列清空、timer 销毁。
- **快进**：积压 >5 条自动快进到最新；状态条提供「立即显示」手动快进。
- 打字机分段、快进阈值判定等纯逻辑放 `src/renderer/src/utils/`，可直测。

### 3.3 自动滚动跟随

- 新行出现且视口在底部 → `scrollTo({ behavior: 'smooth' })` 滚到底。
- 用户手动上滚 → 暂停跟随；滚回底部 → 恢复。
- 判定为纯函数（输入 scrollTop/scrollHeight/clientHeight + 用户意图标志，输出是否贴底）。

### 3.4 主进程

**零改动。** `runner.ts` 已按 chunk 批量推 `tasks:runEvent`，节奏控制全部在渲染层（方案一决策：UI 节奏不耦合进主进程）。

## 4. 视觉版式

- **时间轴**：保留现有连接线 + 节点结构；节点圆点按类型着色 —— prompt 蓝 / 思考紫 / 工具橙 / 完成绿 / 错误红。
- **正文**：复用 `trace/Markdown.vue`，正常 UI 字体渲染，不再 mono。
- **tool 行**：一行 mono 摘要 + 状态符号，点击平滑展开详情（3.2 的动效）；默认全部折叠。
- **thinking**：默认折叠为一行摘要，点开看全文。
- **空态居中**：`TasksPane.vue` 的 `.empty-detail` 改为撑满 + `justify-content:center; align-items:center`，`.blank` 不随内容宽度塌陷；始终位于右侧详情栏正中，随窗体 resize 自动跟随。无任务 / 无 run / run 无事件三种 blank 统一走该样式。
- **runhead**：状态点 running 时呼吸脉冲，终态静态色。

## 5. 动效清单与实现

全部 CSS 实现于 `styles/tasks.css`（打字机节奏除外，由 JS 驱动），不引动画库：

| 动效 | 实现 |
|---|---|
| 行滑入 | `@keyframes slideIn`：下方位移 10px + 淡入，0.35s ease |
| 打字机 | `useRunPlayback` 定时逐字写入 + 光标 `blink` |
| 状态呼吸点 | `box-shadow` 扩散脉冲 1.4s 循环，仅 `running` |
| tool 展开/收起 | `height` transition 0.25s + `overflow:hidden` |
| 自动滚动 | `scrollTo({ behavior: 'smooth' })` |

**reduced-motion 豁免**：用户系统关闭了 Windows 动画，`reset.css` 全局把动画压到 0.01ms。任务面板动效作用域（如 `.task-anim`）必须像 loading 菊花一样加豁免规则强制播放；打字机是 JS 驱动不受影响。

## 6. 边界与错误处理

- **切 run / 关详情**：播放队列立即销毁，未出队的行直接全部可见，不留悬挂 timer。
- **快速连发**：积压 >5 条自动快进，长流水不永远追不上；用户上滚不打断当前段打字机（播放按原节奏继续，积压超过阈值时自然快进）。
- **终态**：`tasks:finished` 到达时若队列有积压先快进，再走现有 toast / 托盘通知逻辑（不改判定）。
- **错误事件**（stderr / error result）：不做打字机，直接滑入 + 红色节点，保证错误第一时间可见。
- **渲染层消费失败**不影响任务执行（与既有不变量一致）。

## 7. 测试

- `stores` 增量 flatten 单测：多次推送增量 flatten ≡ 全量 flatten（结果一致性安全网）。
- `useRunPlayback`：fake timers 测出队节奏、快进阈值、切 run 清队、历史不回放。
- 纯函数直测：打字机分段（逐字/加速/封顶）、贴底判定。
- 回归全绿：`npm run test:main`、`cd src/renderer && npx vue-tsc --noEmit`、`cd src/renderer && npx vitest run`。

## 8. 非目标

- 不引入虚拟列表（YAGNI：增量 flatten 后几百行规模无瓶颈）。
- 不做主进程节流 / 节奏控制。
- 不改任务表单、任务列表、调度逻辑、run 历史时间轴（`RunHistoryList`）。
- 不改 toast / 托盘通知的触发判定（只保证快进发生在通知前）。
