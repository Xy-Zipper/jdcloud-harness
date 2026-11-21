---
description: "安装按浏览器隔离的 Ontology Runtime 鉴权、模型工具、登录 UI、账号控制与品牌的可选 Web profile layer。"
kind: "package-bundle"
---

# dsh-ontology-login

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-ontology-login` 为 Web profile 添加按浏览器隔离的 Ontology Runtime 登录、受权 Object 与 Link 读取、经确认的预备 Action 执行、账号范围 Workspace 浏览以及账号呈现。它会关闭共享 Harness 启动鉴权、启用标签页级 browser Bearer session，并安装 Ontology controller、模型工具、登录 UI 与应用内目录选择器。Ontology 会成为该 profile 的应用身份与授权层。

该 bundle 同时安装外部 API。这些路由接受 Go Runtime Access Token 与 `X-Project-Id`，校验用户可见该 Project，并按 Project 与用户隔离个人 Skill、Workspace 和 Session，不会创建浏览器登录状态。

Go 文件助手调用 `POST /api/internal/file-assistant/answer`，携带 `Authorization: Bearer <FILE_ASSISTANT_SERVICE_TOKEN>` 和 JSON 请求体 `{"question":"…","sources":[{"id":"S1","fileName":"…","text":"…"}]}`。两个服务端设置相同的私有令牌。Go 负责文件访问授权，在 512 KiB 以内发送至多八个片段。响应包含 `answer` 和来自本次请求的唯一 `sourceIds`。空数组表示资料不足。未配置服务令牌时返回 503，令牌错误时返回 401，模型失败或引用无效时返回 502。

传入非空片段组时，使用 `task: "qa"` 生成 `questions`，或使用 `task: "extract"` 抽取 `entities` 和 `relations`。请求包含 `task` 和 `sources`。每条结果携带当前批次的 `sourceIds`，关系两端引用同一响应中的实体名称。

数据管道字段生成向同一地址发送 `{"task":"pipeline","prompt":"…","fields":{"content":"…"},"outputType":"entities"}`。响应的 `value` 随类型而变化，`entities` 为实体名数组，`text` 为字符串，`json` 为对象。提示词包含所选输出类型的示例，符合类型的结果可以包在一个 JSON 代码块内。模型调用仅使用所选字段和提示词。

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

要将 Web profile 从 JDCloud 切换到 Ontology，运行 `pnpm run plugins:ontology`。脚本直接读取 profile 的依赖声明，因此切换分支后即使 JDCloud 的本地包链接失效，也能先将其移除。未声明的 JDCloud 插件会跳过，脚本可以重复执行。

启动 profile 前设置必填 Runtime 地址：

```dotenv
ONTOLOGY_BASE_URL=https://ontology.example.com
ONTOLOGY_REQUEST_TIMEOUT_MS=15000
```

本地开发可以显式设置 `ONTOLOGY_BASE_URL=http://127.0.0.1:8080`，并同时设置 `ONTOLOGY_ALLOW_INSECURE_LOOPBACK=true`。非 loopback HTTP 始终会被拒绝。

用户 Workspace 与账号管理的 skill 默认保存在 `$DSH_HOME/account-workspaces`。服务器只需持久化 `$DSH_HOME`；只有需要把账号文件放入独立持久卷时，才设置 `ONTOLOGY_USER_WORKSPACE_DIR=/workspace/ontology-users`。

### 获得的能力

侧栏顶部使用 Ontology 账号控件，底部直接显示设置按钮。该 bundle 会禁用官方账号界面及其通知。

该 layer 禁用 `authentication-token`，并把 `@deepseek-ai/dsh-client-connection/browser-session` 安装为 Connection 认证 Provider。Client 把不透明 Host 身份保存在当前标签页的 `sessionStorage`，通过 Bearer header 认证同源请求，并为每次 WebSocket 连接取得短期单次 ticket。该 layer 还会用应用内目录浏览器替换自适应操作系统选择器；选择器打开后位于已登录用户的 Workspace 根目录，只列出 Host 校验通过的后代目录，并允许在其中创建子文件夹。它还会插入 `ontology-auth-controller`、`tool-ontology` 与 `ui-ontology-login`，并关闭首次运行的模型凭证弹窗。需要确认的 Action 会复用 Web profile 的共享 approval 面板，而 Ontology Runtime 仍然拥有 Project 访问、当前 Invocation 状态、原子执行与写入授权。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 拥有完整的可选 layer。部署必须提供 `ONTOLOGY_BASE_URL`；patch 会把超时、loopback 策略与可选的 `ONTOLOGY_USER_WORKSPACE_DIR` 覆盖值传给 Host controller，固定使用 browse 目录选择器组合，并允许更上层的 profile 或命令行 patch 替换每个 row。[`src/index.ts`](src/index.ts) 是 package 加载所需的空 bundle 载体。

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

通过 `@deepseek-ai/dsh-tool-ontology` 间接影响，该包负责 Ontology 指引、十三个工具 schema 与已校验 Runtime 结果。

每次文件问答使用当前默认模型，根据传入片段作答。输出上限为 4,096 个 token，超时为 60 秒。模型只收到依据文件作答的指令和本次请求的数据，调用不携带工具或对话历史。

#### KV Cache 影响

文件助手在多次调用中复用依据文件作答的指令。插入的工具包负责交互式 Session 的 Prompt 与工具 schema。

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

**运行时不变式：** Loader 在 Ontology profile 中将文件助手加载为独立的 Host 插件。
