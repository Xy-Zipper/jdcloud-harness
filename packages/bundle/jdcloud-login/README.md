---
description: "Optional Web profile patch layer installing JDCloud authentication, account controls, low-code conversation tools, and Web branding."
kind: "package-bundle"
---

# dsh-jdcloud-login

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-jdcloud-login` is an optional patch-only bundle for the Web profile. It installs the JDCloud Host authentication controller, browser login page, sidebar account summary, low-code conversation tools, and JDCloud Harness Web branding as one deployable layer.

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
```

`JDCLOUD_DEFAULT_BASE_URL` is the initial account/password login address. A token-transfer link may supply any syntactically valid absolute HTTP(S) service address; the Host sends the supplied Token to that destination without an allowlist. A successful login stores its normalized service address, Token, account, current tenant, and available tenants in the Host credentials provider. The Web Client shows the account and tenant in the sidebar; its account menu marks the current tenant, switches among all available tenants without returning to login, and provides Sign out.

For each user prompt, the low-code row injects a capability snapshot limited to form and workflow menu entries (types 3 and 4). It also provides low-code data tools whose Host execution enforces the current permissions.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-jdcloud-lowcode`, which owns the capability snapshot and low-code tool schemas.

#### KV Cache effect

The bundle itself adds no request prefix; the inserted low-code package owns snapshot and tool-schema changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This layer targets the Web profile because its Client plugin requires the Web root slot and API transport.
- Removing the bundle does not delete its owner-defined credential record.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** No companion is published. Loader validates all three inserted package rows, and each package owns its runtime checks.
