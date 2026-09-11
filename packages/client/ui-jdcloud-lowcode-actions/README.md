---
description: "Web picker for selecting one current-tenant JDCloud form or workflow with a data-write permission before starting a conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions

English | [中文](README.zh.md)

## Summary

Use this package to start a Web conversation with one writable JDCloud low-code function already identified. It shows current-tenant forms and workflows that carry `addData`, `editData`, or `deleteData`, then inserts the selected function as an atomic `@` tag. The panel closes immediately after one selection and returns if the tag is removed. Before submission, the Host reloads the menu and rejects a stale tenant or permission instead of trusting browser state.

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

Mount this plugin beside the JDCloud authentication controller, Session Controller Client, Conversation UI, and input-trigger UI. The optional [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.md) bundle provides the complete composition.

```yaml
- name: '@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions'
```

The picker appears only for a blank top-level Session with at least one writable type `3` form or type `4` workflow. Clicking a card inserts one structured tag at the beginning of the draft and hides the complete picker. Removing that tag makes the picker available again.

This plugin accepts no configuration fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser reads a redacted menu projection through `jdcloudAuth.writableMenus()`. The plugin owns one `conversation.input.dock` entry and one input-reference codec. The dock inserts a reference containing only the current tenant id, menu id, and display label. The codec calls the Host again during submission, requires the same tenant and menu, and serializes the Host-confirmed name, path, type, and write permissions into the user message.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the Host authorization source, structured tags, and the low-code tools that consume the selected function.

- [JDCloud Auth Controller](../../api/jdcloud-auth-controller/README.md) — authenticated current-user projection and token ownership.
- [ui-input-trigger](../ui-input-trigger/README.md) — structured reference registration and submission serialization.
- [JDCloud low-code tools](../../jdcloud/tool-jdcloud-lowcode/README.md) — Host-authorized data operations.
- [Writable low-code function picker decision](../../../.agents/notes/implemented/feature/2026-09-10-jdcloud-writable-function-picker.md) — single-selection and revalidation tradeoffs.

-----

<a id="model-experience"></a>
## Model Experience

### Selected function reference

#### What the model sees

A selected tag adds one plugin-owned text block to the submitted user message. The block identifies the Host-confirmed `menuId`, full name, path, form or workflow type, and supported write permissions, and marks its labels as untrusted data. Merely viewing the picker has no model effect.

#### Token effect

One selected function adds one bounded JSON object to the submitted user-message suffix. The object size depends on the selected function's labels and permission list, not on the complete current-user response.

#### KV Cache effect

One selection changes only the new user-message suffix. Earlier Session history and the system-message prefix remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits keep the picker aligned with the current tenant and mutation permissions.

- **One function per draft** — the panel hides while its function tag exists; selecting several functions requires separate conversations.
- **Write permissions only** — query-only menus without `addData`, `editData`, or `deleteData` do not appear in this picker.
- **Unavailable data stays hidden** — authentication failure, current-user failure, or an empty writable-menu result produces no panel; the login plugin owns authentication recovery.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The browser tag is advisory input; the submission codec and low-code tools independently recheck Host-owned tenant and permission state.
