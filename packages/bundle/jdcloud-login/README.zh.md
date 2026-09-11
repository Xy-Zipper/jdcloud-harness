---
description: "安装 JDCloud 认证、账号控制、低代码对话工具与 Web 品牌的可选 Web profile patch layer。"
kind: "package-bundle"
---

# dsh-jdcloud-login

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-jdcloud-login` 是面向 Web profile 的可选纯 patch bundle。它把 JDCloud Host 认证 controller、浏览器登录页、侧边栏账号摘要、可写功能选择器、低代码对话工具和 JDCloud Harness Web 品牌作为一个可部署 layer 安装。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将 bundle 添加到 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-jdcloud-login
```

可在进程环境变量或根 `.env` 中设置初始服务地址：

```dotenv
JDCLOUD_DEFAULT_BASE_URL=https://example.com
```

`JDCLOUD_DEFAULT_BASE_URL` 是账号密码登录的初始地址。Token 中转链接可以传入任意语法合法的绝对 HTTP(S) 服务地址；Host 不使用白名单，并会把传入的 Token 发送到该目的地。登录成功后，规范化服务地址、Token、账号、当前租户和可用租户列表会保存在 Host credentials provider 中。Web Client 会在侧边栏显示账号和租户；账号菜单会标记当前租户，在不返回登录页的情况下切换全部可用租户，并提供“退出登录”。

对于空白新对话，可写功能 row 会展示至少拥有一项数据写权限的 type `3` 表单与 type `4` 流程。点击一次会插入一个结构化功能标签并关闭面板；删除标签后面板恢复。对于每个已提交用户 Prompt，低代码工具 row 会注入能力快照，并提供由 Host 执行时强制校验当前权限的数据工具。

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions` 和 `@deepseek-ai/dsh-tool-jdcloud-lowcode` 间接影响，这两个包负责所选功能消息内容、能力快照与低代码工具 schema。

#### KV Cache 影响

bundle 本身不增加请求前缀；插入的选择器和低代码工具包负责用户消息、快照与工具 schema 的变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 该 layer 面向 Web profile，因为其 Client 插件依赖 Web root slot 与 API transport。
- 删除 bundle 不会删除其自有 credential record。

<a id="dev-note"></a>
### 开发备注

无。

**运行时不变式：** 不发布伴生入口。Loader 校验四个插入的 package row，各 package 负责自身运行时检查。
