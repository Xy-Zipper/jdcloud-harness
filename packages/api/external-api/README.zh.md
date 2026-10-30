---
description: "面向外部项目的 Token 鉴权 HTTP 与 SSE API，覆盖账号 Skill、工作区、文件和 Session 对话。"
kind: "package-reference"
---

# 外部 API

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-external` 提供固定的 `/api/external/v1/*` 路由。JDCloud 部署使用低代码原始 Token、`X-Tenant-Id` 与调用方选择的 `X-JDCloud-Base-Url`；Ontology 部署使用 Runtime Access Token 与 `X-Project-Id`。每次请求都由当前认证 Controller 校验，再复用现有 Skill、Workspace、文件和 Session 服务。

## 目录

- [路由](#routes)
- [模型体验](#model-experience)
- [已知限制与后续事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="routes"></a>
## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/external/v1/skills` | 查询个人与内置 Skill。 |
| `POST` | `/api/external/v1/skills/upload` | 从一个 ZIP 压缩包安装 `personal` 或 `built-in` Skill。 |
| `POST` | `/api/external/v1/skills/delete` | 删除有权限管理的个人或内置 Skill。 |
| `GET` | `/api/external/v1/workspaces` | 查询可见工作区。 |
| `POST` | `/api/external/v1/workspaces/create` | 创建或复用一个子目录和工作区。 |
| `GET` | `/api/external/v1/workspaces/files` | 查询工作区目录内容。 |
| `GET` | `/api/external/v1/sessions/history` | 查询当前身份拥有的 Session 文本历史。 |
| `POST` | `/api/external/v1/sessions/create` | 创建 Session，不调用模型。 |
| `GET` | `/api/external/v1/sessions/file` | 通过所属 Session 读取完整有界文本文件。 |
| `POST` | `/api/external/v1/sessions/files/upload` | 暂存原始文件字节并返回 Session 专属凭据。 |
| `POST` | `/api/external/v1/chat` | 创建或继续 Session，并返回 SSE 事件。 |

所有请求都携带 `Authorization: Bearer <token>`。JDCloud 要求低代码 Token、`X-Tenant-Id` 与 `X-JDCloud-Base-Url`；controller 接受任意语法合法、且不包含账号密码、query 或 fragment 的绝对 HTTP(S) 地址。Ontology 要求 Go Runtime Access Token 与 `X-Project-Id`，并拒绝 JDCloud Header。所有 JSON 成功响应均为 `{ code: 200, data }`；所有 JSON 失败响应中的数字 `code` 都等于 HTTP 状态码，具体字符串错误标识保留在 `errorCode`。历史接口复用 Session Controller 归属检查，返回 assistant 文本和来源类型为 `user` 的用户文本；注入的 runtime 与 Skill 上下文保留在内部。对话请求体包含 `message`，可选的 `sessionId`，新建 Session 时使用的 `workspaceId`，以及可选的 `skillNames`。SSE 会发送 `session`、`snapshot`、`event`、`assistant`、`done` 和 `error`；成功事件均携带 `{ code: 200, data }`，`error` 事件携带映射后的数字 code。模型提供 reasoning 字段时会原样包含在 `assistant` 实时块中；接口不会生成或暴露隐藏推理。

`POST /api/external/v1/skills/upload` 接受 `multipart/form-data`：一个名为 `scope` 的文本字段（`personal` 或 `built-in`），以及一个名为 `file` 的 `.zip` 文件字段。压缩包可以把 `SKILL.md` 放在根目录，也可以放在一层包装目录中；压缩包内的所有文件必须属于该 Skill 文件夹。接口不再接受旧的 JSON 文件数组，并继续执行现有的 Skill 路径、文件数量、解压后大小、元数据和管理员权限校验。

文件读取接受 `sessionId/path`，复用 Session 归属及 Workspace 文件读取策略，拒绝不完整的文本预览。创建 Session 接受 `workspaceId`。附件上传接受 `sessionId/name` 查询和 `application/octet-stream` 原始字节，受 30 MiB 请求上限约束；返回的 `receiptId` 放入同一 Session 的 `/chat.fileReceiptIds`，附件准入与持久化继续由 Session 服务处理。

历史还返回 running，分别在快照前后读取实时 Agent，两次任一次运行中即为 true。历史窗口含当前 turn/start 时，startedAt 返回该事件时间。页面重载后可以轮询此已认证只读接口，无需再次提交 prompt；运行期间禁用发送和推荐，变为 false 后才读取最终产物。中途 Assistant 文本不代表轮次结束。

<a id="model-experience"></a>
## 模型体验

### 已选 Skill

#### 模型看到的内容

当 `skillNames` 非空时，API 提交的日志用户消息先包含一行以空格分隔的 `/<skill-name>` 调用标记，再换行追加调用方的 `message`。Session Controller 与 Skill runtime 会按现有规则解析这些调用标记。

#### Token 影响

每个已选 Skill 都会向请求上下文添加其调用文本和 Skill runtime 解析出的指令。指令长度由对应 Skill 文件决定。

#### KV Cache 影响

选择、移除或调整 Skill 顺序会改变有日志记录的用户消息与解析出的指令，因此受影响请求不会保留其他条件相同但未选择 Skill 的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续事项

- 路由不主动添加浏览器 CORS 策略；浏览器项目应使用同源部署或服务端代理。
- 工作区文件接口提供目录列表；所属 Session 的文件支持有上限的完整文本读取，尚未开放二进制文件下载。
- JDCloud 调用方可以选择不受限制的 HTTP(S) 目标。Host 会把调用方提供的 Token 发送到该目标，并且可以访问私有网络地址；部署方在公开这些路由前必须信任调用方，或在上游增加地址白名单。

<a id="dev-note"></a>
### 开发备注

无。

**运行时不变量：** 任何业务服务执行前，当前认证 Controller 都会校验原始平台 Token 与请求的租户或项目。
