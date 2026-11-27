# External Integration API

English | [中文](EXTERNAL_API.zh.md)

## Summary

The External Integration API lets a trusted server manage account Skills and Workspaces and start or continue Session conversations through Harness. JDCloud deployments authenticate a raw low-code Token and tenant; Ontology deployments authenticate a Go Runtime Access Token and Project. The API prefix is `/api/external/v1`.

## Table of Contents

- [Service address and authentication](#service-address-and-authentication)
- [Request and response rules](#request-and-response-rules)
- [Route summary](#route-summary)
- [Skill APIs](#skill-apis)
- [Workspace APIs](#workspace-apis)
- [Conversation API](#conversation-api)
- [Errors](#errors)
- [Security and deployment](#security-and-deployment)
- [Quick verification](#quick-verification)
- [Dev Note](#dev-note)

<a id="service-address-and-authentication"></a>
## Service address and authentication

The examples use this Harness address:

```text
http://127.0.0.1:3080
```

Every request requires an `Authorization` Header. The Token type and scope Headers depend on the active branch.

### JDCloud deployment

Use these Headers on `jdcloud-main`:

```http
Authorization: Bearer <raw-low-code-token>
X-Tenant-Id: 66232fc84fd77c1431ad3763
X-JDCloud-Base-Url: https://mi.kindoucloud.com
```

The Token must be the original Token returned by the low-code login API, not a Harness browser-session Token. The Token must already have the requested tenant selected; the External API validates the current tenant and does not call `switchCorp`.

`X-JDCloud-Base-Url` accepts any absolute HTTP or HTTPS address without embedded credentials, a query, or a fragment. External requests do not read `JDCLOUD_DEFAULT_BASE_URL` or the browser login state.

### Ontology deployment

Use these Headers on `ontology-agent`:

```http
Authorization: Bearer <go-runtime-access-token>
X-Project-Id: <ontology-project-id>
```

The Runtime user must be authorized to access the requested Project. Ontology rejects `X-Tenant-Id` and `X-JDCloud-Base-Url`.

<a id="request-and-response-rules"></a>
## Request and response rules

These rules apply to `/api/external/v1`. [Knowledge Skill integration](#knowledge-skill-integration) documents the published Skill response fields and events.

- JSON endpoints require `Content-Type: application/json` when they have a body.
- Skill upload requires `multipart/form-data`; let the HTTP client generate its boundary.
- Every JSON success uses `{ "code": 200, "data": ... }` and `Content-Type: application/json; charset=utf-8`.
- Every JSON failure uses a numeric `code` equal to the HTTP status; `errorCode` retains the specific string error identifier.
- The conversation endpoint returns `text/event-stream`; every successful SSE payload uses `{ "code": 200, "data": ... }`.
- Routes are exact. For example, `POST /api/external/v1/skills` is not an upload request and returns `405`; use `/skills/upload`.
- The plugin does not add a browser CORS policy. Browser clients need a same-origin deployment or a trusted server-side proxy.

<a id="route-summary"></a>
## Route summary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/external/v1/skills` | List personal and built-in Skills. |
| `POST` | `/api/external/v1/skills/upload` | Upload one personal or built-in Skill ZIP archive. |
| `POST` | `/api/external/v1/skills/delete` | Delete one personal or built-in Skill. |
| `GET` | `/api/external/v1/workspaces` | List Workspaces visible to the current user and scope. |
| `POST` | `/api/external/v1/workspaces/create` | Create or reuse a Workspace under the current account root. |
| `GET` | `/api/external/v1/workspaces/files` | List direct children of one Workspace directory. |
| `POST` | `/api/external/v1/chat` | Create or continue a Session and stream its result. |

The following examples use JDCloud Headers. For Ontology, replace the two JDCloud scope Headers with `X-Project-Id` as described above.

<a id="skill-apis"></a>
## Skill APIs

### List Skills

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/skills" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

The response contains visible personal and built-in Skills and the scopes that the current user may manage:

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

A system administrator can also receive `built-in` in `installScopes`. Built-in Skills are shared with all users in the deployment; personal Skills belong to the authenticated user and service scope.

### Upload a Skill ZIP archive

```powershell
curl.exe --request POST "http://127.0.0.1:3080/api/external/v1/skills/upload" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --form "scope=personal" `
  --form "file=@D:\skills\kami.zip;type=application/zip"
```

`scope` is `personal` or `built-in`. Only an administrator can manage `built-in`. The ZIP archive must contain exactly one valid `SKILL.md`, either at the archive root or under one wrapping Skill directory, and every archived file must belong to that Skill folder.

The archive can contain at most 128 files. One expanded file can contain at most 5 MiB, the complete expanded Skill can contain at most 20 MiB, and the root `SKILL.md` can contain at most 256 KiB. The complete HTTP body is limited to 30 MiB.

Example response:

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

### Delete a Skill

```powershell
curl.exe --request POST "http://127.0.0.1:3080/api/external/v1/skills/delete" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"scope":"personal","name":"kami"}'
```

Example response:

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
## Workspace APIs

### List Workspaces

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/workspaces" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

Example response:

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

### Create or reuse a Workspace

```powershell
curl.exe --request POST "http://127.0.0.1:3080/api/external/v1/workspaces/create" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"name":"project-a"}'
```

`name` is one directory segment under the authenticated account's Workspace root, not an absolute path. It cannot be `.`, `..`, contain `/`, `\`, `:`, or NUL, have surrounding whitespace, or end in a dot.

Example response:

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

`created` is `false` when the current account already owns a Workspace for that directory.

### List Workspace files

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/workspaces/files?workspaceId=workspace-id&path=src" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

`workspaceId` is required. `path` is an optional Workspace-relative directory; omit it or pass an empty value for the Workspace root. URL-encode paths that contain special characters.

Example response:

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

This endpoint lists direct children only. It does not download file contents.

<a id="conversation-api"></a>
## Conversation API

### Create a Session and send its first message

```powershell
curl.exe --no-buffer --request POST "http://127.0.0.1:3080/api/external/v1/chat" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"workspaceId":"workspace-id","message":"分析当前项目","skillNames":["kami"]}'
```

`workspaceId` is required when `sessionId` is omitted. Each name in `skillNames` must be visible to the new Session. The API prefixes the submitted message with the selected `/<skill-name>` invocations so the existing Skill runtime loads them.

### Continue an existing Session

```powershell
curl.exe --no-buffer --request POST "http://127.0.0.1:3080/api/external/v1/chat" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 66232fc84fd77c1431ad3763" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com" `
  --header "Content-Type: application/json" `
  --data-raw '{"sessionId":"session-id","message":"继续完成任务","skillNames":[]}'
```

The response is an SSE stream. Event names are:

| Event | Meaning |
|---|---|
| `session` | Identifies the created or continued Session. |
| `snapshot` | Initial Session snapshot before the submitted message. |
| `event` | Durable Session events, including the submitted user message and turn completion. |
| `assistant` | Live model-provider chunks, including provider reasoning fields when present. |
| `done` | The submitted turn completed. |
| `error` | Streaming failed after the HTTP stream opened. |

Example frames:

```text
event: session
data: {"code":200,"data":{"sessionId":"session-id"}}

event: assistant
data: {"code":200,"data":{"type":"assistant-stream","frame":{"type":"chunk","chunk":{"content":"..."}}}}

event: done
data: {"code":200,"data":{"sessionId":"session-id"}}
```

The API forwards model-provided stream fields but does not generate or expose hidden reasoning. A client should retain the returned `sessionId` and reconnect by sending it in the next request.

<a id="errors"></a>
<a id="knowledge-skill-integration"></a>
## Knowledge Skill integration

[中文接口文档](EXTERNAL_API.zh.md#knowledge-skill-integration)

In Harness, open More → Skills. The workbench shows the current Ontology project's Skills. In standalone Harness, select a project first. Set the role instructions and knowledge bases, then publish. An empty knowledge-base selection searches the project's files in all available bases. Publish again to apply draft edits. Deleting a Skill revokes its public links and keys and removes its API sessions and history.

Enable external embedding under Publish and integrate. Copy the Full-page iframe or Chat widget snippet into the destination site. The iframe fills its container, and the widget opens chat from the lower-right corner. Anyone holding the share link can ask questions and see cited excerpts. Disabling embedding revokes the credential in both snippets. Original file previews use the signed-in workbench's project permissions.

### Authentication and service address

Open Publish and integrate → API → Manage API keys to create a key. Copy the full key when issued. The list shows masked values and creation times. Each key owns its own API sessions. Deleting a key revokes it and removes the sessions and history it created. Store your key on the calling server.

Set `SKILL_API` to the Skill base URL shown in the publication panel. Keep the Harness deployment prefix, such as `/harness/`. Send `Authorization: Bearer $SKILL_API_KEY` with each request.

```bash
SKILL_API='https://example.com/harness/api/ontology-skill/v1/skills/ks_example'
```

| Common request parameter | Type | Meaning |
| --- | --- | --- |
| `skillId` | Path string | Required. The last segment of `SKILL_API` identifies the published Skill. |
| `Authorization` | Header | Required. Send `Bearer` and the API key issued for this Skill. |
| `Content-Type` | Header | Required for POST. Use `application/json`. |
| `X-Request-ID` | Header | Optional correlation ID up to 128 characters. |

### Create a session

`POST /sessions` accepts an optional `name` of up to 120 characters. Send `{}` for the default name. HTTP 201 returns a session with `id`, `name`, `turnCount`, `createdAt`, and `updatedAt`. Store its `id` in `SESSION_ID`.

```bash
curl --request POST "$SKILL_API/sessions" \
  --header "Authorization: Bearer $SKILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"name":"Training materials"}'
```

| Session field | Type | Meaning |
| --- | --- | --- |
| `id` | String | Session ID for chat, history, and deletion. |
| `name` | String | Display name. |
| `turnCount` | Integer | Number of completed, saved turns. |
| `createdAt` | String | Session creation time in RFC 3339 format. |
| `updatedAt` | String | Most recent update time in RFC 3339 format. |

### Send a question

`POST /chat` accepts the following JSON fields.

| Request field | Type | Meaning |
| --- | --- | --- |
| `question` | String | Required. Question of 1–2,000 characters. |
| `sessionId` | String | Optional. Saves a turn in a session owned by this key and uses up to four recent turns from the current published version. Omit for a standalone answer. |
| `stream` | Boolean | Optional, defaults to `false` for complete JSON. Set `true` to receive SSE deltas. |

```bash
curl --request POST "$SKILL_API/chat" \
  --header "Authorization: Bearer $SKILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"question\":\"What is the training about?\",\"sessionId\":\"$SESSION_ID\",\"stream\":false}"
```

The HTTP 200 JSON response and the SSE `done` event share these fields.

| Response field | Type | Meaning |
| --- | --- | --- |
| `answer` | String | Complete answer text with inline citation markers. |
| `sources` | Object array | Excerpts supporting the answer. An empty array indicates insufficient evidence. |
| `version` | Integer | Published Skill version used for the answer. |
| `sessionId` | String | Session ID present when the turn was saved. |
| `number` | Integer | Turn number starting at 1, present when the turn was saved. |

| `sources[]` field | Type | Meaning |
| --- | --- | --- |
| `citationId` | String | ID inside an inline citation marker, such as `R-0123456789`. |
| `text` | String | Text from the cited excerpt. |
| `projectId` | String | Ontology project that owns the original file. |
| `fileId` | String | Original file ID in Ontology. |
| `fileName` | String | Original filename. |
| `ontology-file-path` | String | Optional logical location of the original within its Ontology project, such as `/Policies/Manual.pdf`. |
| `mediaType` | String | Media type of the original file. |
| `knowledgeBaseId` | String | RAGFlow knowledge base ID. |
| `documentId` | String | RAGFlow document ID. |
| `chunkId` | String | RAGFlow ID of the matched chunk. |
| `nodeIds` | String array | IDs of the original slice nodes. |
| `nodeId` | String | Optional ID of a single original slice node. |
| `page` | Integer | Optional verified PDF page, starting at 1. |
| `endPage` | Integer | Optional verified last page of a multi-page excerpt. |

In an answer such as `The training covers cafeteria operations.[R-0123456789]`, match the marker's ID to `sources[].citationId` and render a label such as “Excerpt 1” in its place. The same source can be cited at several positions. An insufficient-evidence reply has no marker and an empty `sources` array.

#### Streaming response

```bash
curl --no-buffer --request POST "$SKILL_API/chat" \
  --header "Authorization: Bearer $SKILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"question\":\"What is the training about?\",\"sessionId\":\"$SESSION_ID\",\"stream\":true}"
```

Successful SSE responses use HTTP 200 and `Content-Type: text/event-stream`. Each `data` line contains a JSON object. A blank line separates events.

| Event | Data | Meaning |
| --- | --- | --- |
| `delta` | `text` string | New answer text, including any inline markers. Append in order and retain whitespace. |
| `done` | JSON response fields | Successful completion. Use the full answer and verified sources. A session turn is saved before this event. An insufficient-evidence answer can go straight to `done`. |
| `error` | `status`, `code`, `message`, `requestId` | Terminal failure after streaming began. `status` is the corresponding HTTP status integer. |

```text
event: delta
data: {"text":"The training "}

event: delta
data: {"text":"covers cafeteria operations.[R-0123456789]"}

event: done
data: {"answer":"The training covers cafeteria operations.[R-0123456789]","version":1,"sessionId":"ss_example","number":1,"sources":[{"citationId":"R-0123456789","text":"Cafeteria operations training","projectId":"project_example","fileId":"file_example","fileName":"training.pdf","mediaType":"application/pdf","knowledgeBaseId":"kb_example","documentId":"doc_example","chunkId":"chunk_example","nodeIds":["0001"]}]}
```

Failures before the first SSE event use an HTTP status and JSON. Discard provisional text on `error`. If the connection closes without `done`, read session history before retrying.

### List sessions

`GET /sessions` lists sessions owned by the calling key, most recently active first. Optional `page` defaults to 1 and accepts 1–1,000,000. Optional `pageSize` defaults to 20 and accepts 1–50. HTTP 200 returns `sessions`, `page`, `pageSize`, and `hasMore`.

| Response field | Type | Meaning |
| --- | --- | --- |
| `sessions` | Object array | Sessions on this page. Each item has the fields from Create a session. |
| `page` | Integer | Returned page, starting at 1. |
| `pageSize` | Integer | Maximum items requested for the page. |
| `hasMore` | Boolean | True when another page is available. |

```bash
curl "$SKILL_API/sessions?page=1&pageSize=20" \
  --header "Authorization: Bearer $SKILL_API_KEY"
```

### Read session history

`GET /sessions/{sessionId}` takes the same paging options. HTTP 200 returns `session`, `turns` in order, `page`, `pageSize`, and `hasMore`. Each turn contains `number`, `question`, `answer`, `sources`, `version`, and `createdAt`.

| Response field | Type | Meaning |
| --- | --- | --- |
| `session` | Object | Session fields from Create a session. |
| `turns` | Object array | Saved turns on this page in ascending order. |
| `turns[].number` | Integer | Turn number starting at 1. |
| `turns[].question` | String | Saved question for the turn. |
| `turns[].answer` | String | Complete saved answer. Older turns may have no inline markers. |
| `turns[].sources` | Object array | Same citation fields as Send a question. |
| `turns[].version` | Integer | Published Skill version used for the turn. |
| `turns[].createdAt` | String | Time the turn was saved, in RFC 3339 format. |
| `page`, `pageSize`, `hasMore` | Integer, integer, boolean | Same paging fields as List sessions. |

```bash
curl "$SKILL_API/sessions/$SESSION_ID?page=1&pageSize=20" \
  --header "Authorization: Bearer $SKILL_API_KEY"
```

### Delete a session

`DELETE /sessions/{sessionId}` removes the specified session and its history. HTTP 204 has an empty response body.

```bash
curl --request DELETE "$SKILL_API/sessions/$SESSION_ID" \
  --header "Authorization: Bearer $SKILL_API_KEY"
```

### Error responses

`code` is a machine-readable string. `message` is a human-readable string, and `requestId` identifies the request. Some gateway errors omit the latter two fields.

| Status | Handling |
| --- | --- |
| 400 | Check the body, session ID, or pagination |
| 401 | Use the current key for this Skill |
| 404 | Check that the session exists and belongs to the calling key |
| 409 | The session or release changed while answering. Read it again before retrying |
| 415 | Send `Content-Type: application/json` |
| 429 | Retry after `Retry-After`. Each instance allows 30 external chat requests per minute and four in flight per Skill |
| 500 / 502 / 503 / 504 | The service, knowledge base, or model is unavailable. Retry later |

Try with sign-in continues to use the viewer's Ontology login. Callers with a Runtime Access Token can use `GET /api/runtime/knowledge/skills/{id}`, `POST /api/runtime/knowledge/skills/{id}/ask`, and authorized `/api/runtime/knowledge/files/{projectId}/{fileId}/preview` or `/content` requests.

## Errors

JSON failures normally use this structure:

```json
{
  "code": 400,
  "errorCode": "gateway/bad-request",
  "message": "description of the failure",
  "details": {}
}
```

| HTTP status | Typical meaning |
|---:|---|
| `400` | Missing or invalid Header, JSON body, query parameter, service address, Skill archive, or scope. |
| `401` | Missing Bearer Token or expired/invalid provider Token. |
| `403` | The tenant, Project, resource, or built-in Skill operation is not authorized. |
| `404` | Workspace, file path, Skill, or exact route was not found. |
| `405` | The route exists but the HTTP method is wrong; read the `Allow` Header. |
| `409` | A Skill with the same name already exists. |
| `499` | The caller cancelled the request. |
| `500` | An internal service operation failed. |
| `503` | No supported external authentication controller is active. |

After `/chat` returns HTTP `200`, a later failure appears as an SSE `error` event instead of a new HTTP error response. Its payload uses the same numeric `code`, `errorCode`, `message`, and optional `details` fields.

<a id="security-and-deployment"></a>
## Security and deployment

- Do not log or store provider Tokens in browser storage, URLs, source code, or application logs.
- Use HTTPS between the external project, Harness, and the provider service in production.
- JDCloud currently permits any syntactically valid HTTP(S) service address, including private-network addresses. Harness sends the supplied Token to that address. Expose these routes only to trusted callers or place a destination allowlist in a trusted upstream gateway.
- Resource ownership includes the authenticated provider identity and JDCloud service address or Ontology Project. A caller cannot use another scope's Workspace or Session merely by knowing its ID.
- Restart Harness after deploying code or profile changes. `JDCLOUD_DEFAULT_BASE_URL` is optional for the External API and only supplies the initial browser-login address.

<a id="quick-verification"></a>
## Quick verification

After starting Harness, verify route registration without sending a real Token:

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/skills"
```

A registered route returns `{ "code": 401, "errorCode": "unauthorized", ... }` with HTTP `401` because the Bearer Token is missing. A response that does not follow the numeric envelope means the running process has not loaded the current External API plugin or has not been restarted after the protocol changed.

<a id="dev-note"></a>
## Dev Note

None.
