---
description: "按浏览器隔离的 Ontology Runtime 鉴权、仅 Host 可见的轮换 Token 存储、稳定用户归属与 Prompt 准入。"
kind: "package-reference"
---

# Ontology Auth Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-ontology-auth-controller` 让每个浏览器登录部署方指定的 Ontology Runtime，且不会把 Access Token 或 Refresh Token 暴露给浏览器代码。它会校验返回的身份、通过 credential store 轮换已过期的 Access Token、提供稳定用户归属键，并在该浏览器未登录时拒绝 Prompt。Ontology Web bundle 使用本包；JDCloud 部署继续使用现有 JDCloud controller。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 controller 与可写 credentials 和独立 browser-session 服务一起挂载：

```yaml
- name: '@deepseek-ai/dsh-api-ontology-auth-controller'
  config:
    ontologyBaseUrl: https://ontology.example.com
    requestTimeoutMs: 15000
    allowInsecureLoopback: false
```

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `ontologyBaseUrl` | 必填 | 固定的 Ontology Runtime 服务地址；除显式允许的 loopback 开发地址外必须使用 HTTPS。 |
| `requestTimeoutMs` | `15000` | 登录、当前用户校验、刷新与注销的网络截止时间。 |
| `allowInsecureLoopback` | `false` | 只允许 `localhost`、`127.0.0.1` 或 `::1` 显式使用 HTTP。 |

完整字段以生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-ontology-auth-controller)为准。

浏览器调用 `login()` 时只提交账号和密码。Host 调用 Runtime 登录与当前用户接口，把两种 Token 保存到 credential provider，并只返回服务地址与身份。存储的 Access Token 被 `runtime_unauthenticated` 拒绝后，会在 provider 的 record lock 内刷新；刷新失败只删除该浏览器的 record。当前用户校验只在身份字段变化时写入 record，因此其更新事件不会触发校验循环。`logout()` 先撤销选中的 Runtime Session，再删除该 record。

仅 Host 可见的消费者使用固定 `/api/runtime/` 路径、方法与可选 JSON 请求体调用 `requestAuthenticated()`。Controller 选择当前浏览器 record，校验或刷新它，附加 Access Token，并在该请求报告 Access Token 过期时重试一次。消费者仍负责校验返回的不可信 JSON。

Credential id 包含 `SHA256(ontologyBaseUrl + browserSessionId)`。`currentScopeKey()` 则返回 `SHA256(ontologyBaseUrl + userId)`，因此同一 Ontology 用户的独立登录会得到相同的稳定归属。Prompt 准入会在 Session 投递前校验或刷新当前浏览器登录。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

Controller 不保存进程全局用户。`BrowserSessionService` 提供请求本地的不透明浏览器 id，credential provider 串行化 Token 轮换，Runtime `current` 响应提供稳定用户与授权版本。Remote 方法只返回脱敏值。

| 源码 | 职责 |
|---|---|
| [`src/client.ts`](src/client.ts) | HTTPS 策略、Runtime 身份请求与响应校验。 |
| [`src/index.ts`](src/index.ts) | 按浏览器隔离的 record、刷新、注销、稳定归属键与 Prompt 准入。 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 Remote 请求、状态与错误类型。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [浏览器 Connection](../../client/connection/README.zh.md)——签名的独立浏览器会话。
- [Credentials](../../credentials/credentials/README.zh.md)——持久化的 owner 自定义 record 与串行轮换。
- [Ontology 登录 UI](../../client/ui-ontology-login/README.zh.md)——浏览器登录与账号呈现。
- [Ontology 登录 bundle](../../bundle/ontology-login/README.zh.md)——完整 Web profile 组合。

-----

<a id="model-experience"></a>
## 模型体验

无，因为鉴权准入会在 Session 投递前拒绝未登录 Prompt，且不会增加模型可见内容。

#### KV Cache 影响

已接受的 Prompt 不发生变化；被拒绝的 Prompt 不会进入模型请求组装。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Session 与 Workspace 归属消费者尚未使用 `currentScopeKey()`；本阶段公开并测试稳定身份，但不包含后续 Ontology 部署切换。
- 本包不管理自定义证书颁发机构配置；生产 HTTPS 使用 Host Node.js 的信任配置。
- 已鉴权 Runtime 传输只接受不含查询字符串或 fragment 的固定 `/api/runtime/` 路径；消费包负责选择请求并校验响应。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Controller 在读取任一种 Token 前都会校验 owner 自定义 credential record。
