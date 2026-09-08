---
description: "JDCloud 包组：面向浏览该集成的用户和维护者，提供每个 Prompt 的低代码能力快照与 Host 强制执行的操作。"
kind: "package-group"
---

# jdcloud/ — 低代码对话集成

[English](README.md) | 中文

## 概述

jdcloud 组让当前租户的低代码表单和流程可用于对话。其工具插件会为每个用户 Prompt 注入仅包含 type 3 或 4 菜单项的能力快照。它还提供由 Host 执行时强制校验当前权限的低代码数据工具。本页负责映射该组；API 包负责认证与 Token 存储。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`tool-jdcloud-lowcode`](tool-jdcloud-lowcode/README.zh.md) | 为每个用户 Prompt 注入 type 3/4 能力快照，并提供由 Host 强制校验的低代码数据工具 |

-----

<a id="related-documentation"></a>
## 相关文档

- [JDCloud 认证 controller](../api/jdcloud-auth-controller/README.zh.md)——负责已登录账号、当前租户、服务地址和 Token。
- [JDCloud Web bundle](../bundle/jdcloud-login/README.zh.md)——组合认证、浏览器账号控制与低代码工具包。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
