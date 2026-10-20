---
description: "External token-authenticated HTTP and SSE API for account Skills, Workspaces, files, and Session conversations."
kind: "package-reference"
---

# External API

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-external` exposes exact `/api/external/v1/*` routes for server-side integrations. JDCloud deployments authenticate a raw low-code token, `X-Tenant-Id`, and a caller-selected `X-JDCloud-Base-Url`; Ontology deployments authenticate a Runtime Access Token and `X-Project-Id`. Every request is validated by the active authentication controller and then reuses the existing Skill, Workspace, file, and Session services.

## Table of Contents

- [Routes](#routes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="routes"></a>
## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/external/v1/skills` | List personal and built-in Skills. |
| `POST` | `/api/external/v1/skills/upload` | Install a `personal` or `built-in` Skill from one ZIP archive. |
| `POST` | `/api/external/v1/skills/delete` | Delete an authorized personal or built-in Skill. |
| `GET` | `/api/external/v1/workspaces` | List visible Workspaces. |
| `POST` | `/api/external/v1/workspaces/create` | Create or reuse one child directory and Workspace. |
| `GET` | `/api/external/v1/workspaces/files` | List one Workspace directory. |
| `POST` | `/api/external/v1/chat` | Create or continue a Session and return SSE events. |

All requests carry `Authorization: Bearer <token>`. JDCloud requires the low-code Token, `X-Tenant-Id`, and `X-JDCloud-Base-Url`; the controller accepts any syntactically valid absolute HTTP(S) address without credentials, query, or fragment. Ontology requires the Go Runtime Access Token and `X-Project-Id`, and rejects JDCloud headers. Every JSON success is `{ code: 200, data }`; every JSON failure uses a numeric `code` equal to its HTTP status and preserves the specific string identifier in `errorCode`. The chat body accepts `message`, optional `sessionId`, `workspaceId` for a new Session, and optional `skillNames`. SSE emits `session`, `snapshot`, `event`, `assistant`, `done`, and `error`; each success event carries `{ code: 200, data }`, while an `error` event carries the mapped numeric code. `assistant` contains the model-provided live chunk, including provider reasoning fields when the model emits them; the API does not manufacture or expose hidden reasoning.

`POST /api/external/v1/skills/upload` accepts `multipart/form-data` with one text field named `scope` (`personal` or `built-in`) and one `.zip` file field named `file`. The archive may place `SKILL.md` at its root or inside one wrapping directory; every archived file must belong to that Skill folder. The endpoint rejects the former JSON file-array body and applies the existing Skill path, file-count, expanded-size, metadata, and administrator checks.

<a id="model-experience"></a>
## Model Experience

### Selected Skills

#### What the model sees

When `skillNames` is non-empty, the API submits the logged user message as one line of space-separated `/<skill-name>` invocations, followed by a newline and the caller's `message`. Session Controller and the Skill runtime resolve those invocations normally.

#### Token effect

Each selected Skill adds its invocation text and the Skill runtime's resolved instructions to the request context. The selected Skill files own the instruction length.

#### KV Cache effect

Selecting, removing, or reordering Skills changes the logged user message and resolved instructions, so the affected request does not retain the otherwise identical unskilled prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Routes do not add browser CORS policy; browser applications should use a same-origin deployment or a server-side proxy.
- Workspace file access currently lists directories and does not download file contents.
- JDCloud callers select an unrestricted HTTP(S) destination. The Host sends the supplied Token to that destination and can reach private-network addresses, so deployments must trust callers or add an upstream allowlist before exposing these routes.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** The active authentication controller validates the raw provider token and requested tenant or Project before any business service executes.
