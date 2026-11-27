---
description: "Optional Web profile layer installing browser-isolated Ontology Runtime authentication, model tools, login UI, account controls, and branding."
kind: "package-bundle"
---

# dsh-ontology-login

English | [中文](README.zh.md)

## Summary

This optional Web profile layer uses Ontology as its application identity and authorization provider. It adds project tools, document citations, and published Skills for browser and server integrations. Add or remove it as a profile bundle. Published Skills use the project and knowledge bases chosen by their administrator.

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

The sidebar uses Ontology account controls at the top and More at the bottom. More opens Panel settings and, for Ontology administrators, the dedicated Skills page. The bundle disables the official account UI and its notifications.

Agent chat retrieves project documents and displays clickable citations. A published Skill uses its released role and knowledge-base scope for full-page iframes, floating chat widgets, and a server API with key-owned session history. The API returns JSON by default and offers SSE answer deltas on request. See [Knowledge Skill integration](../../../EXTERNAL_API.md#knowledge-skill-integration).

The assistant embedded in Ontology displays the signed-in account's Workspace folders and conversations for the selected Project. Opening Harness directly with the same account shows account-level history created without a Project.

The layer disables `authentication-token` and installs `@deepseek-ai/dsh-client-connection/browser-session` as the Connection authentication provider. The Client keeps the opaque Host identity in the current tab's `sessionStorage`, authenticates same-origin requests with a Bearer header, and obtains a short-lived single-use ticket for each WebSocket connection. The layer also replaces the adaptive operating-system chooser with the in-app directory browser, which opens at the authenticated user's Workspace root, lists only descendants accepted by the Host, and creates child folders there. It inserts `ontology-auth-controller`, `tool-ontology`, and `ui-ontology-login`, and suppresses the first-run model credential dialog. Confirmation-required Actions reuse the Web profile's shared approval panel, while Ontology Runtime remains the authority for Project access, current Invocation state, atomic execution, and writes.

The external Runtime API validates the Go Runtime Access Token and `X-Project-Id`. It isolates personal Skills, Workspaces, and Sessions by project and user.

The Go file assistant calls `POST /api/internal/file-assistant/answer` with `Authorization: Bearer <FILE_ASSISTANT_SERVICE_TOKEN>` and JSON `{"question":"…","sources":[{"id":"S1","fileName":"…","text":"…"}]}`. Set the same private service token on both servers. Go authorizes file access and sends up to eight excerpts within a 512 KiB request. The response contains `answer` and unique `sourceIds` from this request. An empty list signals insufficient evidence. A missing service token returns 503, an incorrect token returns 401, and a model failure or invalid citation returns 502.

For published Skill API chat, Go sends `inlineCitations: true` with public source IDs such as `R-0123456789`. The answer places `[R-0123456789]` after the supported sentence or paragraph. The markers match the final `sourceIds` in JSON and NDJSON.

For a nonempty batch of excerpts, send `task: "qa"` to generate `questions` or `task: "extract"` to extract `entities` and `relations`. These requests contain `task` and `sources`. Every returned row carries `sourceIds` from the supplied batch. Relation endpoints are named entities in the same response.

Pipeline field generation sends `{"task":"pipeline","prompt":"…","fields":{"content":"…"},"outputType":"entities"}` to the same route. The response contains `value`, an array of entity names for `entities`, a string for `text`, or an object for `json`. A single JSON code fence may wrap the result. The model receives the selected fields and supplied instructions.

Whole-file entity extraction sets `wholeFile: true` and places the selected fields of the file's slices in `fields.rows`. When the configured model supports turning off reasoning, this request uses direct generation. Go matches the returned names to occurrences in the original slices.

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
