---
description: "Host JDCloud authentication, durable token ownership, browser-prompt admission validation, and authenticated API reuse."
kind: "package-reference"
---

# JDCloud Auth Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-jdcloud-auth-controller` implements the JDCloud calls required by the low-code login flow: password and transferred-token login, tenant and current-user validation, and tenant switching. It owns the token and current-tenant administrator flag in Host credentials, exposes the generated `jdcloudAuth` Remote namespace, lets other Host plugins reuse the authenticated connection without reading that token, and validates browser prompts and model selection.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the controller beside API Gateway, Session Controller, and a writable credentials provider. The optional [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.md) bundle installs the controller and its browser page together.

`login()` sends `POST /api/oauth/login` with the original `client_id=admin`, `client_secret=123456`, `scope=all`, and `grant_type=password` query values. Its JSON body contains only the trimmed account and an MD5 password. It does not send a tenant id. After receiving a token, the controller calls `GET /api/system/corp/getCorpList`, then `GET /api/oauth/currentUser`, requires both responses to name the same tenant, and stores the normalized service address, token, account, current tenant, available tenants, and `userPermission.systemAdministrator === true` result together.

`loginWithToken()` first deletes any stored login, normalizes the supplied absolute HTTP(S) service address, and validates the supplied token through `GET /api/system/corp/getCorpList` followed by `GET /api/oauth/currentUser`. The two responses must name the same current tenant. A successful transfer stores the account label, tenant list, administrator flag, and token on the Host; invalid or failed transfer information leaves the controller logged out. The caller controls the destination, so the Host sends the Token and validation requests to any syntactically valid HTTP(S) address.

`switchCorp()` accepts only a tenant returned in authenticated status, calls `GET /api/system/corp/switchCorp/{corpId}` with the stored token, accepts the confirmed tenant id from either `data: corpId` or `data: { corpId }`, and then reads the tenant list and current user again. The controller keeps the stored token because JDCloud refreshes its tenant context server-side. A successful switch returns the confirmed tenant and its administrator flag; ordinary failures preserve the current login, while codes `600`, `601`, and `602` delete it as expired.

Before Session Controller persists attachments or delivers a browser prompt, the controller calls the tenant-list and current-user endpoints with the stored token. It synchronizes a changed tenant list or administrator flag before admitting the prompt. Business codes `600`, `601`, and `602` delete the stored login and reject the prompt as expired. Network failures and other business codes reject that submission without deleting the login.

Before Session Controller changes a Session model, the controller reads the stored administrator flag through `api-session/model-selection-admission`. Missing login returns `jdcloud/auth-required`; a non-administrator returns `jdcloud/administrator-required` without changing the Session or deployment default model.

The browser can read `{ authenticated, baseUrl, username, corpId, corpName, corps, systemAdministrator }` for an authenticated login; the token never crosses the Remote wire. Version-3 records are upgraded once through `currentUser` before use. `logout()` deletes the complete credential record. Passwords exist only for the duration of the login call and are never stored by this package.

The browser can call `writableMenus()` to refresh `/api/oauth/currentUser` and receive only the current tenant id plus type `3` forms and type `4` workflows that carry at least one recognized `addData`, `editData`, or `deleteData` grant. Each returned menu contains its id, name, resolved parent path, type, and recognized write grants. The method uses the stored Host login and never returns profile fields, the service address, or the Token.

Host plugins can call `requestAuthenticated({ path, method, body? }, signal)` for a fixed `/api/...` path. The controller reads the current credential internally, adds the authorization header, applies `requestTimeoutMs`, returns the successful response's `data`, and never returns the token. It accepts JSON `GET`, `POST`, `PUT`, and `DELETE` requests; `GET` bypasses caches. Codes `600`, `601`, and `602` delete the stored login and become `jdcloud/auth-required`, while other business errors preserve the login.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `defaultBaseUrl` | empty | Initial service address shown before a login is stored |
| `requestTimeoutMs` | `15,000` | Deadline for login, tenant, current-user, tenant-switch, and Host authenticated requests |

<a id="model-experience"></a>
## Model Experience

None, as prompt admission runs before Session or Agent delivery and adds no model-visible content.

#### KV Cache effect

None; accepted requests are unchanged, and rejected requests never reach prompt assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `requestAuthenticated()` is Host-only and supports JSON request bodies; it is not a browser proxy or a multipart upload client.
- A transferred service address is unrestricted after HTTP(S) URL validation, so a link can direct the Host to disclose its supplied Token to an arbitrary server and request private-network addresses.
- The inherited JDCloud login protocol uses MD5 because the upstream endpoint requires that wire behavior; it is not a password-storage scheme.
- Stored logins are Host-wide for this controller instance rather than browser-user scoped.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** No companion is published. The controller validates its owned credential record every time it reads it, and prompt admission validates the token before delivery.
