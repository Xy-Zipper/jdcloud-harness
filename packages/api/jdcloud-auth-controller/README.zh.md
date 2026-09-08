---
description: "Host 侧 JDCloud 认证、持久 Token 所有权、浏览器 Prompt 准入校验与已认证 API 复用。"
kind: "package-reference"
---

# JDCloud Auth Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-jdcloud-auth-controller` 实现低代码登录流程所需的 JDCloud 调用：密码登录、租户列表校验与租户切换。它在 Host credentials 中拥有 Token，公开生成的 `jdcloudAuth` Remote namespace，让其他 Host 插件在不读取 Token 的情况下复用已认证连接，并在每个浏览器 Prompt 进入 Session 前检查租户列表。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将 controller 与 API Gateway、Session Controller 和可写 credentials provider 一起挂载。可选的 [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.zh.md) bundle 会同时安装 controller 与浏览器登录页。

`login()` 使用原接口的 `client_id=admin`、`client_secret=123456`、`scope=all` 和 `grant_type=password` query 参数调用 `POST /api/oauth/login`。JSON body 只包含去除首尾空白的账号和 MD5 密码，不发送租户 id。收到 Token 后，controller 会调用 `GET /api/system/corp/getCorpList`，合并 `corpList` 与 `joinCorpList`，解析 `data.corpId` 指定的当前租户，并一起保存规范化服务地址、Token、账号、当前租户和可用租户列表。

`switchCorp()` 只接受认证状态中返回的租户，使用已保存的 Token 调用 `GET /api/system/corp/switchCorp/{corpId}`，随后再次读取租户列表。JDCloud 会在服务端刷新 Token 对应的租户上下文，因此 controller 保留已保存的 Token。切换成功会返回已确认租户的认证状态；普通失败保留当前登录，业务码 `600`、`601`、`602` 则删除过期登录。

Session Controller 在持久化附件或投递浏览器 Prompt 前，controller 会使用已保存的 Token 调用同一租户列表接口。业务码 `600`、`601`、`602` 会删除登录记录，并以 Token 过期拒绝本次 Prompt。网络失败和其他业务码只拒绝本次提交，不删除登录状态。

登录后，浏览器可以读取 `{ authenticated, baseUrl, username, corpId, corpName, corps }`；Token 永不经过 Remote wire。`logout()` 会删除完整 credential record。密码只在登录调用期间存在，本包不会保存密码。

Host 插件可以使用 `requestAuthenticated({ path, method, body? }, signal)` 请求固定的 `/api/...` 路径。controller 会在内部读取当前 credential、添加 authorization header、应用 `requestTimeoutMs`，并只返回成功响应中的 `data`，不会返回 Token。该方法接受 JSON `GET`、`POST`、`PUT` 和 `DELETE` 请求；`GET` 会绕过缓存。业务码 `600`、`601`、`602` 会删除登录并转换为 `jdcloud/auth-required`，其他业务错误保留登录状态。

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `defaultBaseUrl` | 空 | 尚未保存登录时显示的初始服务地址 |
| `requestTimeoutMs` | `15,000` | 登录、租户列表、租户切换与 Host 已认证请求的截止时间 |

<a id="model-experience"></a>
## 模型体验

无，因为 Prompt 准入发生在 Session 或 Agent 投递前，不加入任何模型可见内容。

#### KV Cache 影响

无；通过校验的请求内容不变，被拒绝的请求不会进入 Prompt 组装。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `requestAuthenticated()` 仅供 Host 使用并支持 JSON body；它不是浏览器代理或 multipart 上传客户端。
- 登录接口沿用 JDCloud 上游要求的 MD5 wire 行为；它不是密码存储方案。
- 保存的登录状态属于该 controller 实例的 Host 全局状态，不按浏览器用户隔离。

<a id="dev-note"></a>
### 开发备注

无。

**运行时不变式：** 不发布伴生入口。controller 每次读取自有 credential record 时都会校验其字段，Prompt 准入在投递前校验 Token。
