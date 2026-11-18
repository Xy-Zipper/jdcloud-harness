---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-ontology-project-context

[English](2026-11-17-ontology-project-context.md) | 中文

## 概述

增加仅用于归属的 ontology-project 来源，用于记录业务 Project 快照。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有消息保留原有字段和含义，新读取方仍可读取已有来源。依据声明的归属策略，不包含 Ontology 生产者的读取方会保留未知来源及其 JSON 元数据，并将记录的文本作为普通上下文处理。该来源不授予权限，也不要求特殊回放解释。Session 格式保持 V4。

<a id="verification"></a>
## 验证

Ontology Host 和浏览器桥的 28 项定向测试通过，覆盖同一对话内注入最新 Project、Runtime 上下文交接、Token 刷新和原有建模行为。包内消息快照记录了两次所选 Project 及完整模型文本。

<a id="dev-note"></a>
## 开发备注

无。
