---
description: "面向按浏览器隔离 Runtime 鉴权的 Web 登录门、Ontology 品牌与脱敏侧栏身份。"
kind: "package-reference"
---

# Ontology Login UI

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-client-ui-ontology-login` 在当前浏览器没有 Ontology Runtime 登录时显示账号密码登录门。登录后，它会在侧栏显示脱敏身份、账号类型、固定服务地址和退出操作。它自行挂载生成的 Ontology Remote namespace，且不会接收任一种 Runtime Token。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [`dsh-ontology-login`](../../bundle/ontology-login/README.zh.md) bundle 挂载此 Client 插件。服务地址由 Host controller 提供，因此页面只接受账号和密码。登录与注销会在切换可见身份前清除已选 Workspace 或 Session 视图。

插件注册本地化的中英文文案、Ontology 图结构标记、受保护的根页面和侧栏账号席位。Credential record 通知只刷新 `ontology-auth-controller` 拥有的 record。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

Host 入口没有路由行为。Client 入口挂载生成的 Remote contribution，并在同一生命周期中安装全部 Slot occupant。纯 React 组件只接收脱敏状态和注册方拥有的回调。

| 源码 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 状态生命周期、根登录门、账号席位与品牌 Slot 注册。 |
| [`src/client/LoginPage.tsx`](src/client/LoginPage.tsx) | 账号密码表单与等待、错误呈现。 |
| [`src/client/AccountSeat.tsx`](src/client/AccountSeat.tsx) | 脱敏身份、服务地址与注销菜单。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Ontology Auth Controller](../../api/ontology-auth-controller/README.zh.md)——Host Token 所有权与浏览器隔离。
- [UI Slots](../ui-slots/README.zh.md)——根、品牌与账号扩展点。
- [Ontology 登录 bundle](../../bundle/ontology-login/README.zh.md)——Web profile 安装方式。

-----

<a id="model-experience"></a>
## 模型体验

无，因为浏览器鉴权呈现不会增加模型上下文或工具。

#### KV Cache 影响

无；插件只改变浏览器可见的 Slot occupant。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 本包面向 Web Client，并依赖根、侧栏、locale、Remote 与 Workspace UI 服务。
- 页面不选择 Project；Project 发现属于后续 Ontology 工具与上下文工作流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。生成的 Remote codec 校验响应，Host controller 负责 Token 保密。
