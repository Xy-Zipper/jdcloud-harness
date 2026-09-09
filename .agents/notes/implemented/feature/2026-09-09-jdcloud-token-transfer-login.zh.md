# Agent Note: JDCloud Token 中转登录

Status: implemented

[English](2026-09-09-jdcloud-token-transfer-login.md) | 中文

## Problem

JDCloud 用户可能从已经持有 JDCloud Token 的公司页面进入 Harness。Web 应用只提供明确的 index 路径，浏览器认证保留了 `token` query 名称，而且浏览器代码不得持久化或直接使用 JDCloud credential。绑定 authority 的浏览器 cookie 还是 `SameSite=Strict`，因此跨站重定向链无法把已有 cookie 携带到应用 index。中转链接不能仅实现为 Client 路由，也不能原样转发到应用根路径。

## Decision

现有 JDCloud 登录 UI 插件拥有精确的 `/login/transfer` Host 路由及其 Client root contribution。Host 路由返回禁止缓存的文档，其中受 nonce 限制的内联脚本会重命名传入的 `token` 参数，并发起到已认证 Web 根路径的同站导航。内部值通过 URL fragment 传给 Client 代码，因此 JDCloud Token 不会进入根路径请求和子资源 Referer。第二次导航能够携带已有的 Strict cookie，同时不改变 Connection 认证。Client 只读取一次内部参数，并在校验前立即把可见 URL 替换为 `/login/transfer`。中转 root 的 priority 为 `-110`，高于账号密码登录 root；成功后显示应用，失败后提供返回账号密码登录的明确操作。

认证 controller 负责中转 Token 的校验与保存。`loginWithToken()` 会删除旧登录、接受任意规范化的绝对 HTTP(S) 服务地址、调用 `GET /api/oauth/currentUser` 与 `GET /api/system/corp/getCorpList`，要求两个响应指向同一当前租户，并且只在全部校验通过后提交 Token。`defaultBaseUrl` 仍是账号密码登录的初始值，不限制中转地址。

## Alternatives considered

**让静态前端把所有未知路径作为 SPA index 返回。** 未采用，因为一个可选登录集成不应改变共享静态服务器明确返回 404 的行为，也不应扩大本功能的路由修改范围。

**在浏览器 local storage 中校验并保存 Token。** 未采用，因为现有 controller 明确在 Host 拥有 JDCloud credential，浏览器插件只能读取脱敏认证状态。

**把 `/login/transfer?token=...` 直接转发到 `/`。** 未采用，因为 Connection 保留根路径的 `token` query 参数作为 Harness 启动 credential，JDCloud Token 会被解释为无效的浏览器认证 Token。

**重命名 Token 后使用 HTTP 重定向。** 未采用，因为其他站点打开的窗口仍处在跨站重定向链中，浏览器不会在重定向后的 index 请求中携带 `SameSite=Strict` Harness cookie。

**使用 JDCloud Token 签发 Harness 浏览器 cookie。** 未采用，因为 JDCloud 登录不授予本地 Harness 进程的访问权；Connection 仍独立负责浏览器认证。

**只允许配置中的中转服务地址。** 未采用，因为该集成需要接受每个来源链接选择的租户环境，而无需更新 Host 配置。

## Consequences

中转入口与所有 Web index 一样，需要已有 Harness 浏览器认证 cookie。浏览器必须先交换一次 `dsh web` 打印的启动 URL，之后跨站中转链接才能使用该 cookie。无效中转链接会在显示恢复页前删除旧 JDCloud 登录，这与来源页面流程一致。由于来源链接控制服务地址，它可以把携带的 Token 发送到任意 HTTP(S) 服务器，并让 Host 请求私有网络地址；部署环境需要信任链接生成方选择正确的 JDCloud 服务。
