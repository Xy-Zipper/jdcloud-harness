# Agent Note: JDCloud 浏览器 Prompt 准入

Status: implemented

[English](2026-09-07-jdcloud-browser-prompt-admission.md) | 中文

## Problem

低代码 Web 部署需要 JDCloud 密码登录，并且必须在每次提交对话请求前立即校验 Token。现有 `agent/pre-step` waterfall 在 Agent inbox 领取输入后运行。在此处拒绝会记录一次尝试的 turn 并消费已提交消息，这与登录门禁的要求冲突：认证过期时必须保持 Session 和浏览器草稿不变。同一部署还要求只有当前租户的系统管理员能够使用设置、模型选择和 Agent preset 选择；只隐藏按钮仍会留下键入命令与 Remote 模型选择调用路径。

## Decision

Session Controller 在浏览器 `prompt()` 入口公开 `api-session/prompt-admission`，位置早于附件持久化与 Agent 投递。准入 listener 接收 Session id 和调用方取消 signal，通过后调用 `next()`，拒绝时不会产生任何 Session 或 inbox mutation。该事件只管理浏览器 Prompt 提交；Agent 内部 follow-up 和其他入口继续使用各自既有策略。

Session Controller 还会在解析目标普通 Agent 后、模型校验、Session mutation 或默认模型持久化之前公开 `api-session/model-selection-admission`。拒绝 listener 会保留 Session 选择和 `agentDefaultModel`；接受 listener 必须调用 `next()`。

`dsh-api-jdcloud-auth-controller` 按既有 JDCloud 包语义重新实现 `POST /api/oauth/login`、`GET /api/system/corp/getCorpList`、`GET /api/oauth/currentUser` 与 `GET /api/system/corp/switchCorp/{corpId}`。登录不发送租户 id，通过租户与当前用户调用校验返回的 Token，并把 `{ baseUrl, token, username, corpId, corpName, corps, systemAdministrator }` 存为版本 4 Host credential record。版本 3 record 会通过一次 `currentUser` 读取升级。Remote status 公开同一 record 中除 Token 外的字段。租户切换和每次浏览器 Prompt 准入都会刷新租户状态与 `userPermission.systemAdministrator`；业务码 `600`、`601`、`602` 删除 record，其他业务错误与 transport 错误保留登录并只拒绝当前操作。模型选择准入 listener 会在 Session Controller 修改模型状态前拒绝非管理员。

`dsh-client-ui-commands` 接受可释放的可用性过滤器，并将其应用于 Host 与 Client 命令候选项、leading-input claim、过期 pick 和键入后的 Enter 调用。当当前租户不是系统管理员时，`dsh-client-ui-jdcloud-login` 会安装 `/model` 过滤器，并以 priority `-100` 覆盖 `sidebar.settings`、`conversation.input.model` 和 `conversation.hero.agentPreset`。租户变化会根据返回的认证状态更新这些控件。普通用户的新 Session 不携带客户端选择的模型和 preset，因此使用 Host 默认值；已有 Session 的持久选择保持不变。

登录 Client 仍会挂载生成的 Remote contribution，并在 Host 报告未登录时以 priority `-100` 覆盖内置 `root` slot。移除该覆盖会重新显示已有应用树，因此 Session 与草稿状态得到保留。登录后，插件填充 `sidebar.account`；其菜单列出全部租户、标记当前租户、切换时不恢复登录页，并通过删除 Host record 退出登录。转发的 `credentials/record-updated` 事件会在退出、过期、校验刷新或租户变化后重新应用登录与管理员控件。重新认证永不自动提交保留的草稿。

可选的 `dsh-jdcloud-login` bundle 插入 Host 与 Client row，并将 `JDCLOUD_DEFAULT_BASE_URL` 映射为 controller 的初始地址。默认 Web bundle 保持与 JDCloud 解耦。

## Alternatives considered

**复制完整 `@jdcloud/api` 包。** 拒绝，因为它的全局请求状态、宽泛 endpoint 清单和前端环境假设不适合 Host 所有的 credentials 与 Harness Remote 生命周期。只重新实现三个必需调用，使自有表面积保持可审计。

**在 `agent/pre-step` 校验。** 拒绝，因为 inbox 此时已经领取消息。校验失败会消费用户输入，并为本不应进入 Session 的请求创建 Agent 生命周期记录。

**加入 Client router 并导航到 `/login`。** 拒绝，因为 Web Client 通过 Slots 组合，本需求不需要路由。root 覆盖能保留已经挂载的应用，也不需要第二套导航状态机。

**把 Token 存在浏览器 storage。** 拒绝，因为这会让 secret 进入浏览器持久化，并在 Host 与 Client 之间复制权威状态。Client 只需要脱敏认证状态。

**只在 React component 中隐藏管理员控件。** 拒绝，因为 `/model` 和 `session.selectModel` 仍会成为替代模型选择路径。Slot 覆盖、命令过滤与 Host 准入会在每个能够修改该决定的操作中执行同一授权。

**强制已有 Session 恢复 Host 默认模型。** 拒绝，因为持久 request header 是历史模型选择。管理员策略管理新的选择操作和普通用户的新 Session，而不重写既有对话行为。

## Consequences

- 浏览器 Prompt 策略现在能在附件、Session event、queue entry 或 Agent inbox 投递前拒绝请求。
- JDCloud Token 存储与校验留在 Host；浏览器只在显式登录调用期间发送密码。
- 浏览器会收到侧边栏所需的账号、当前租户和完整可用租户列表，但永远不会收到 Token。
- 浏览器还会收到当前租户的管理员布尔值；普通用户不能打开设置、选择模型或 Agent preset，也不能调用 `/model`。
- 普通用户的直接模型选择 Remote 调用会在模型校验或持久化前被拒绝。
- 普通用户的新 Session 使用实时 Host 默认模型，已有 Session 保留持久模型选择。
- 租户切换成功会更新服务端 Token 上下文与侧边栏状态，不显示登录页。
- Token 过期会恢复登录页并保留当前应用状态，但用户必须再次显式提交草稿。
- `api-session/prompt-admission` 有意比通用入口策略更窄；未来的非浏览器入口需选择各自的准入点。
