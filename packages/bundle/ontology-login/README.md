---
description: "Optional Web profile layer installing browser-isolated Ontology Runtime authentication, model tools, login UI, account controls, and branding."
kind: "package-bundle"
---

# dsh-ontology-login

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-ontology-login` adds browser-isolated Ontology Runtime sign-in, authorized Object and Link reads, confirmed prepared Action execution, account-scoped Workspace browsing, and account presentation to a Web profile. It disables shared Harness launch authentication, enables the tab-scoped browser Bearer session, and installs the Ontology controller, model tools, login UI, and in-app directory picker. Ontology becomes the profile's application identity and authorization layer.

The bundle also installs the external API. Those routes accept a Go Runtime Access Token and `X-Project-Id`, validate that the user can see the Project, and isolate personal Skills, Workspaces, and Sessions by Project and user without creating browser login state.

The Go file assistant calls `POST /api/internal/file-assistant/answer` with `Authorization: Bearer <FILE_ASSISTANT_SERVICE_TOKEN>` and JSON `{"question":"…","sources":[{"id":"S1","fileName":"…","text":"…"}]}`. Set the same private service token on both servers. Go authorizes file access and sends up to eight excerpts within a 512 KiB request. The response contains `answer` and unique `sourceIds` from this request. An empty list signals insufficient evidence. A missing service token returns 503, an incorrect token returns 401, and a model failure or invalid citation returns 502.

For a nonempty batch of excerpts, send `task: "qa"` to generate `questions` or `task: "extract"` to extract `entities` and `relations`. These requests contain `task` and `sources`. Every returned row carries `sourceIds` from the supplied batch. Relation endpoints are named entities in the same response.

Pipeline field generation sends `{"task":"pipeline","prompt":"…","fields":{"content":"…"},"outputType":"entities"}` to the same route. The response contains `value`, an array of entity names for `entities`, a string for `text`, or an object for `json`. The prompt includes an example for the selected output type. A single JSON code fence is accepted around a valid result. Only selected fields and the supplied instructions enter the model call.

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

To switch the Web profile from JDCloud to Ontology, run `pnpm run plugins:ontology`. The script reads the profile's dependency declarations directly, so it can remove JDCloud after switching branches even when its local package link is broken. It skips undeclared JDCloud plugins and can be run repeatedly.

Set the required Runtime address before launching the profile:

```dotenv
ONTOLOGY_BASE_URL=https://ontology.example.com
ONTOLOGY_REQUEST_TIMEOUT_MS=15000
```

Local development may explicitly set `ONTOLOGY_BASE_URL=http://127.0.0.1:8080` together with `ONTOLOGY_ALLOW_INSECURE_LOOPBACK=true`. Non-loopback HTTP is always rejected.

User workspaces and account-managed Skills default to `$DSH_HOME/account-workspaces`. A server only needs to persist `$DSH_HOME`; set `ONTOLOGY_USER_WORKSPACE_DIR=/workspace/ontology-users` when those account files must use a separate persistent volume.

### What you get

The sidebar uses Ontology account controls at the top and a direct Settings button at the bottom. The bundle disables the official account UI and its notifications.

The layer disables `authentication-token` and installs `@deepseek-ai/dsh-client-connection/browser-session` as the Connection authentication provider. The Client keeps the opaque Host identity in the current tab's `sessionStorage`, authenticates same-origin requests with a Bearer header, and obtains a short-lived single-use ticket for each WebSocket connection. The layer also replaces the adaptive operating-system chooser with the in-app directory browser, which opens at the authenticated user's Workspace root, lists only descendants accepted by the Host, and creates child folders there. It inserts `ontology-auth-controller`, `tool-ontology`, and `ui-ontology-login`, and suppresses the first-run model credential dialog. Confirmation-required Actions reuse the Web profile's shared approval panel, while Ontology Runtime remains the authority for Project access, current Invocation state, atomic execution, and writes.

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

Indirectly, through `@deepseek-ai/dsh-tool-ontology`, which owns the Ontology guidance, thirteen tool schemas, and validated Runtime results.

Each file question uses the current default model to answer from the submitted excerpts, with a 4,096-token output budget and a 60-second deadline. The model receives just the evidence instructions and that request's data. This route has no tools or conversation history.

#### KV Cache effect

The file assistant reuses its evidence instructions across calls. The inserted tool package owns prompt and tool-schema changes for interactive Sessions.

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

**Runtime invariant:** Loader activates the file assistant as a separate Host plugin in the Ontology profile.
