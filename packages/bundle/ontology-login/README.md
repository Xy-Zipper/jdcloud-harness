---
description: "Optional Web profile layer installing browser-isolated Ontology Runtime authentication, model tools, login UI, account controls, and branding."
kind: "package-bundle"
---

# dsh-ontology-login

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-ontology-login` adds browser-isolated Ontology Runtime sign-in, authorized Object and Link reads, confirmed prepared Action execution, account-scoped Workspace browsing, and account presentation to a Web profile. It disables shared Harness launch authentication, enables the tab-scoped browser Bearer session, and installs the Ontology controller, model tools, login UI, and in-app directory picker. Ontology becomes the profile's application identity and authorization layer.

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

### Install into a profile

From the repository root, add or remove this optional layer from a Web profile:

```text
pnpm dsh plugin --profile web add ./packages/bundle/ontology-login
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-ontology-login
```

Set the required Runtime address before launching the profile:

```dotenv
ONTOLOGY_BASE_URL=https://ontology.example.com
ONTOLOGY_REQUEST_TIMEOUT_MS=15000
```

Local development may explicitly set `ONTOLOGY_BASE_URL=http://127.0.0.1:8080` together with `ONTOLOGY_ALLOW_INSECURE_LOOPBACK=true`. Non-loopback HTTP is always rejected.

User workspaces and account-managed Skills default to `$DSH_HOME/account-workspaces`. A server only needs to persist `$DSH_HOME`; set `ONTOLOGY_USER_WORKSPACE_DIR=/workspace/ontology-users` when those account files must use a separate persistent volume.

### What you get

The layer replaces the Connection row with `browserAuthentication: false`, `browserSession: true`, and `browserSessionTransport: bearer`. The Client keeps the opaque Host identity in the current tab's `sessionStorage`, authenticates same-origin requests with a Bearer header, and obtains a short-lived single-use ticket for each WebSocket connection. The layer also replaces the adaptive operating-system chooser with the in-app directory browser, which opens at the authenticated user's Workspace root, lists only descendants accepted by the Host, and creates child folders there. It inserts `ontology-auth-controller`, `tool-ontology`, and `ui-ontology-login`, and suppresses the first-run model credential dialog. Confirmation-required Actions reuse the Web profile's shared approval panel, while Ontology Runtime remains the authority for Project access, current Invocation state, atomic execution, and writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) owns the complete optional layer. `ONTOLOGY_BASE_URL` is deployment-required; the patch passes timeout, loopback policy, and the optional `ONTOLOGY_USER_WORKSPACE_DIR` override into the Host controller, pins the browse directory-picker pair, and leaves every row replaceable by profile or command-line patches above it. [`src/index.ts`](src/index.ts) is the empty bundle carrier required by package loading.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profiles and bundles](../../../docs/architecture.md) — layer ordering and overrides.
- [Ontology Auth Controller](../../api/ontology-auth-controller/README.md) — token lifecycle and identity Scope.
- [Ontology tools](../../ontology/tool-ontology/README.md) — Project discovery, Object reads, Link traversal, and Actions.
- [Ontology Login UI](../../client/ui-ontology-login/README.md) — browser-visible behavior.
- [Bundle group map](../README.md) — other shipped profile layers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-ontology`, which owns the Ontology guidance, nine tool schemas, and validated Runtime results.

#### KV Cache effect

The bundle itself adds no request prefix; the inserted tool package owns prompt and tool-schema changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This layer targets the Web profile because independent browser identity and the login root require the Web Connection and Slot services.
- Confirmation-required Actions depend on the Web profile's shared approval service; a session with approval policy `never` rejects them without prompting.
- Removing the layer does not delete its owner-defined credential records or revoke Runtime Sessions that were not explicitly logged out.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Loader validates all five inserted package rows, and each package validates its own state.
