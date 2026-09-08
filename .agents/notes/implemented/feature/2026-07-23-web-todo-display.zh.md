# Agent Note: Web todo 展示——Host 投影 + 两个渲染面

Status: implemented

[English](2026-07-23-web-todo-display.md) | 中文

## 问题

`todo_write` 把 `todo/write` 的整份列表快照追加进会话日志；TUI 渲染一块常驻的 plan 面板（自动化专用的 ACP（Agent Client Protocol）桥接刻意不做 todo 呈现）。Web 客户端把这个事件整个丢弃了：host mux 流本已转发每一个会话事件，但 `todo/write` 不是 surface 类型（它从不 fold 进 `ConversationSnapshot.nodes`），也没有任何副作用分支累积它——浏览器既无消费点，也无展示面。

## 决策

把 `todo/write` 折叠进 Host 会话投影，而非对话节点，并在两个面上渲染它，这两个面正对应 TUI 已经绘制的那套划分。

### Host 投影，通过基线与帧收敛

`dsh-tool-todo` 通过 `ctx.sessionProjections` 注册 `todos` 单元。它的 Host 折叠把每个 `todo/write` 作为整份列表替换，在 `turn/start` 和用户中止型 `turn/end` 时返回 `null`，并为其他事件保留当前引用（[按轮次界定的计划生命周期](2026-07-28-todo-plan-clears-on-next-turn.zh.md)、[用户停止修正](../bug-fix/2026-09-08-user-stop-clears-todo-plan.zh.md)）。Session Controller 在会话 follow 打开基线和控制流基线中携带已完成的值，并把后续变化发布为整值 `projection` 帧。每个会话的 `ProjectionValueStore` 按较高序号优先规则合并这些输入，并暴露标识稳定的逐键读取面；浏览器不执行 todo 专用事件折叠，`ConversationSnapshot` 也不携带投影值。标准件把该读取面绑定为 `useProjection`，`TodoDock` 再读取 `useProjection('todos')`：列表会渲染横条，而 `null` 或缺失的 `undefined` 值不会渲染任何内容。当前值不进入对话节点，从而避免已被取代的 todo 快照显示成当前对话内容。

### TodoPanel：持久化列表作为一条常驻横条

面板经 `conversation.input.dock` slot 挂载（普通注册者插件 `todoDockEntry` 使用 `ctx.slots.inject`，不依赖 `ConversationController`，`order: 0` 排在队列条上方），空列表时隐藏，可折叠为标题加以 `·` 连接的各状态计数的表头（本地化，形如 `1 已完成 · 2 进行中 · 1 待处理`，计数为零的段落省略；折叠态不再附带进行中条目正文）。状态图标为 figma todo 套件（绿色勾选环／蓝色渐隐环／虚线未开始环），卡片使用 tip 表面（`--dsw-specific-tip`、14px 圆角、`width: calc(100% - 88px)`／`max-width: 776px` 居中；InputBar 顶部 6px 内边距是到输入卡的间距）。它经 dock entry 收到的标准件 `useProjection` hook 读取 host 计算的 `todos` 投影——无 store、无 service、无 ctx。内部组件保持 props 完备且框架无关；dock 适配件只是一行包装。

### TodoRow：经 keyed toolview slot 的逐调用行

专用的 `todo_write` 对话行是一个普通注册者插件（`todoToolview`，由 `apply` 挂载），经 `ctx.slots.inject` 注册进 keyed 的 `tool.call.toolview` slot，遵循与 bash 样例相同的声明生命周期，但属产品级注册。摘要由调用 args 推导（`N/M done · first active item`，其余活跃项的 `+<n>` 计数放在 `ToolRow` 的不收缩 `summarySuffix` 位里）；无法解析的 args 回退到通用行摘要；点击会以原始 args 打开 details 列。todo 不新增任何 `ToolEventView`——呈现归客户端所有，常驻列表从会话事件渲染，而非工具卡。

## 考虑过的替代方案

- **把 todo 写入作为 surface 条目折叠进 `nodes`**——回放的窗口会渲染每一份已被取代的列表；该事件被刻意设计成非 surface 类型。
- **面板硬编码进 `ConversationRoot`**——input-dock slot 出现之前的原始落点；dock 是本架构给「composer 上方常开横条」安排的位置，硬编码绕开了 slot 注册表的 disposal 与定序。
- **面板放进 details 列**——details slot 单占用且由选中驱动，生命周期不同于一条常开横条。
- **host 计算的视图（一个 todo `ToolEventView`）**——呈现属于客户端；协议已在事件载荷里携带整份快照。

## 后果

持久化 `todo/write` 事件仍是当前计划的来源，而 Host 投影和通用传输／存储路径是客户端读取它的唯一途径。冷打开和重连会为同一个逐会话 `ProjectionValueStore` 播种，实时帧继续推进它，向前加载更早的历史页不会改变它；因此，用户停止会隐藏横条，但不会追加伪造的空写入，也不会删除已记录的工具调用和事件。自动化专用的 ACP 桥接不呈现 todo，而 Web 保留投影驱动的 dock 和独立的逐调用 `todo_write` 行。`packages/todo/tool-todo/tests/projection.spec.ts` 固定正常完成、用户中止和其他中止来源的生命周期；`packages/api/session-controller/tests/projection-store.client.spec.ts` 固定基线／帧排序；`packages/client/ui-conversation/tests/todo-panel.client.spec.tsx` 固定 dock；Web live-interactions 场景固定用户停止后面板消失。
