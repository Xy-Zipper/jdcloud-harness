---
description: "Web login gate, Ontology branding, and a redacted sidebar identity for browser-scoped Runtime authentication."
kind: "package-reference"
---

# Ontology Login UI

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-ontology-login` presents an account-and-password gate until the current browser has an Ontology Runtime login. After login it shows the redacted identity, account type, fixed service address, and a sign-out action in the sidebar. It mounts the generated Ontology Remote namespace and never receives either Runtime Token.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry has no route behavior. The Client entry mounts the generated Remote contribution and installs all Slot occupants in the same lifecycle. Pure React components receive redacted state and registration-owned callbacks.

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Remote status lifecycle, root gate, account seat, and brand Slot registrations. |
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
- The page does not select a Project; Project discovery belongs to the later Ontology tool and context workflow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The generated Remote codec validates responses, and the Host controller owns token secrecy.
