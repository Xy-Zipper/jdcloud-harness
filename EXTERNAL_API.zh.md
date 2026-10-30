# 外部集成 API

[English](EXTERNAL_API.md) | 中文

## 概述

外部集成 API 允许受信任的服务端程序通过 Harness 管理账号 Skill 与工作区，并创建或继续 Session 对话。JDCloud 部署使用低代码原始 Token 和租户进行认证；Ontology 部署使用 Go Runtime Access Token 和项目进行认证。所有接口的路径前缀都是 `/api/external/v1`。

## 目录

- [服务地址与认证](#service-address-and-authentication)
- [请求与响应规则](#request-and-response-rules)
- [接口汇总](#route-summary)
- [Skill 接口](#skill-apis)
- [工作区接口](#workspace-apis)
- [Session 历史接口](#session-history-api)
- [对话接口](#conversation-api)
- [错误处理](#errors)
- [安全与部署](#security-and-deployment)
- [快速验证](#quick-verification)
- [开发备注](#dev-note)

<a id="service-address-and-authentication"></a>
## 服务地址与认证

本文示例使用以下 Harness 地址：

```text
http://127.0.0.1:3080
```

每次请求都必须携带 `Authorization` Header。Token 类型与范围 Header 取决于当前运行的分支。

### JDCloud 部署

`jdcloud-main` 使用以下 Header：

```http
Authorization: Bearer <raw-low-code-token>
X-Tenant-Id: 66232fc84fd77c1431ad3763
X-JDCloud-Base-Url: https://mi.kindoucloud.com
```

Token 必须是低代码登录接口返回的原始 Token，不能使用 Harness 浏览器 Session Token。该 Token 必须已经切换到请求的租户；外部 API 只校验当前租户，不会调用 `switchCorp`。

`X-JDCloud-Base-Url` 接受任意绝对 HTTP 或 HTTPS 地址，但地址不能包含账号密码、query 或 fragment。外部请求不会读取 `JDCLOUD_DEFAULT_BASE_URL`，也不会使用浏览器登录状态。

### Ontology 部署

`ontology-agent` 使用以下 Header：

```http
Authorization: Bearer <go-runtime-access-token>
X-Project-Id: <ontology-project-id>
```

Runtime 用户必须有权访问指定项目。Ontology 会拒绝 `X-Tenant-Id` 和 `X-JDCloud-Base-Url`。

<a id="request-and-response-rules"></a>
## 请求与响应规则

- 有请求体的 JSON 接口必须使用 `Content-Type: application/json`。
- Skill 上传必须使用 `multipart/form-data`，应由 HTTP 客户端自动生成 boundary。
- 所有 JSON 成功响应均使用 `{ "code": 200, "data": ... }` 和 `Content-Type: application/json; charset=utf-8`。
- 所有 JSON 失败响应中的数字 `code` 都等于 HTTP 状态码；`errorCode` 保留具体字符串错误标识。
- 对话接口返回 `text/event-stream`；所有成功 SSE 数据均使用 `{ "code": 200, "data": ... }`。
- 路由是精确匹配的。例如，`POST /api/external/v1/skills` 不是上传接口并会返回 `405`；上传必须使用 `/skills/upload`。
- 插件不会主动添加浏览器 CORS 策略。浏览器客户端需要使用同源部署或受信任的服务端代理。

<a id="route-summary"></a>
## 接口汇总

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/external/v1/skills` | 查询个人与内置 Skill。 |
| `POST` | `/api/external/v1/skills/upload` | 上传一个个人或内置 Skill ZIP 压缩包。 |
| `POST` | `/api/external/v1/skills/delete` | 删除一个个人或内置 Skill。 |
| `GET` | `/api/external/v1/workspaces` | 查询当前用户和范围内可见的工作区。 |
| `POST` | `/api/external/v1/workspaces/create` | 在当前账号目录下创建或复用工作区。 |
| `GET` | `/api/external/v1/workspaces/files` | 查询一个工作区目录的直接子项。 |
| `GET` | `/api/external/v1/sessions/history` | 查询一个 Session 的文本消息历史。 |
| `POST` | `/api/external/v1/sessions/create` | 在所属工作区创建 Session，不调用模型。 |
| `GET` | `/api/external/v1/sessions/file` | 按 Session 归属读取有界 UTF-8 文件。 |
| `POST` | `/api/external/v1/sessions/files/upload` | 暂存 Session 附件并返回上传凭据。 |
| `POST` | `/api/external/v1/chat` | 创建或继续 Session，并流式返回结果。 |

下面的示例使用 JDCloud Header。Ontology 调用方应按照前文说明，把两个 JDCloud 范围 Header 替换为 `X-Project-Id`。

<a id="skill-apis"></a>
## Skill 接口

### 查询 Skill

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/skills" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

响应包含当前可见的个人与内置 Skill，以及当前用户有权管理的范围：

```json
{
  "code": 200,
  "data": {
    "skills": [
      {
        "name": "kami",
        "description": "Example Skill",
        "modelInvocable": false,
        "scope": "personal"
      }
    ],
    "installScopes": ["personal"]
  }
}
```

系统管理员的 `installScopes` 还可以包含 `built-in`。内置 Skill 由该部署的全部用户共享；个人 Skill 属于当前认证用户和服务范围。

### 上传 Skill ZIP 压缩包

```powershell
curl.exe --request POST "http://127.0.0.1:3080/api/external/v1/skills/upload" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --form "scope=personal" `
  --form "file=@D:\skills\kami.zip;type=application/zip"
```

`scope` 可填写 `personal` 或 `built-in`。只有管理员可以管理 `built-in`。ZIP 压缩包必须只包含一个有效的 `SKILL.md`，该文件可以位于压缩包根目录或一层 Skill 包装目录中；压缩包中的全部文件必须属于这个 Skill 文件夹。

压缩包最多包含 128 个文件。单个解压后文件最大为 5 MiB，整个 Skill 解压后最大为 20 MiB，根 `SKILL.md` 最大为 256 KiB。完整 HTTP 请求体最大为 30 MiB。

响应示例：

```json
{
  "code": 200,
  "data": {
    "skill": {
      "name": "kami",
      "description": "Example Skill",
      "modelInvocable": false,
      "scope": "personal"
    }
  }
}
```

### 删除 Skill

```powershell
curl.exe --request POST "http://127.0.0.1:3080/api/external/v1/skills/delete" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"scope":"personal","name":"kami"}'
```

响应示例：

```json
{
  "code": 200,
  "data": {
    "deleted": true,
    "scope": "personal",
    "name": "kami"
  }
}
```

<a id="workspace-apis"></a>
## 工作区接口

### 查询工作区

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/workspaces" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

响应示例：

```json
{
  "code": 200,
  "data": {
    "workspaces": [
      {
        "workspaceId": "workspace-id",
        "path": "D:\\dsh-workspaces\\project-a",
        "title": "project-a",
        "sessionIds": [],
        "createdAt": "2026-10-20T08:00:00.000Z",
        "updatedAt": "2026-10-20T08:00:00.000Z"
      }
    ]
  }
}
```

### 创建或复用工作区

```powershell
curl.exe --request POST "http://127.0.0.1:3080/api/external/v1/workspaces/create" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"name":"project-a"}'
```

`name` 是认证账号工作区根目录下的单级目录名，不是绝对路径。名称不能是 `.` 或 `..`，不能包含 `/`、`\`、`:` 或 NUL，不能包含首尾空白，也不能以点结尾。

响应示例：

```json
{
  "code": 200,
  "data": {
    "workspace": {
      "workspaceId": "workspace-id",
      "path": "D:\\dsh-workspaces\\project-a",
      "title": "project-a",
      "sessionIds": [],
      "createdAt": "2026-10-20T08:00:00.000Z",
      "updatedAt": "2026-10-20T08:00:00.000Z"
    },
    "created": true
  }
}
```

当前账号已经拥有对应目录的工作区时，`created` 为 `false`。

### 查询工作区文件

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/workspaces/files?workspaceId=workspace-id&path=src" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

`workspaceId` 为必填参数。`path` 是可选的工作区相对目录；省略该参数或传入空值表示工作区根目录。包含特殊字符时必须进行 URL 编码。

响应示例：

```json
{
  "code": 200,
  "data": {
    "path": "src",
    "entries": [
      { "name": "components", "type": "directory" },
      { "name": "index.ts", "type": "file", "size": 1024 }
    ],
    "truncated": false
  }
}
```

该接口只列出目录的直接子项，不提供文件内容下载。

<a id="session-history-api"></a>
## Session 历史接口

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/sessions/history?sessionId=session-id&maxMessages=100" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 6ad80f2f1f280486bb45ac3a" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

`sessionId` 必填。`maxMessages` 可选，默认 `100`，范围为 `1` 到 `200`。接口复用 Session Controller 的归属检查，只允许当前平台身份读取自己拥有的 Session。返回值包含 assistant 文本，以及来源类型为 `user` 的用户文本；runtime context、Skill 目录、Skill 指令、reasoning、工具调用、工具结果和其他内部事件不会返回。

`data.running` 表示实时 Agent 在历史快照前或快照后是否处于运行状态。可选 `data.startedAt` 是窗口中当前 turn/start 的时间。页面重载或聊天流中断后，轮询历史即可跟踪已有工作，不再提交 prompt；中途 assistant 消息不代表完成。

```json
{
  "code": 200,
  "data": {
    "sessionId": "session-id",
    "cursor": 12,
    "hasMore": false,
    "messages": [
      { "id": "message-id", "role": "user", "text": "调整平台", "createdAt": 1790000000000 },
      { "id": "message-id-2", "role": "assistant", "text": "已生成候选修改。", "createdAt": 1790000001000 }
    ]
  }
}
```

<a id="conversation-api"></a>
## 对话接口

需附加文件时，先用 `POST /api/external/v1/sessions/create` 提交 JSON `{ "workspaceId": "..." }`，取得 `data.sessionId`；再向 `/api/external/v1/sessions/files/upload?sessionId=...&name=brief.pdf` 发送 `Content-Type: application/octet-stream` 的原始文件字节。接口复用当前身份归属检查及 Session 附件服务，返回 `{ code: 200, data: { receiptId, file } }`，请求体最大 30 MiB。随后 `/chat` 可带 `fileReceiptIds: ["..."]`，凭据仅由接收该文件的同一 Session 接受；普通文本对话可省略该字段。

读取产物使用 `GET /api/external/v1/sessions/file?sessionId=...&path=创意方案.json`，响应 `data` 为 `{ path, text, version }`。接口复用 Session 历史归属和 Workspace 文件读取策略，不激活 Agent；超过现有文件预览的行数或字节上限时拒绝，不返回截断文件。所有接口沿用本页认证 Header，文件不存在返回 `404`。

### 创建 Session 并发送第一条消息

```powershell
curl.exe --no-buffer --request POST "http://127.0.0.1:3080/api/external/v1/chat" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"workspaceId":"workspace-id","message":"分析当前项目","skillNames":["kami"]}'
```

未传入 `sessionId` 时必须传入 `workspaceId`。`skillNames` 中的每个名称都必须对新 Session 可见。API 会在提交消息前加上对应的 `/<skill-name>` 调用标记，再由现有 Skill runtime 加载这些 Skill。

### 继续已有 Session

```powershell
curl.exe --no-buffer --request POST "http://127.0.0.1:3080/api/external/v1/chat" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"sessionId":"session-id","message":"继续完成任务","skillNames":[]}'
```

响应采用 SSE 流。事件名称如下：

| 事件 | 含义 |
|---|---|
| `session` | 标识本次创建或继续的 Session。 |
| `snapshot` | 提交消息前的初始 Session 快照。 |
| `event` | 持久化 Session 事件，包括本次用户消息和回合结束事件。 |
| `assistant` | 模型提供方的实时数据块；提供方返回 reasoning 字段时也会包含该字段。 |
| `done` | 本次提交的回合已经完成。 |
| `error` | HTTP 流打开后，对话执行发生错误。 |

事件示例：

```text
event: session
data: {"code":200,"data":{"sessionId":"session-id"}}

event: assistant
data: {"code":200,"data":{"type":"assistant-stream","frame":{"type":"chunk","chunk":{"content":"..."}}}}

event: done
data: {"code":200,"data":{"sessionId":"session-id"}}
```

API 会转发模型提供方返回的流式字段，但不会生成或暴露隐藏推理。客户端应保存返回的 `sessionId`，后续请求通过该 ID 继续对话。

<a id="errors"></a>
## 错误处理

JSON 错误通常采用以下结构：

```json
{
  "code": 400,
  "errorCode": "gateway/bad-request",
  "message": "description of the failure",
  "details": {}
}
```

| HTTP 状态码 | 常见含义 |
|---:|---|
| `400` | Header、JSON 请求体、query 参数、服务地址、Skill 压缩包或范围缺失或无效。 |
| `401` | 缺少 Bearer Token，或平台 Token 无效、已过期。 |
| `403` | 无权访问指定租户、项目、资源，或无权管理内置 Skill。 |
| `404` | 未找到工作区、文件路径、Skill 或精确路由。 |
| `405` | 路由存在，但 HTTP 方法错误；允许的方法位于 `Allow` Header。 |
| `409` | 已存在同名 Skill。 |
| `499` | 调用方取消了请求。 |
| `500` | 内部服务操作失败。 |
| `503` | 当前没有启用受支持的外部认证 Controller。 |

`/chat` 已经返回 HTTP `200` 后发生的错误会通过 SSE `error` 事件返回，不会再产生新的 HTTP 错误响应。事件数据使用相同的数字 `code`、`errorCode`、`message` 和可选 `details` 字段。

<a id="security-and-deployment"></a>
## 安全与部署

- 不要把平台 Token 写入浏览器存储、URL、源代码或应用日志。
- 生产环境中，外部项目到 Harness、Harness 到平台服务都应使用 HTTPS。
- JDCloud 当前允许调用方传入任意语法合法的 HTTP(S) 服务地址，包括私有网络地址。Harness 会把调用方提供的 Token 发送到该地址。只有受信任的调用方才能访问这些接口；公开接口前也可以在可信上游网关中增加目标地址白名单。
- 资源归属包含平台认证身份，以及 JDCloud 服务地址或 Ontology 项目。仅知道其他范围的工作区或 Session ID，不能直接访问对应资源。
- 部署代码或 profile 改动后需要重启 Harness。外部 API 不要求配置 `JDCLOUD_DEFAULT_BASE_URL`；该变量只用于浏览器登录页的初始地址。

<a id="quick-verification"></a>
## 快速验证

启动 Harness 后，可以在不发送真实 Token 的情况下检查路由是否已经注册：

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/skills"
```

路由注册成功时，因为缺少 Bearer Token，接口会返回 HTTP `401` 和 `{ "code": 401, "errorCode": "unauthorized", ... }`。如果响应不符合数字 envelope，说明当前进程尚未加载当前版本的 External API 插件，或者协议修改后还没有重启。

<a id="dev-note"></a>
## 开发备注

无。
