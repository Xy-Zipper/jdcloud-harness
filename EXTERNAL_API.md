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
- [Session history API](#session-history-api)
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
| `GET` | `/api/external/v1/sessions/history` | Read text-message history for one Session. |
| `POST` | `/api/external/v1/sessions/create` | Create a Session in an owned Workspace without invoking a model. |
| `GET` | `/api/external/v1/sessions/file` | Read a bounded UTF-8 file under Session ownership. |
| `POST` | `/api/external/v1/sessions/files/upload` | Stage a Session file and return its upload receipt. |
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

<a id="session-history-api"></a>
## Session History API

```powershell
curl.exe --request GET "http://127.0.0.1:3080/api/external/v1/sessions/history?sessionId=session-id&maxMessages=100" `
  --header "Authorization: Bearer <raw-low-code-token>" `
  --header "X-Tenant-Id: 6ad80f2f1f280486bb45ac3a" `
  --header "X-JDCloud-Base-Url: https://mi.kindoucloud.com"
```

`sessionId` is required. `maxMessages` is optional, defaults to `100`, and accepts `1` through `200`. The endpoint reuses Session Controller ownership checks, so the current platform identity can read only Sessions it owns. Results include assistant text and user text whose source kind is `user`; runtime context, skill catalogs, skill instructions, reasoning, tool calls, tool results, and other internal events are excluded.

`data.running` reports whether the live Agent was running before or after the history snapshot. Optional `data.startedAt` is the current `turn/start` time when that event is present in the window. Poll history after a page reload or interrupted chat stream to follow the existing work without resubmitting a prompt; intermediate assistant messages are not completion.

```json
{
  "code": 200,
  "data": {
    "sessionId": "session-id",
    "cursor": 12,
    "hasMore": false,
    "messages": [
      { "id": "message-id", "role": "user", "text": "Change the target platform", "createdAt": 1790000000000 },
      { "id": "message-id-2", "role": "assistant", "text": "The proposed change is ready.", "createdAt": 1790000001000 }
    ]
  }
}
```

<a id="conversation-api"></a>
## Conversation API

To attach files, first POST JSON `{ "workspaceId": "..." }` to `/api/external/v1/sessions/create` and retain `data.sessionId`. POST raw file bytes with `Content-Type: application/octet-stream` to `/api/external/v1/sessions/files/upload?sessionId=...&name=brief.pdf`. The endpoint reuses current-identity ownership checks and the Session attachment service, returns `{ code: 200, data: { receiptId, file } }`, and accepts at most 30 MiB per request. The next `/chat` may supply `fileReceiptIds: ["..."]`; receipts are accepted only by the receiving Session. Plain text chats may omit this field.

Read generated artifacts through `GET /api/external/v1/sessions/file?sessionId=...&path=artifact.json`, whose `data` contains `{ path, text, version }`. This endpoint reuses Session-history ownership and Workspace file-read policies without activating an Agent. Existing preview line and byte caps apply; a partial preview is rejected instead of returning truncated content. All endpoints use this document's authentication Headers; missing files return `404`.

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
