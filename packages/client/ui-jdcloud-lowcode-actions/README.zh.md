---
description: "在开始对话前选择一个拥有数据写权限的当前租户 JDCloud 表单或流程的 Web 选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions

[English](README.md) | 中文

## 概述

需要让 Web 对话在开始时明确一个可写 JDCloud 低代码功能时，可以使用本包。它展示当前租户中拥有 `addData`、`editData` 或 `deleteData` 的表单和流程，并把选中功能插入为原子 `@` 标签。选择一次后面板会立即关闭，删除标签后重新显示。提交前，Host 会重新加载菜单并拒绝陈旧的租户或权限，不会信任浏览器状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与 JDCloud 认证控制器、Session Controller Client、Conversation UI 和 input-trigger UI 一起挂载。可选的 [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.zh.md) bundle 提供完整组合。

```yaml
- name: '@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions'
```

选择器仅在空白顶层 Session 至少存在一个可写 type `3` 表单或 type `4` 流程时显示。点击卡片会在草稿开头插入一个结构化标签，并隐藏完整选择器。删除该标签后，选择器会重新可用。

本插件不接受配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器通过 `jdcloudAuth.writableMenus()` 读取脱敏菜单投影。本插件拥有一个 `conversation.input.dock` 条目和一个输入引用 codec。该 dock 插入仅含当前租户 id、菜单 id 与显示标签的引用。提交期间，codec 会再次调用 Host，要求租户和菜单保持一致，并把 Host 确认的名称、路径、类型与写权限序列化到用户消息中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面说明 Host 授权来源、结构化标签，以及使用所选功能的低代码工具。

- [JDCloud Auth Controller](../../api/jdcloud-auth-controller/README.zh.md)——已认证 current-user 投影与 Token 所有权。
- [ui-input-trigger](../ui-input-trigger/README.zh.md)——结构化引用注册与提交序列化。
- [JDCloud 低代码工具](../../jdcloud/tool-jdcloud-lowcode/README.zh.md)——由 Host 授权的数据操作。
- [可写低代码功能选择器决策](../../../.agents/notes/implemented/feature/2026-09-10-jdcloud-writable-function-picker.zh.md)——单选与重新校验的权衡。

-----

<a id="model-experience"></a>
## 模型体验

### 所选功能引用

#### 模型看到的内容

选中的标签会向提交的用户消息添加一个插件拥有的文本块。该文本块标识 Host 确认的 `menuId`、完整名称、路径、表单或流程类型及支持的写权限，并将其中标签声明为不可信数据。仅查看选择器不会影响模型。

#### Token 影响

一个所选功能会向已提交用户消息的后缀添加一个有界 JSON 对象。对象大小取决于所选功能的标签与权限列表，不取决于完整 current-user 响应。

#### KV Cache 影响

一次选择只会改变新用户消息的后缀。更早的 Session 历史与系统消息前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制使选择器与当前租户及修改权限保持一致。

- **每份草稿一个功能**——功能标签存在时面板保持隐藏；选择多个功能需要分别发起对话。
- **只展示写权限**——没有 `addData`、`editData` 或 `deleteData` 的仅查询菜单不会出现在该选择器中。
- **不可用数据保持隐藏**——认证失败、current-user 失败或可写菜单结果为空时不显示面板；认证恢复由登录插件负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。浏览器标签只是提示输入；提交 codec 和低代码工具会分别重新检查由 Host 持有的租户与权限状态。
