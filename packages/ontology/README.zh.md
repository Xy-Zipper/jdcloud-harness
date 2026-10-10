---
description: "Ontology 包组：为模型侧 agent 提供受权 Runtime 发现、Object 读取、Link 遍历与预备 Action 执行。"
kind: "package-group"
---

# ontology/ — 模型侧 Ontology Runtime 访问

[English](README.md) | 中文

## 概述

`ontology/` 组让 agent 只能发现当前浏览器登录有权访问的 Ontology Project、Object Type、Link 与 Action。其工具使用稳定的已发布 id、校验每个 Runtime 响应、限制记录分页，并通过预备 Action Invocation 把写入交回 Runtime，而不直接访问业务数据库。鉴权 controller 负责 Token，本组负责模型侧操作。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本组目前包含一套稳定工具。

| 包 | 职责 |
|---|---|
| [`tool-ontology`](tool-ontology/README.zh.md) | 发现受权已发布 id、读取 Object 与 Link，并通过 Ontology Runtime 预备或执行 Action。 |

<a id="related-documentation"></a>
## 相关文档

- [Ontology Auth Controller](../api/ontology-auth-controller/README.zh.md)——按浏览器隔离的 Token 与已鉴权 Runtime 传输。
- [Ontology 登录 bundle](../bundle/ontology-login/README.zh.md)——安装鉴权、工具与登录 UI 的 Web profile 组合。
- [Tools 子系统](../../docs/subsystems/tools.zh.md)——Ontology 工具共用的工具注册、执行、日志与审批集成。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ontology)——模型可见工具的精确 schema。

<a id="dev-note"></a>
## 开发备注

无。
