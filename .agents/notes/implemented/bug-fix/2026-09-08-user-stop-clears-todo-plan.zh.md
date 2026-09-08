# Agent Note: 用户停止时清空 todo 计划

Status: implemented

[English](2026-09-08-user-stop-clears-todo-plan.md) | 中文

## 问题

用户点击 Web 停止后，活跃的 `todo_write` 计划仍保持可见。agent 循环正确记录了 `turn/end { kind: 'aborted', reason: { kind: 'user' } }`，但 `todos` 投影会保留最新列表直至下一次 `turn/start`，因此轮次已经停止后，`in_progress` 任务看起来仍在运行。[按轮次界定的计划生命周期](../feature/2026-07-28-todo-plan-clears-on-next-turn.zh.md)已经决定，普通完成的轮次仍需保留清单供用户阅读回答时查看。

## 决策

当 `turn/end` 记录 `aborted` 原因且取消来源为 `user` 时，`todos` 投影返回 `null`。它也保留既有的 `turn/start` 清空规则；正常完成、父任务取消、hook 取消、释放、错误、阻塞、达到最大 token、崩溃修复型 `interrupted` 及扩展定义的轮次结束原因都会保留最新列表。持久化 `todo/write` 事件保持不变，因为该规则控制当前 UI 投影，而非已记录的模型操作。

投影使用 `stateVersion` 3，使持久化的版本 2 缓存行按新规则重新折叠。独立客户端 fixture 镜像相同折叠。Web live-interactions 场景在停止前显示面板，并断言用户中止的轮次结算后面板消失。

## 考虑过的替代方案

- **在每个 `turn/end` 清空**——这还会在用户阅读回答时隐藏正常完成的清单。
- **追加空的 `todo/write`**——这会伪造模型编写的更新，并为呈现生命周期规则修改持久状态。
- **新增 `cancelled` todo 状态**——隐藏面板不需要新的条目状态、事件载荷、工具 schema 或 UI 处理。
- **在 `interrupted` 时清空**——该原因描述崩溃修复而非停止按钮，因此无法修复所报告的问题。

## 后果

用户点击停止后，用户中止型 `turn/end` 一到达投影，当前任务面板就会隐藏，重新打开该会话也不会恢复已停止的计划。其他取消来源会保留计划直至下一轮次开始，因为它们不是用户直接点击停止的操作。会话日志仍保留已提交的任务列表供审计和回放使用；该事件仍不会进入模型历史。
