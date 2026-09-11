---
description: "Host 侧 JDCloud 认证、持久 Token 所有权、浏览器 Prompt 准入校验与已认证 API 复用。"
kind: "package-reference"
---

# JDCloud Auth Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-jdcloud-auth-controller` 实现低代码登录流程所需的 JDCloud 调用：密码登录、Token 中转登录、租户和当前用户校验与租户切换。它在 Host credentials 中拥有 Token 与当前租户管理员标记，公开生成的 `jdcloudAuth` Remote namespace，让其他 Host 插件在不读取 Token 的情况下复用已认证连接，并校验浏览器 Prompt 与模型选择。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将 controller 与 API Gateway、Session Controller 和可写 credentials provider 一起挂载。可选的 [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.zh.md) bundle 会同时安装 controller 与浏览器登录页。

`login()` 使用原接口的 `client_id=admin`、`client_secret=123456`、`scope=all` 和 `grant_type=password` query 参数调用 `POST /api/oauth/login`。JSON body 只包含去除首尾空白的账号和 MD5 密码，不发送租户 id。收到 Token 后，controller 依次调用 `GET /api/system/corp/getCorpList` 与 `GET /api/oauth/currentUser`，要求两个响应指向同一租户，并一起保存规范化服务地址、Token、账号、当前租户、可用租户和 `userPermission.systemAdministrator === true` 的结果。

`loginWithToken()` 会先删除已保存登录，规范化传入的绝对 HTTP(S) 服务地址，并依次通过 `GET /api/system/corp/getCorpList` 与 `GET /api/oauth/currentUser` 校验传入 Token。两个响应必须指向同一当前租户。中转成功后，Host 保存账号显示名、租户列表、管理员标记与 Token；无效或失败的中转信息会让 controller 保持未登录状态。调用方控制请求目的地，因此 Host 会把 Token 和校验请求发送到任意语法合法的 HTTP(S) 地址。

`switchCorp()` 只接受认证状态中返回的租户，使用已保存的 Token 调用 `GET /api/system/corp/switchCorp/{corpId}`，支持从 `data: corpId` 或 `data: { corpId }` 读取后端确认的租户 id，随后再次读取租户列表与当前用户。JDCloud 会在服务端刷新 Token 对应的租户上下文，因此 controller 保留已保存的 Token。切换成功会返回已确认租户及其管理员标记；普通失败保留当前登录，业务码 `600`、`601`、`602` 则删除过期登录。

Session Controller 在持久化附件或投递浏览器 Prompt 前，controller 会使用已保存的 Token 调用租户列表与当前用户接口，并在放行 Prompt 前同步变化的租户列表或管理员标记。业务码 `600`、`601`、`602` 会删除登录记录，并以 Token 过期拒绝本次 Prompt。网络失败和其他业务码只拒绝本次提交，不删除登录状态。

Session Controller 修改 Session 模型前，controller 通过 `api-session/model-selection-admission` 读取已保存的管理员标记。缺少登录时返回 `jdcloud/auth-required`；非管理员返回 `jdcloud/administrator-required`，且不修改 Session 或部署默认模型。

登录后，浏览器可以读取 `{ authenticated, baseUrl, username, corpId, corpName, corps, systemAdministrator }`；Token 永不经过 Remote wire。版本 3 record 会在使用前通过一次 `currentUser` 升级。`logout()` 会删除完整 credential record。密码只在登录调用期间存在，本包不会保存密码。

浏览器可以调用 `writableMenus()` 刷新 `/api/oauth/currentUser`，并且只接收当前租户 id，以及至少拥有一项已识别 `addData`、`editData` 或 `deleteData` 授权的 type `3` 表单和 type `4` 流程。每个返回菜单包含其 id、名称、解析后的父级路径、类型与已识别写授权。该方法使用 Host 中保存的登录信息，永不返回资料字段、服务地址或 Token。

Host 插件可以使用 `requestAuthenticated({ path, method, body? }, signal)` 请求固定的 `/api/...` 路径。controller 会在内部读取当前 credential、添加 authorization header、应用 `requestTimeoutMs`，并只返回成功响应中的 `data`，不会返回 Token。该方法接受 JSON `GET`、`POST`、`PUT` 和 `DELETE` 请求；`GET` 会绕过缓存。业务码 `600`、`601`、`602` 会删除登录并转换为 `jdcloud/auth-required`，其他业务错误保留登录状态。

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `defaultBaseUrl` | 空 | 尚未保存登录时显示的初始服务地址 |
| `requestTimeoutMs` | `15,000` | 登录、租户、当前用户、租户切换与 Host 已认证请求的截止时间 |

<a id="model-experience"></a>
## 模型体验

无，因为 Prompt 准入发生在 Session 或 Agent 投递前，不加入任何模型可见内容。

#### KV Cache 影响

无；通过校验的请求内容不变，被拒绝的请求不会进入 Prompt 组装。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `requestAuthenticated()` 仅供 Host 使用并支持 JSON body；它不是浏览器代理或 multipart 上传客户端。
- 中转服务地址在通过 HTTP(S) URL 校验后不受限制，因此链接可以让 Host 向任意服务器披露其携带的 Token，并请求私有网络地址。
- 登录接口沿用 JDCloud 上游要求的 MD5 wire 行为；它不是密码存储方案。
- 保存的登录状态属于该 controller 实例的 Host 全局状态，不按浏览器用户隔离。

<a id="dev-note"></a>
### 开发备注

无。

**运行时不变式：** 不发布伴生入口。controller 每次读取自有 credential record 时都会校验其字段，Prompt 准入在投递前校验 Token。
