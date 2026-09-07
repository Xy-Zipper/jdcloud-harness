# Agent Note: JDCloud 浏览器 Prompt 准入

Status: implemented

[English](2026-09-07-jdcloud-browser-prompt-admission.md) | 中文

## Problem

低代码 Web 部署需要 JDCloud 密码登录，并且必须在每次提交对话请求前立即校验 Token。现有 `agent/pre-step` waterfall 在 Agent inbox 领取输入后运行。在此处拒绝会记录一次尝试的 turn 并消费已提交消息，这与登录门禁的要求冲突：认证过期时必须保持 Session 和浏览器草稿不变。

## Decision

Session Controller 在浏览器 `prompt()` 入口公开 `api-session/prompt-admission`，位置早于附件持久化与 Agent 投递。准入 listener 接收 Session id 和调用方取消 signal，通过后调用 `next()`，拒绝时不会产生任何 Session 或 inbox mutation。该事件只管理浏览器 Prompt 提交；Agent 内部 follow-up 和其他入口继续使用各自既有策略。

`dsh-api-jdcloud-auth-controller` 按既有 JDCloud 包语义重新实现 `POST /api/oauth/login`、`GET /api/system/corp/getCorpList` 与 `GET /api/system/corp/switchCorp/{corpId}`。登录不发送租户 id，使用租户列表调用校验返回的 Token，并把 `{ baseUrl, token, username, corpId, corpName, corps }` 存为 Host 自有 credential record。Remote status 会公开同一 record 中除 Token 以外的字段。租户切换使用已保存的 Token，通过再次调用租户列表确认新的服务端上下文，并且只更新租户字段。每次浏览器 Prompt 准入都会重复租户列表调用并同步变化的租户字段。业务码 `600`、`601`、`602` 会删除 record；其他业务错误与 transport 错误保留登录，只拒绝当前操作。

`dsh-client-ui-jdcloud-login` 挂载生成的 Remote contribution，并在 Host 报告未登录时以 priority `-100` 覆盖内置 `root` slot。移除该覆盖会重新显示已有应用树，因此 Session 与草稿状态得到保留。登录后，插件会用账号和当前租户填充可选的 `sidebar.account` 席位；其菜单列出全部租户、标记当前租户、切换时不恢复登录页，并通过删除 Host record 退出登录。转发的 `credentials/record-updated` 事件会在退出或认证过期后移除账号席位并恢复登录页。重新认证永不自动提交保留的草稿。

可选的 `dsh-jdcloud-login` bundle 插入 Host 与 Client row，并将 `JDCLOUD_DEFAULT_BASE_URL` 映射为 controller 的初始地址。默认 Web bundle 保持与 JDCloud 解耦。

## Alternatives considered

**复制完整 `@jdcloud/api` 包。** 拒绝，因为它的全局请求状态、宽泛 endpoint 清单和前端环境假设不适合 Host 所有的 credentials 与 Harness Remote 生命周期。只重新实现三个必需调用，使自有表面积保持可审计。

**在 `agent/pre-step` 校验。** 拒绝，因为 inbox 此时已经领取消息。校验失败会消费用户输入，并为本不应进入 Session 的请求创建 Agent 生命周期记录。

**加入 Client router 并导航到 `/login`。** 拒绝，因为 Web Client 通过 Slots 组合，本需求不需要路由。root 覆盖能保留已经挂载的应用，也不需要第二套导航状态机。

**把 Token 存在浏览器 storage。** 拒绝，因为这会让 secret 进入浏览器持久化，并在 Host 与 Client 之间复制权威状态。Client 只需要脱敏认证状态。

## Consequences

- 浏览器 Prompt 策略现在能在附件、Session event、queue entry 或 Agent inbox 投递前拒绝请求。
- JDCloud Token 存储与校验留在 Host；浏览器只在显式登录调用期间发送密码。
- 浏览器会收到侧边栏所需的账号、当前租户和完整可用租户列表，但永远不会收到 Token。
- 租户切换成功会更新服务端 Token 上下文与侧边栏状态，不显示登录页。
- Token 过期会恢复登录页并保留当前应用状态，但用户必须再次显式提交草稿。
- `api-session/prompt-admission` 有意比通用入口策略更窄；未来的非浏览器入口需选择各自的准入点。
