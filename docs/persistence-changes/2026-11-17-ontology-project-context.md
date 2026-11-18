---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-ontology-project-context

English | [中文](2026-11-17-ontology-project-context.zh.md)

## Summary

Adds the attribution-only ontology-project source for logged business Project snapshots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-ontology-project-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "a7e31e1cf925211c67290f069ef62b3e495c7b5232e889614ff8c0aec17fd705"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "9ae82fc9b85931d8ba3e91283f04865a2daf7bb96204c8453ab5d41f3bc4815f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "e6ba3c2a0a644962adbf0c9d4a237d3f174ffce132e56f213c0471a9519e2cff"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "f74ec6734769f52b08f3e94fffbb318e2a771ce740ba00ae537690dce611d54c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages retain their fields and meaning. New readers still read existing sources. Readers without the Ontology producer preserve the unknown source and its JSON metadata and derive the recorded text as ordinary context, under the declared attribution policy. The source grants no authority and requires no replay interpretation. Session format remains V4.

<a id="verification"></a>
## Verification

Focused Ontology Host and browser bridge tests passed: 28 tests, including latest Project injection in one conversation, runtime context handoff, token refresh, and unchanged modeling behavior. The owner-local message snapshot records both selected Projects and the complete model-facing text.

<a id="dev-note"></a>
## Dev Note

None.
