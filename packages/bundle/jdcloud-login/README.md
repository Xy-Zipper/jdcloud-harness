---
description: "Optional Web profile patch layer installing JDCloud authentication, account controls, low-code conversation tools, and Web branding."
kind: "package-bundle"
---

# dsh-jdcloud-login

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-jdcloud-login` is an optional patch-only bundle for the Web profile. It installs the JDCloud Host authentication controller, browser login page, sidebar account summary, writable-function picker, low-code conversation tools, and JDCloud Harness Web branding as one deployable layer.

The bundle also installs the external API. Those routes authenticate the raw JDCloud token against `JDCLOUD_DEFAULT_BASE_URL` and require the token's current tenant to match `X-Tenant-Id`; they do not reuse or mutate browser login state.

The bundle includes [Creation Studio media tools](../../jdcloud/creation-studio-media/README.md) in the Harness build and deployment. Provider keys belong on the Host; Creation Studio Skills remain separate account installations.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Add the bundle to a Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-jdcloud-login
```

Set the optional initial service address in the process environment or root `.env`:

```dotenv
JDCLOUD_DEFAULT_BASE_URL=https://example.com
JDCLOUD_IFRAME_PARENT_ORIGIN=https://portal.example
```

`JDCLOUD_DEFAULT_BASE_URL` is the initial account/password login address. A token-transfer link may supply any syntactically valid absolute HTTP(S) service address; the Host sends the supplied Token to that destination without an allowlist. A successful login stores its normalized service address, Token, account, current tenant, and available tenants in the Host credentials provider. The Web Client shows the account and tenant in the sidebar; its account menu marks the current tenant, switches among all available tenants without returning to login, and provides Sign out.

Leave `JDCLOUD_IFRAME_PARENT_ORIGIN` unset for the default window-open flow. It accepts the exact HTTP(S) origin of the page that embeds `/login/transfer`, without a path. Set it to `*` only when every site may embed the transfer page; this permits clickjacking by any site. The bundle uses Connection's Bearer browser-session transport, so a cross-site iframe does not depend on a third-party cookie and can operate over HTTP. Plaintext HTTP does not protect the bearer credential from network observation or interception. Changing this runtime variable requires a process or container restart, not a browser-asset rebuild.

Docker Compose deployments may set `JDCLOUD_PRODUCT_NAME` to choose the browser title, sidebar product name, PWA name, and model-visible Web branding; it defaults to `LSY-Agent` and requires an image rebuild because browser assets embed the title at build time.

This bundle disables Harness launch-token authentication and enables an authority-bound Bearer browser session. The Client stores its token in the current tab's `sessionStorage`, adds it to same-origin HTTP requests, and uses a short-lived single-use ticket for WebSocket upgrades. Login records are isolated per browser tab, while sessions and workspaces remain shared by the same JDCloud tenant and user. The bundle places each tenant-user's new files and personal Skills under `/workspace/jdcloud-users/<owner-hash>`; `JDCLOUD_USER_WORKSPACE_DIR` can override the persistent parent. Administrators manage built-in Skills under the parent's `.dsh/skills` directory, which every account can discover. Existing host-home directories are not migrated. Workspace selection uses the in-app directory browser, starts at the authorized account directory, and cannot navigate above it; Workspace registration, Session creation, and Skill mutations enforce the same directory, but terminal commands and absolute-path file reads remain unrestricted. The bundle disables the internal-testing notice and automatic first-run API-key dialog; the Models settings page and manual API-key entry remain available.

For a blank new conversation, the writable-function row shows type `3` forms and type `4` workflows carrying at least one data-write permission. One click inserts a single structured function tag and closes the panel; deleting the tag restores it. For each submitted user prompt, the low-code tool row injects a capability snapshot and provides data tools whose Host execution enforces the current permissions.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions` and `@deepseek-ai/dsh-tool-jdcloud-lowcode`, which own selected-function message content, the capability snapshot, and low-code tool schemas.

#### KV Cache effect

The bundle itself adds no request prefix; the inserted picker and low-code tool package own user-message, snapshot, and tool-schema changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This layer targets the Web profile because its Client plugin requires the Web root slot and API transport.
- Removing the bundle does not delete its owner-defined credential record.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** No companion is published. Loader validates all four inserted package rows, and each package owns its runtime checks.
