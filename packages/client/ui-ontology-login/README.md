---
description: "Web login gate, exact-origin embedded Runtime Session handoff, Ontology branding, and a redacted sidebar identity for browser-scoped authentication."
kind: "package-reference"
---

# Ontology Login UI

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-ontology-login` presents an account-and-password gate until the current standalone browser has an Ontology Runtime login. When an authenticated Ontology page embeds Harness, the plugin shows a session-transfer page instead of the password form, accepts a Runtime Session only from that exact parent origin, and imports it into the Host. After login it shows the redacted identity, account type, fixed service address, and a sign-out action in the sidebar. Token fields remain transient and are not placed in URL or browser storage.

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

Mount this Client plugin through the [`dsh-ontology-login`](../../bundle/ontology-login/README.md) bundle. The Host controller supplies the service address, so the page accepts only account and password fields. Login and logout clear the selected Workspace or Session view before switching the visible identity.

The plugin registers localized Chinese and English copy, an Ontology graph mark, the guarded root page, and the sidebar account seat. Credential notifications refresh the identity only for the current browser's `ontology-auth-controller/login-*` record; Workspace and Session owner grants preserve the active view.

The sidebar, sign-in page, and embedded session-transfer page use the build-time `DSH_CLIENT_TITLE` as their product name, with `LSY-Agent` as the default.

When Harness runs in an iframe, the root Slot shows a localized session-transfer page and never exposes the password form. The plugin derives the allowed parent origin from `document.referrer`, announces readiness to that origin, and accepts one versioned `ontology/runtime-session` message from `window.parent`. It validates the message fields, calls the Host `importSession()` Remote method, applies the returned redacted status, and reports only success or failure to the parent.

An iframe URL with `ontologyEmbed=1` accepts a top-level `context: { projectId, projectName, mode: 'modeling' }` beside the transferred `session`. After the Host validates that Project, the page renders a compact native Chat, project history, and a New conversation action that reuses an available blank Session. History lists only conversations with content; unused blank Sessions remain stored. Native file, image, and document attachment controls retain their existing upload and analysis path. A successful handoff acknowledges the validated `projectId` and `mode`; a committed successful `ontology_add_draft_resources` or `ontology_update_draft_bindings` result sends `ontology/draft-updated` to the exact parent origin.

The full assistant accepts `mode: 'runtime'` in the same Project context and retains the full workspace interface. Each successful handoff acknowledges both the Project id and mode so the parent can confirm a project switch.

The administrative Skills page follows the selected project in the Ontology workbench. In standalone Harness, the project picker opens one project's Skills. The publication panel includes API key management, request and response fields, and copyable JSON and SSE examples for the selected Skill.

In the full assistant, a reply can cite results from the current or an earlier loaded turn in the same conversation. A verified document link or a quoted title with a matching document ID opens the authorized original preview. A source gets a fragment tag when the reply has no matching inline citation. Clicking a fragment opens its retrieval result in the right sidebar. The sidebar starts closed when a conversation opens or refreshes.

The original preview opens directly at the citation's recorded PDF page or the page stored on the referenced RAGFlow document. For older slices, the client uses the slice's position to guide a text search in the original. Local Chinese OCR checks rendered candidate pages when the PDF text layer cannot supply a match. Confirmed matches appear in the result card and preview and are reused for the same passage when reopened in the current browser tab. The button in the preview footer opens the full PDF at the citation page in a new tab.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry has no route behavior. The Client entry mounts the generated Remote contribution and installs all Slot occupants in the same lifecycle. Pure React components receive redacted state and registration-owned callbacks.

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Remote status lifecycle, exact-origin embedded-session bridge, root gate, account seat, and brand Slot registrations. |
| [`src/client/EmbeddedSessionPage.tsx`](src/client/EmbeddedSessionPage.tsx) | Embedded session-transfer presentation without credential inputs. |
| [`src/client/modeling.ts`](src/client/modeling.ts) / [`src/client/ModelingConversation.tsx`](src/client/ModelingConversation.tsx) | Private Project Workspace preparation, native conversation composition, and draft-save notifications. |
| [`src/client/LoginPage.tsx`](src/client/LoginPage.tsx) | Account-and-password form and pending/error presentation. |
| [`src/client/AccountSeat.tsx`](src/client/AccountSeat.tsx) | Redacted identity, service address, and logout menu. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Ontology Auth Controller](../../api/ontology-auth-controller/README.md) — Host token ownership and browser isolation.
- [UI Slots](../ui-slots/README.md) — root, brand, and account extension points.
- [Ontology login bundle](../../bundle/ontology-login/README.md) — Web profile installation.

-----

<a id="model-experience"></a>
## Model Experience

None, as browser authentication presentation adds no model context or tools.

#### KV Cache effect

None; the plugin changes only browser-visible Slot occupants.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package targets the Web Client and requires the root, sidebar, locale, Remote, and Workspace UI services.
- Embedded login requires the iframe navigation to preserve the parent origin in `document.referrer`; a `no-referrer` policy disables the handoff and leaves the session-transfer page waiting.
- Modeling mode uses the parent page's selected Project; changing Projects requires a fresh iframe and handoff.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The generated Remote codec validates responses, and the Host controller owns token secrecy.
