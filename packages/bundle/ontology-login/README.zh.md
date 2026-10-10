---
description: "安装按浏览器隔离的 Ontology Runtime 鉴权、模型工具、登录 UI、账号控制与品牌的可选 Web profile layer。"
kind: "package-bundle"
---

# dsh-ontology-login

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-ontology-login` 为 Web profile 添加按浏览器隔离的 Ontology Runtime 登录、受权 Object 与 Link 读取、经确认的预备 Action 执行以及账号呈现。它会关闭共享 Harness 启动鉴权、启用签名 browser-session cookie，并安装 Ontology controller、模型工具与登录 UI。Ontology 会成为该 profile 的应用身份与授权层。

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

### 安装到 profile

在仓库根目录中向 Web profile 添加或移除此可选 layer：

```text
pnpm dsh plugin --profile web add ./packages/bundle/ontology-login
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-ontology-login
```

启动 profile 前设置必填 Runtime 地址：

```dotenv
ONTOLOGY_BASE_URL=https://ontology.example.com
ONTOLOGY_REQUEST_TIMEOUT_MS=15000
ONTOLOGY_USER_WORKSPACE_DIR=/workspace/ontology-users
```

本地开发可以显式设置 `ONTOLOGY_BASE_URL=http://127.0.0.1:8080`，并同时设置 `ONTOLOGY_ALLOW_INSECURE_LOOPBACK=true`。非 loopback HTTP 始终会被拒绝。

### 获得的能力

该 layer 把 Connection row 替换为 `browserAuthentication: false` 与 `browserSession: true`，插入 `ontology-auth-controller`、`tool-ontology` 与 `ui-ontology-login`，并关闭首次运行的模型凭证弹窗。需要确认的 Action 会复用 Web profile 的共享 approval 面板，而 Ontology Runtime 仍然拥有 Project 访问、当前 Invocation 状态、原子执行与写入授权。配置的用户 Workspace 目录会按稳定 Ontology 用户隔离文件。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 拥有完整的可选 layer。部署必须提供 `ONTOLOGY_BASE_URL`；patch 会把超时、loopback 策略与 `ONTOLOGY_USER_WORKSPACE_DIR` 传给 Host controller，并允许更上层的 profile 或命令行 patch 替换每个 row。[`src/index.ts`](src/index.ts) 是 package 加载所需的空 bundle 载体。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Profile 与组合包](../../../docs/architecture.zh.md)——layer 顺序与覆盖方式。
- [Ontology Auth Controller](../../api/ontology-auth-controller/README.zh.md)——Token 生命周期与身份 Scope。
- [Ontology 工具](../../ontology/tool-ontology/README.zh.md)——Project 发现、Object 读取、Link 遍历与 Action。
- [Ontology Login UI](../../client/ui-ontology-login/README.zh.md)——浏览器可见行为。
- [Bundle 组映射](../README.zh.md)——其他内置 profile layer。

-----

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-tool-ontology` 间接影响，该包负责 Ontology 指引、八个工具 schema 与已校验 Runtime 结果。

#### KV Cache 影响

bundle 本身不增加请求前缀；插入的工具包负责 Prompt 与工具 schema 变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 该 layer 面向 Web profile，因为独立浏览器身份与登录根页面依赖 Web Connection 和 Slot 服务。
- 需要确认的 Action 依赖 Web profile 的共享 approval 服务；approval 策略为 `never` 的会话会直接拒绝且不弹出提示。
- 移除该 layer 不会删除其 owner 自定义 credential record，也不会撤销未显式注销的 Runtime Session。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Loader 校验三个插入的 package row，各 package 校验自身状态。
