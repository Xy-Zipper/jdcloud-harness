---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-16-jdcloud-master-message-integration

English | [中文](2026-11-16-jdcloud-master-message-integration.zh.md)

## Summary

Integrates JDCloud low-code message attribution with the master branch's complete message unions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-jdcloud-master-message-integration
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "12cf9bbb6b1f8f547b6d80c7394aef0d95bdc0eeec0f5e17e16e500e1c8747da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "c253de0c277e0e48f18a0214c0e38cd7ba2dcc7711524674d871f9b107c9fd5c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "15f6e5fdb0bb5845a669c5a7117ec542a068a3e4aa811692ebd792fbe32f317b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "f262c747f1254e5f506ecb7b63cc88fd51f47f5071f63d3480bf6eacfa31d249"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The merged declaration retains the jdcloud-lowcode kind, plugin string, and existing ContextFormed alternatives. User and developer message contents, inbox entries, and title-model request messages keep their recorded meaning. New readers retain all historical JDCloud forms; older readers that already understand this attribution continue to interpret its existing fields, and generic source consumers preserve unknown attribution rather than executing it as a user command. The Session encoding and writer version remain V4; this record acknowledges the combined declarations without replacing any committed historical generation.

<a id="verification"></a>
## Verification

pnpm run build: all 10 gates passed. The targeted business regression run passed the JDCloud authentication, low-code, and bundle tests; the external API and media recheck passed 101 tests. The browser regression passed all four cases, covering tenant controls, low-code selection, administrator-only model selection, and the direct Settings button.

<a id="dev-note"></a>
## Dev Note

None.
