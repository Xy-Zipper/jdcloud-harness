---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-16-jdcloud-master-message-integration

[English](2026-11-16-jdcloud-master-message-integration.md) | 中文

## 概述

将 JDCloud 低代码消息来源接入 master 分支的完整消息联合类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

合并后的声明保留 jdcloud-lowcode kind、plugin 字符串与既有 ContextFormed 分支。用户消息、开发者消息、收件箱条目和标题模型请求的已记录含义不变。新读取器保留所有历史 JDCloud form；已理解该来源的旧读取器继续解释原有字段，通用来源消费者保留未知来源而不会把它作为用户命令执行。Session 编码与写入版本仍为 V4；此记录确认合并后的声明，不替换任何已提交的历史代际。

<a id="verification"></a>
## 验证

pnpm run build：全部 10 项检查通过。定向业务回归中的 JDCloud 认证、低代码与 bundle 测试通过；外部 API 和媒体复查通过 101 个测试。浏览器回归全部四个用例通过，覆盖租户控件、低代码选择、仅管理员可选模型，以及独立的设置按钮。

<a id="dev-note"></a>
## 开发备注

无。
