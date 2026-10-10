# Agent Note: Session 变更前的浏览器 Prompt 准入

Status: implemented

[English](2026-09-07-browser-prompt-admission.md) | 中文

## Problem

应用登录可能在浏览器提交 Prompt 前一刻过期。现有 `agent/pre-step` waterfall 在 Agent inbox 领取输入后运行，因此在此处拒绝会记录一次尝试的 turn 并消费已提交消息。浏览器鉴权策略需要更早的操作，在登录校验失败时保持附件、Session 日志、Agent inbox 与保留的草稿不变。

## Decision

Session Controller 在浏览器 `prompt()` 入口公开 `api-session/prompt-admission`，位置早于附件持久化与 Agent 投递。准入 listener 接收 Session id 和调用方取消 signal，通过后调用 `next()`，拒绝时不会产生任何 Session 或 inbox mutation。该事件只管理浏览器 Prompt 提交；Agent 内部 follow-up 和其他入口继续使用各自的准入策略。

Ontology 鉴权 controller 注册准入 listener，用于校验或刷新当前浏览器的 Runtime Session。登录缺失或过期时，它会报告分类明确的鉴权错误。Controller 只把 Token 存在由不透明 browser-session id 定位的 Host credential 中，Client 只接收脱敏账号状态。

Ontology Web layer 会关闭共享 Harness 启动鉴权并启用签名浏览器会话。因此即使多个浏览器连接同一服务器进程，每个浏览器仍会选择自己的 credential record。Credential 更新事件会刷新登录呈现并重启 Session 与 Workspace 流，同时不暴露已存 payload。

## Alternatives considered

**在 `agent/pre-step` 校验。** 拒绝，因为 inbox 此时已经领取消息。校验失败会消费用户输入，并为本不应进入 Session 的请求创建 Agent 生命周期记录。

**把登录页面当作充分的强制措施。** 拒绝，因为浏览器代码只负责呈现，而 Remote Prompt 调用仍然可被直接调用。接受 Prompt 的 Host 操作必须强制执行鉴权。

**保存一个进程全局当前用户。** 拒绝，因为一个服务器会服务多个浏览器。进程全局身份会让所有已连接浏览器都以最近完成鉴权的用户身份运行。

**把 Runtime Token 存在浏览器 storage。** 拒绝，因为浏览器持久化会暴露 secret，并在 Host 与 Client 之间复制权威状态。Client 只需要脱敏身份与鉴权状态。

## Consequences

- 浏览器 Prompt 策略可以在附件、Session event、queue entry 或 Agent inbox 投递前拒绝请求。
- Runtime Token 只存在 Host 且按浏览器隔离；多个用户可以共享同一服务器进程而不共享身份。
- 登录过期会恢复登录呈现并保留应用状态，但用户必须在重新鉴权后显式再次提交草稿。
- `api-session/prompt-admission` 有意比通用入口策略更窄；每个非浏览器入口需选择自己的准入点。
