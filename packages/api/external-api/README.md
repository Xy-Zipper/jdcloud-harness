---
description: "External token-authenticated HTTP and SSE API for account Skills, Workspaces, files, and Session conversations."
kind: "package-reference"
---

# External API

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-external` exposes exact `/api/external/v1/*` routes for server-side integrations. JDCloud deployments authenticate a raw low-code token and `X-Tenant-Id`; Ontology deployments authenticate a Runtime Access Token and `X-Project-Id`. Every request is validated by the active authentication controller and then reuses the existing Skill, Workspace, file, and Session services.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/external/v1/skills` | List personal and built-in Skills. |
| `POST` | `/api/external/v1/skills/upload` | Install a complete `personal` or `built-in` Skill folder. |
| `POST` | `/api/external/v1/skills/delete` | Delete an authorized personal or built-in Skill. |
| `GET` | `/api/external/v1/workspaces` | List visible Workspaces. |
| `POST` | `/api/external/v1/workspaces/create` | Create or reuse one child directory and Workspace. |
| `GET` | `/api/external/v1/workspaces/files` | List one Workspace directory. |
| `POST` | `/api/external/v1/chat` | Create or continue a Session and return SSE events. |

All requests carry `Authorization: Bearer <token>`. JDCloud accepts only the low-code Token with `X-Tenant-Id`; Ontology accepts only the Go Runtime Access Token with `X-Project-Id`. The two scope headers are not aliases, and a deployment rejects the other header. The chat body accepts `message`, optional `sessionId`, `workspaceId` for a new Session, and optional `skillNames`. SSE emits `session`, `snapshot`, `event`, `assistant`, `done`, and `error`. `assistant` contains the model-provided live chunk, including provider reasoning fields when the model emits them; the API does not manufacture or expose hidden reasoning.

## Model Experience

### Selected Skills

#### What the model sees

When `skillNames` is non-empty, the API submits the logged user message as one line of space-separated `/<skill-name>` invocations, followed by a newline and the caller's `message`. Session Controller and the Skill runtime resolve those invocations normally.

#### Token effect

Each selected Skill adds its invocation text and the Skill runtime's resolved instructions to the request context. The selected Skill files own the instruction length.

#### KV Cache effect

Selecting, removing, or reordering Skills changes the logged user message and resolved instructions, so the affected request does not retain the otherwise identical unskilled prefix.

## Known Limitations and Deferred Work

- Routes do not add browser CORS policy; browser applications should use a same-origin deployment or a server-side proxy.
- Workspace file access currently lists directories and does not download file contents.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** The active authentication controller validates the raw provider token and requested tenant or Project before any business service executes.
