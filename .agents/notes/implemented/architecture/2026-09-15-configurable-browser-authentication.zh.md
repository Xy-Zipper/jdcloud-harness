# Agent Note: 可配置浏览器认证

Status: implemented

[English](2026-09-15-configurable-browser-authentication.md) | 中文

## 问题

部分部署把 Web profile 放在既有身份网关后，或接受依赖应用登录的风险。此时强制 Harness 启动令牌交换会增加第二次登录步骤，并阻止直接访问根 URL。全局删除认证会削弱每个本地和默认部署；把特定 profile 的登录当作 Host 传输认证，则会让 Connection 耦合到一个应用 bundle，而且仍不能覆盖登录前可调用的 Host endpoint。

## 决策

`dsh-client-connection` 提供默认值为 `true` 的 `browserAuthentication`。默认模式保留启动令牌交换、绑定 authority 的签名 cookie，以及完整 Host API 上统一的 401 响应。

显式设置 `browserAuthentication: false` 只关闭 Harness 浏览器会话校验。`authenticatedUrl()` 返回干净的应用 URL，`authorizeIndex()` 允许 index 请求，可信 API 与 WebSocket 请求不要求 cookie。Host/Origin 与 Fetch-Metadata 校验仍然生效，并对不可信或跨站请求返回 403。

JDCloud Docker 组合通过 `docker.no-browser-auth.patch.yml` 应用该退出配置。因此，其公开端口依赖部署方的网络控制，并在预期用户流程中依赖 JDCloud Login；JDCloud Login 不被视为每个 Host endpoint 都已有已认证用户的证明。

## 验证

Connection 单元覆盖证明退出配置返回干净 URL、允许无 cookie 的可信请求，并保留返回 403 的信任围栏。真实 CLI 测试使用部署 overlay 启动 `dsh web`，无需 token 即可提供 index，无需 cookie 即可调用 Host API，并拒绝不可信 Host。既有认证测试继续固定默认令牌与持久 cookie 行为。

## 曾考虑的替代方案

**全局关闭浏览器认证。** 这会在没有显式部署决策时暴露既有本地和默认 Web profile。默认开启的配置保留其当前保护。

**把 JDCloud Login 用作 Connection 认证器。** Connection 由未安装 JDCloud Login 的 profile 共享，而且多个 Host endpoint 在该应用登录完成前已经存在。保持两层独立可避免不完整的传输身份规则。

**让反向代理自动完成令牌交换。** 代理必须发现并保留进程凭据，而且会重新建立一套隐藏认证机制。显式配置可以直接说明部署的实际策略。

## 后果

退出认证的部署在 Host 传输层没有 Harness 用户身份。任何通过 Host/Origin 校验的客户端都能调用完整 API、打开 WebSocket 流、访问 Session 和文件，并在 JDCloud Login 完成前调用具有工具能力的操作。部署方必须通过防火墙、私有网络或上游认证网关限制可达性。

默认部署无需修改配置即可保留浏览器认证。信任围栏在两种模式下都保持强制，并且不能替代身份认证。
