# Agent Note: 远程 Web 部署由服务器管理模型

Status: implemented

[English](2026-09-15-server-managed-models-for-remote-web.md) | 中文

## Problem

Models 页面依赖 Host settings mirror，但该 mirror 在非 loopback 浏览器中按设计保持不可用。因此远程部署显示 `settings are unavailable in this browser`，而不是活动提供方目录。DeepSeek 首次运行弹窗还要求浏览器用户管理服务器凭据，但 JDCloud Docker 部署提供的是 `GPT_API_KEY`，镜像内置的 `deepseek-official` 路由读取的是 `DEEPSEEK_API_KEY`。

## Decision

远程 Web 部署由服务器统一管理模型配置。`ui-settings-models` 不注册 DeepSeek 首次凭据弹窗。settings mirror 不可用时，Models store 把 Host 当前活动的提供方路由发布为只读行，并省略 settings、凭据状态与全部修改控件。

JDCloud Compose 文件把部署必填的 `GPT_API_KEY` 同时注入为 `GPT_API_KEY` 和 `DEEPSEEK_API_KEY`。因此镜像内置的 DeepSeek 对话路由与 DeepSeek Web 搜索路由可以解析同一份服务器 secret，无需浏览器写入，也无需把凭据固化进镜像。只有部署需要自定义端点、模型 id 或目录时，管理员才编辑 `$DSH_HOME/settings.yaml`。

loopback Models 编辑器保留既有 settings 与凭据行为。移除首次弹窗并不代表模型凭据变成可选项，而是把该凭据的所有权移交给服务器部署。

## Alternatives considered

**允许所有远程浏览器访问 Host settings。** 未采用，因为 loopback 限制用于保护 settings 与凭据管理操作，不让网络客户端直接调用。JDCloud Login 会认证应用用户，但不会为每一项 Host settings 修改建立逐用户授权。

**在远程浏览器中隐藏 Models 分区。** 未采用，因为活动提供方目录有助于诊断服务器配置，并且可以在不发送 settings 值或凭据状态的前提下展示。

**把适配器默认凭据引用重命名为 `GPT_API_KEY`。** 未采用，因为 `DEEPSEEK_API_KEY` 是仓库中其他 profile 与包共同使用的 DeepSeek 默认值。部署层别名范围更窄，并保留既有组合的行为。

## Consequences

远程用户可以打开 Models 并查看哪些提供方路由处于活动状态，同时不会收到服务器 settings 或凭据元数据。他们不能从浏览器编辑模型配置，也不会被首次 API Key 弹窗阻塞。JDCloud Docker 部署只需提供一份 `GPT_API_KEY` 即可使用默认 DeepSeek 路由；自定义端点与模型目录仍属于明确的服务器配置。
