---
description: "The Ontology package group: authorized Runtime discovery, Object reads, Link traversal, and prepared Action execution for model-facing agents."
kind: "package-group"
---

# ontology/ — model-facing Ontology Runtime access

English | [中文](README.zh.md)

## Summary

The `ontology/` group lets an agent discover only the Ontology Projects, Object Types, Links, and Actions authorized for the current browser login. Its tools use stable published ids, validate every Runtime response, bound record pages, and send writes back through prepared Action invocations instead of accessing business databases. The authentication controller owns tokens; this group owns the model-facing operations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group currently contains one stable tool suite.

| Package | Role |
|---|---|
| [`tool-ontology`](tool-ontology/README.md) | Discovers authorized published ids, reads Objects and Links, and prepares or executes Actions through Ontology Runtime. |

<a id="related-documentation"></a>
## Related documentation

- [Ontology Auth Controller](../api/ontology-auth-controller/README.md) — browser-scoped tokens and authenticated Runtime transport.
- [Ontology login bundle](../bundle/ontology-login/README.md) — Web-profile composition that installs authentication, tools, and login UI.
- [Tools subsystem](../../docs/subsystems/tools.md) — tool registration, execution, logging, and approval integration shared by the Ontology tools.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-ontology) — exact model-visible tool schemas.

<a id="dev-note"></a>
## Dev Note

None.
