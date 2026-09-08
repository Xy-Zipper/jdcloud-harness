---
description: "The JDCloud package group: per-prompt low-code capability snapshots and Host-enforced operations for users and maintainers navigating the integration."
kind: "package-group"
---

# jdcloud/ — low-code conversation integration

English | [中文](README.zh.md)

## Summary

The jdcloud group makes the current tenant's low-code forms and workflows available during a conversation. For each user prompt, its tool plugin injects a capability snapshot containing menu entries of type 3 or 4. It also provides low-code data tools whose Host execution enforces the current permissions. This page maps the group; the API package owns authentication and Token storage.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`tool-jdcloud-lowcode`](tool-jdcloud-lowcode/README.md) | Injects type 3/4 capability snapshots for each user prompt and provides Host-enforced low-code data tools |

-----

<a id="related-documentation"></a>
## Related documentation

- [JDCloud authentication controller](../api/jdcloud-auth-controller/README.md) — owns the signed-in account, current tenant, service address, and Token.
- [JDCloud Web bundle](../bundle/jdcloud-login/README.md) — composes authentication, browser account controls, and the low-code tool package.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
