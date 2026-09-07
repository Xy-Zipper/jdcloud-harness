---
description: "Optional Web profile patch layer installing JDCloud authentication and its login page."
kind: "package-bundle"
---

# dsh-jdcloud-login

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-jdcloud-login` is an optional patch-only bundle for the Web profile. It installs the JDCloud Host authentication controller, browser login page, and sidebar account summary as one deployable layer.

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

The value is only an initial address. A successful login stores its normalized service address, Token, account, current tenant, and available tenants in the Host credentials provider. The Web Client shows the account and tenant in the sidebar; its account menu marks the current tenant, switches among all available tenants without returning to login, and provides Sign out.

<a id="model-experience"></a>
## Model Experience

None, as the bundle adds browser authentication policy before Session delivery.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- This layer targets the Web profile because its Client plugin requires the Web root slot and API transport.
- Removing the bundle does not delete its owner-defined credential record.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** No companion is published. Loader validates both inserted package rows, and each package owns its runtime checks.
