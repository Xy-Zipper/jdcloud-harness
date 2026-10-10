---
description: "Browser-scoped Ontology Runtime authentication, Host-only rotating token storage, stable user ownership, and prompt admission."
kind: "package-reference"
---

# Ontology Auth Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-ontology-auth-controller` lets each browser sign in to one deployment-owned Ontology Runtime without exposing Access or Refresh Tokens to browser code. It validates the returned identity, rotates expired Access Tokens through the credential store, provides a stable user ownership key, and rejects prompts while that browser is logged out. Choose it for the Ontology Web bundle; keep the existing JDCloud controller for JDCloud deployments.

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
```

| Field | Default | Meaning |
|---|---:|---|
| `ontologyBaseUrl` | required | Fixed Ontology Runtime service address; HTTPS is required outside an explicitly allowed loopback development address. |
| `requestTimeoutMs` | `15000` | Network deadline for login, current-user validation, refresh, and logout. |
| `allowInsecureLoopback` | `false` | Allows explicit HTTP only for `localhost`, `127.0.0.1`, or `::1`. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-ontology-auth-controller) is the exhaustive source for accepted fields.

The browser calls `login()` with only an account and password. The Host calls Runtime login and current-user endpoints, stores both tokens in the credential provider, and returns only the service address and identity. A stored Access Token rejected with `runtime_unauthenticated` is refreshed under the provider's record lock; refresh failure removes only that browser's record. Current-user validation writes the record only when identity fields changed, so its update event cannot trigger a validation loop. `logout()` revokes the selected Runtime Session before deleting that record.

Host-only consumers call `requestAuthenticated()` with a fixed `/api/runtime/` path, method, and optional JSON body. The controller selects the current browser record, validates or refreshes it, attaches the Access Token, and retries once when that request reports an expired Access Token. The consumer remains responsible for validating the returned untrusted JSON.

Credential ids contain `SHA256(ontologyBaseUrl + browserSessionId)`. `currentScopeKey()` instead returns `SHA256(ontologyBaseUrl + userId)`, so independent logins for the same Ontology user resolve to the same stable owner. Prompt admission validates or refreshes the current browser login before Session delivery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The controller keeps no process-global user. `BrowserSessionService` supplies one request-local opaque browser id, the credential provider serializes token rotation, and the Runtime `current` response supplies the stable user and authorization version. Remote methods return redacted values only.

| Source | Responsibility |
|---|---|
| [`src/client.ts`](src/client.ts) | HTTPS policy, Runtime identity requests, and response validation. |
| [`src/index.ts`](src/index.ts) | Browser-scoped records, refresh, logout, stable owner keys, and prompt admission. |
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

- Session and Workspace ownership consumers do not yet use `currentScopeKey()`; this stage exposes and tests the stable identity but does not complete the later Ontology deployment switch.
- Custom certificate-authority configuration is not owned by this package; production HTTPS uses the Host Node.js trust configuration.
- Authenticated Runtime transport accepts only fixed `/api/runtime/` paths without query strings or fragments; the consuming package owns request selection and response validation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The controller validates every owner-defined credential record before reading either token.
