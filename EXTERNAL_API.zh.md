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

本节适用于 `/api/external/v1`。发布 Skill 的响应字段与事件见[知识 Skill 集成](#knowledge-skill-integration)。

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

<a id="conversation-api"></a>
## 对话接口

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
<a id="knowledge-skill-integration"></a>
## 知识 Skill 集成

在 Harness 左下角打开「更多 → Skill」。Ontology 工作台内只列出当前项目的 Skill。独立打开 Harness 时先选项目。填写角色指令，选择知识库，然后点击「发布 Skill」。知识库留空时查询该项目在所有可用知识库中的文件。保存草稿后再次发布即可应用修改。删除 Skill 会关闭它的发布入口，并删除 API Key 和 API 会话历史。

在「发布接入」中启用外部嵌入，然后从「全屏 iframe」或「悬浮组件」复制代码到目标网站。iframe 填满指定容器，悬浮组件从页面右下角打开聊天。持分享链接者可以提问并查看引用片段。停用外部嵌入会使两种代码中的分享凭证同时失效。保护原件预览的项目权限继续由登录后的工作台校验。

### 认证与服务地址

在「发布接入 → API 接口 → 管理 API Key」创建密钥。完整值在创建时可复制，之后列表显示掩码和创建时间。一个 Skill 可有多把独立的 Key。删除一把 Key 会立即停用它并删除该 Key 创建的 API 会话及历史。请求发送 `Authorization: Bearer $SKILL_API_KEY`。将密钥保存在调用方服务端。

以下示例使用 `SKILL_API` 作为接口地址前缀。将其中的地址、部署路径和 Skill ID 替换为发布页面给出的值。页面里的 curl 示例已填写当前 Skill 的请求地址。

```bash
SKILL_API='https://example.com/harness/api/ontology-skill/v1/skills/ks_example'
```

| 公共请求参数 | 类型 | 说明 |
| --- | --- | --- |
| `skillId` | 路径字符串 | 必填。对应 `SKILL_API` 最后一段，取自已发布的 Skill。 |
| `Authorization` | 请求头 | 必填。值为 `Bearer` 加空格和该 Skill 的 API Key。 |
| `Content-Type` | 请求头 | POST 必填，使用 `application/json`。 |
| `X-Request-ID` | 请求头 | 可选。最多 128 字，用于关联请求和错误。 |

### 新建会话

`POST /sessions`

请求使用 `Content-Type: application/json`。`name` 是可选字符串，最多 120 字，默认「新会话」。调用方可发送 `{}` 使用默认名称。

```bash
curl --request POST "$SKILL_API/sessions" \
  --header "Authorization: Bearer $SKILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"name":"培训资料"}'
```

HTTP 201 返回会话 `id`、`name`、`turnCount`、`createdAt` 和 `updatedAt`，可将 `id` 保存为 `SESSION_ID`。

| 会话字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 字符串 | 会话 ID，用于提问、读取历史和删除。 |
| `name` | 字符串 | 会话显示名称。 |
| `turnCount` | 整数 | 已保存的问答轮数。 |
| `createdAt` | 字符串 | 会话创建时间，RFC 3339。 |
| `updatedAt` | 字符串 | 会话最近更新时间，RFC 3339。 |

```json
{
  "id": "ss_example",
  "name": "培训资料",
  "turnCount": 0,
  "createdAt": "2026-11-20T01:00:00Z",
  "updatedAt": "2026-11-20T01:00:00Z"
}
```

### 发起对话

`POST /chat`

| 请求体字段 | 类型 | 说明 |
| --- | --- | --- |
| `question` | 字符串 | 必填。1–2000 字。 |
| `sessionId` | 字符串 | 可选。传入当前 Key 创建的 ID 后保存问答，并使用同一发布版本最近 4 轮的上下文。省略时独立回答。 |
| `stream` | 布尔值 | 可选，默认 `false`。`true` 时分段返回 SSE，`false` 时等待完整 JSON。 |

```bash
curl --request POST "$SKILL_API/chat" \
  --header "Authorization: Bearer $SKILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"question\":\"培训主题是什么？\",\"sessionId\":\"$SESSION_ID\",\"stream\":false}"
```

HTTP 200 JSON 响应和流式 `done` 事件使用以下字段。

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `answer` | 字符串 | 本轮完整的回答正文。 |
| `sources` | 对象数组 | 支持答复的引用片段。资料不足时返回空数组。 |
| `version` | 整数 | 生成该回答时使用的 Skill 发布版本。 |
| `sessionId` | 字符串 | 本轮保存到的会话 ID。有会话时返回。 |
| `number` | 整数 | 本轮序号，从 1 开始。有会话时返回。 |

```json
{
  "answer": "当前所选资料中未找到足够依据。",
  "sources": [],
  "version": 1,
  "sessionId": "ss_example",
  "number": 1
}
```

#### `sources[]` 引用字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `citationId` | 字符串 | 该引用的标识，用于关联回答与来源。 |
| `text` | 字符串 | 返回的原文片段正文。 |
| `projectId` | 字符串 | 原件所属的 Ontology 项目 ID。 |
| `fileId` | 字符串 | Ontology 原文件 ID。 |
| `fileName` | 字符串 | 原件文件名。 |
| `mediaType` | 字符串 | 原件媒体类型，例如 `application/pdf`。 |
| `knowledgeBaseId` | 字符串 | RAGFlow 知识库 ID。 |
| `documentId` | 字符串 | RAGFlow 文档 ID。 |
| `chunkId` | 字符串 | RAGFlow 命中的分块 ID。 |
| `nodeIds` | 字符串数组 | 对应的原始切片节点 ID 列表。 |
| `nodeId` | 字符串 | 可选。已知的单个原始切片节点 ID。 |
| `page` | 整数 | 可选。已确认的原 PDF 页码，从 1 开始。 |
| `endPage` | 整数 | 可选。跨页片段已确认的结束页。 |

#### 流式返回

```bash
curl --no-buffer --request POST "$SKILL_API/chat" \
  --header "Authorization: Bearer $SKILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"question\":\"培训主题是什么？\",\"sessionId\":\"$SESSION_ID\",\"stream\":true}"
```

成功时响应为 HTTP 200 和 `Content-Type: text/event-stream`。每条事件的 `data` 是 JSON 对象，事件之间以空行分隔。

| `event` | `data` 字段 | 说明 |
| --- | --- | --- |
| `delta` | `text`，字符串 | 本次新增的正文。按顺序拼接，保留空格和换行。可能出现多次。 |
| `done` | 与 JSON 响应相同 | 成功结束。以完整的 `answer` 和 `sources` 为准。有会话时，该轮已保存。资料不足时可直接返回 `done`。 |
| `error` | `status`、`code`、`message`、`requestId` | 流开启后的失败。`status` 是对应的 HTTP 状态整数。该事件结束本次响应。 |

```text
event: delta
data: {"text":"培训介绍了"}

event: delta
data: {"text":"系统操作流程。"}

event: done
data: {"answer":"培训介绍了系统操作流程。","version":1,"sessionId":"ss_example","number":1,"sources":[{"citationId":"R-0123456789","text":"系统操作培训","projectId":"project_example","fileId":"file_example","fileName":"training.pdf","mediaType":"application/pdf","knowledgeBaseId":"kb_example","documentId":"doc_example","chunkId":"chunk_example","nodeIds":["0001"]}]}
```

首个 SSE 事件发出前，失败以 HTTP 错误状态和 JSON 返回。收到 `error` 后可以丢弃临时正文。如果连接提前关闭且未收到 `done`，重试前先读取会话历史。

### 获取会话列表

`GET /sessions?page=1&pageSize=20`

返回当前 API Key 创建的会话，最近活动在前。`page` 默认 1，范围为 1–1000000。`pageSize` 默认 20，范围为 1–50。两个参数都可省略。HTTP 200 返回 `sessions`、`page`、`pageSize` 和 `hasMore`。

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessions` | 对象数组 | 当前页的会话，每项与新建会话的响应字段相同。 |
| `page` | 整数 | 本次返回的页码，从 1 开始。 |
| `pageSize` | 整数 | 本次请求的每页条数上限。 |
| `hasMore` | 布尔值 | 为 `true` 时可继续读取下一页。 |

```bash
curl "$SKILL_API/sessions?page=1&pageSize=20" \
  --header "Authorization: Bearer $SKILL_API_KEY"
```

```json
{"sessions":[],"page":1,"pageSize":20,"hasMore":false}
```

### 获取会话历史

`GET /sessions/{sessionId}?page=1&pageSize=20`

`sessionId` 为必填路径参数。使用与列表相同的分页参数。HTTP 200 返回 `session` 和按 `number` 正序的 `turns`，每轮包含 `question`、`answer`、`sources`、`version` 和 `createdAt`。

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `session` | 对象 | 会话基本信息，字段与新建会话相同。 |
| `turns` | 对象数组 | 当前页按轮次升序排列的问答记录。 |
| `turns[].number` | 整数 | 会话中的轮次序号，从 1 开始。 |
| `turns[].question` | 字符串 | 本轮保存的问题正文。 |
| `turns[].answer` | 字符串 | 本轮保存的完整回答。 |
| `turns[].sources` | 对象数组 | 本轮的引用，使用与发起对话相同的 `sources[]` 字段。 |
| `turns[].version` | 整数 | 生成该轮回答时使用的 Skill 发布版本。 |
| `turns[].createdAt` | 字符串 | 保存该轮问答的时间，RFC 3339。 |
| `page`、`pageSize`、`hasMore` | 整数、整数、布尔值 | 与会话列表的分页字段相同。 |

```bash
curl "$SKILL_API/sessions/$SESSION_ID?page=1&pageSize=20" \
  --header "Authorization: Bearer $SKILL_API_KEY"
```

```json
{
  "session": {"id":"ss_example","name":"培训资料","turnCount":1,"createdAt":"2026-11-20T01:00:00Z","updatedAt":"2026-11-20T01:02:00Z"},
  "turns": [{"number":1,"question":"培训主题是什么？","answer":"当前所选资料中未找到足够依据。","sources":[],"version":1,"createdAt":"2026-11-20T01:02:00Z"}],
  "page": 1,
  "pageSize": 20,
  "hasMore": false
}
```

### 删除会话

`DELETE /sessions/{sessionId}`

删除当前 Key 创建的指定会话及其历史。成功返回 HTTP 204，响应体为空。

```bash
curl --request DELETE "$SKILL_API/sessions/$SESSION_ID" \
  --header "Authorization: Bearer $SKILL_API_KEY"
```

### 错误响应

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | 字符串 | 稳定的错误标识，用于程序判断。 |
| `message` | 字符串 | 可读的失败原因，部分网关错误可能省略。 |
| `requestId` | 字符串 | 请求追踪 ID，部分网关错误可能省略。 |

| 状态 | 处理方式 |
| --- | --- |
| 400 | 检查请求体、会话 ID 或分页参数 |
| 401 | 使用这个 Skill 当前有效的 API Key |
| 404 | 检查会话是否存在，是否由当前 Key 创建 |
| 409 | 会话或发布版本已更新，重新读取后再提问 |
| 415 | 发送 `Content-Type: application/json` |
| 429 | 等待 `Retry-After` 后重试。每个实例、每个 Skill 每分钟最多处理 30 个外部问答，同时最多 4 个进行中 |
| 500 / 502 / 503 / 504 | 服务、知识库或模型暂时不可用，可以稍后重试 |

「登录后试用」链接仍按查看者的 Ontology 登录授权。使用 Runtime Access Token 的既有调用方可以继续调用 `GET /api/runtime/knowledge/skills/{id}`、`POST /api/runtime/knowledge/skills/{id}/ask` 和有权限的 `/api/runtime/knowledge/files/{projectId}/{fileId}/preview` 或 `/content`。

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
