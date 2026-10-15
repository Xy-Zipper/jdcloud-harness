---
description: "Browser-scoped Ontology Runtime authentication with password login or validated embedded-session import, Host-owned rotating token storage, stable user ownership, and prompt admission."
kind: "package-reference"
---

# Ontology Auth Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-ontology-auth-controller` lets each browser sign in to one deployment-owned Ontology Runtime by password or by importing a Runtime Session from an authenticated embedding page. It validates the active token against the Runtime identity endpoint, stores rotating tokens under that browser's credential record, assigns Session and Workspace ownership to the stable Ontology user, and rejects prompts while that browser is logged out. Choose it as the application identity layer for the Ontology Web bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the controller with writable credentials and the independent browser-session service:

```yaml
- name: '@deepseek-ai/dsh-api-ontology-auth-controller'
  config:
    ontologyBaseUrl: https://ontology.example.com
    requestTimeoutMs: 15000
    allowInsecureLoopback: false
    userWorkspaceDirectory: /workspace/ontology-users
```

| Field | Default | Meaning |
|---|---:|---|
| `ontologyBaseUrl` | required | Fixed Ontology Runtime service address; HTTPS is required outside an explicitly allowed loopback development address. |
| `requestTimeoutMs` | `15000` | Network deadline for login, current-user validation, refresh, and logout. |
| `allowInsecureLoopback` | `false` | Allows explicit HTTP only for `localhost`, `127.0.0.1`, or `::1`. |
| `userWorkspaceDirectory` | disabled | Optional persistent parent directory that confines each Ontology user's Workspace paths. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-ontology-auth-controller) is the exhaustive source for accepted fields.

The browser calls `login()` with only an account and password. The Host calls Runtime login and current-user endpoints, stores both tokens in the credential provider, and returns only the service address and identity. A stored Access Token rejected with `runtime_unauthenticated` is refreshed under the provider's record lock; refresh failure removes only that browser's record. Current-user validation writes the record only when identity fields changed, so its update event cannot trigger a validation loop. `logout()` revokes the selected Runtime Session before deleting that record.

An authenticated embedding page can call `importSession()` through the Client Remote bridge with a freshly issued Runtime token pair. The Host verifies the Access Token through `/api/runtime/auth/current`, rejects an identity mismatch, and replaces only the current Browser Session's credential record. The method returns redacted status and never returns either token to the caller.

Host-only consumers call `requestAuthenticated()` with a fixed `/api/runtime/` path, method, and optional JSON body. The controller selects the current browser record, validates or refreshes it, attaches the Access Token, and retries once when that request reports an expired Access Token. The consumer remains responsible for validating the returned untrusted JSON.

Credential ids contain `SHA256(ontologyBaseUrl + browserSessionId)`. `currentScopeKey()` instead includes the service address and stable user id, so independent logins for the same Ontology user resolve to one owner. Session, Workspace, file, and reference consumers use this owner; `userWorkspaceDirectory` additionally confines selected paths to that user's private directory. Prompt admission validates or refreshes the current browser login before Session delivery, while terminal access and `danger-full-access` require an administrator account.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The controller keeps no process-global user. `BrowserSessionService` supplies one request-local opaque browser id, the credential provider serializes token rotation, and the Runtime `current` response supplies the stable user and authorization version. Remote responses are redacted; imported token fields are validated and written directly to the Host credential provider.

| Source | Responsibility |
|---|---|
| [`src/client.ts`](src/client.ts) | HTTPS policy, Runtime identity requests, and response validation. |
| [`src/index.ts`](src/index.ts) | Browser-scoped records, refresh, logout, stable owner keys, private Workspace roots, and admission. |
| [`src/types.ts`](src/types.ts) | Browser-safe Remote request, status, and error vocabulary. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser Connection](../../client/connection/README.md) — signed independent browser sessions.
- [Credentials](../../credentials/credentials/README.md) — durable owner-defined records and serialized rotation.
- [Ontology login UI](../../client/ui-ontology-login/README.md) — browser login and account presentation.
- [Ontology login bundle](../../bundle/ontology-login/README.md) — complete Web-profile composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as authentication admission rejects logged-out prompts before Session delivery and adds no model-visible content.

#### KV Cache effect

Accepted prompts are unchanged; rejected prompts do not reach model request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Custom certificate-authority configuration is not owned by this package; production HTTPS uses the Host Node.js trust configuration.
- Authenticated Runtime transport accepts only fixed `/api/runtime/` paths without query strings or fragments; the consuming package owns request selection and response validation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The controller validates every owner-defined credential record before reading either token.
