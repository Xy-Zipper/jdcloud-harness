---
description: "Host JDCloud authentication, durable token ownership, browser-prompt admission validation, and authenticated API reuse."
kind: "package-reference"
---

# JDCloud Auth Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-jdcloud-auth-controller` implements the JDCloud calls required by the low-code login flow: password login, tenant-list validation, and tenant switching. It owns the token in Host credentials, exposes the generated `jdcloudAuth` Remote namespace, lets other Host plugins reuse the authenticated connection without reading that token, and checks the tenant list before every browser prompt enters a Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the controller beside API Gateway, Session Controller, and a writable credentials provider. The optional [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.md) bundle installs the controller and its browser page together.

`login()` sends `POST /api/oauth/login` with the original `client_id=admin`, `client_secret=123456`, `scope=all`, and `grant_type=password` query values. Its JSON body contains only the trimmed account and an MD5 password. It does not send a tenant id. After receiving a token, the controller calls `GET /api/system/corp/getCorpList`, combines `corpList` and `joinCorpList`, resolves the current tenant named by `data.corpId`, and stores the normalized service address, token, account, current tenant, and available tenants together.

`switchCorp()` accepts only a tenant returned in authenticated status, calls `GET /api/system/corp/switchCorp/{corpId}` with the stored token, and then reads the tenant list again. The controller keeps the stored token because JDCloud refreshes its tenant context server-side. A successful switch returns authenticated status for the confirmed tenant; ordinary failures preserve the current login, while codes `600`, `601`, and `602` delete it as expired.

Before Session Controller persists attachments or delivers a browser prompt, the controller calls the same tenant-list endpoint with the stored token. Business codes `600`, `601`, and `602` delete the stored login and reject the prompt as expired. Network failures and other business codes reject that submission without deleting the login.

The browser can read `{ authenticated, baseUrl, username, corpId, corpName, corps }` for an authenticated login; the token never crosses the Remote wire. `logout()` deletes the complete credential record. Passwords exist only for the duration of the login call and are never stored by this package.

Host plugins can call `requestAuthenticated({ path, method, body? }, signal)` for a fixed `/api/...` path. The controller reads the current credential internally, adds the authorization header, applies `requestTimeoutMs`, returns the successful response's `data`, and never returns the token. It accepts JSON `GET`, `POST`, `PUT`, and `DELETE` requests; `GET` bypasses caches. Codes `600`, `601`, and `602` delete the stored login and become `jdcloud/auth-required`, while other business errors preserve the login.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `defaultBaseUrl` | empty | Initial service address shown before a login is stored |
| `requestTimeoutMs` | `15,000` | Deadline for login, tenant-list, tenant-switch, and Host authenticated requests |

<a id="model-experience"></a>
## Model Experience

None, as prompt admission runs before Session or Agent delivery and adds no model-visible content.

#### KV Cache effect

None; accepted requests are unchanged, and rejected requests never reach prompt assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `requestAuthenticated()` is Host-only and supports JSON request bodies; it is not a browser proxy or a multipart upload client.
- The inherited JDCloud login protocol uses MD5 because the upstream endpoint requires that wire behavior; it is not a password-storage scheme.
- Stored logins are Host-wide for this controller instance rather than browser-user scoped.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** No companion is published. The controller validates its owned credential record every time it reads it, and prompt admission validates the token before delivery.
