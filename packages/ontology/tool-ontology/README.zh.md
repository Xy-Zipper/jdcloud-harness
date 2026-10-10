---
description: "用于受权 Project 发现、有界 Object 查询、Link 遍历与预备 Action 执行的模型侧 Ontology Runtime 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ontology

[English](README.md) | 中文

## 概述

当 agent 必须通过已发布 Ontology 定义查看和更改业务数据时，使用 `dsh-tool-ontology`。八个稳定工具负责发现受权 id、描述 Object、执行有界记录读取与 Link 遍历，并预备后再执行 Action。每次调用都使用当前浏览器登录，并让 Runtime 强制校验当前 Project 与 Action 授权；本包不保存 Token、能力缓存、数据源密钥或业务记录。

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

在 `dsh-api-ontology-auth-controller`、`dsh-system-prompt` 与 `dsh-tools` 之后挂载本包：

```yaml
- name: '@deepseek-ai/dsh-tool-ontology'
```

本包没有配置字段。Runtime 地址、HTTPS 策略、截止时间与浏览器凭证属于鉴权 controller。

### 操作顺序

1. 调用 `ontology_list_projects`，再把一个返回的 `project_id` 传给后续发现和读取工具。
2. 在使用 Property、Link 或 Action id 前调用 `ontology_list_objects` 与 `ontology_describe_object`。
3. 使用已发布 Action 参数调用 `ontology_prepare_action`；保留其不可变 `invocationId` 与预览。
4. 只使用该 invocation id 调用 `ontology_execute_action`。工具会重新读取 Invocation，在需要确认时展示 Runtime 摘要，并仅在获得一次性批准后发送写请求。只有 Runtime 返回 `status: succeeded` 后才能认为写入成功。

查询与遍历分页默认返回 20 条记录，并拒绝超过 100 的 `page_size`。等值过滤使用 Object 详情中的 Property id，而不是源列名。Host 生成预备幂等键；执行不接受替换参数。用户拒绝时不会发出执行请求；顺序重试会重新读取 Invocation，而不是复用早先的预览。

### 失败与恢复

本包会在向模型返回前校验每个 Runtime JSON 响应。非法参数在发出请求前失败；鉴权、授权、传输、过时 Invocation 与响应校验失败会成为工具错误，且不会产生部分业务结果。Runtime 会在执行时重新校验授权，因此确认等待期间发生的权限变化会显示为执行错误。Project 发布或权限变化后应重新发现 id，而不是复用早先结果。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

每个注册项构造一个固定 `/api/runtime/` 请求，并把 Bearer Token 委托给仅 Host 可见的鉴权 controller。Controller 在每次调用前重新校验浏览器登录；本包刻意不保留 Project manifest 或授权缓存。执行 gate 会在批准前立即读取服务端拥有的 Invocation，拒绝 `prepared` 以外的所有状态，并使用共享 approval 服务，让现有 Web 面板提供确认、拒绝与防重复点击。Runtime 负责最终原子占用、授权复检、写入与审计记录。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Prompt 指引、八个工具 schema、固定 Runtime 请求、Action approval gate、分页与幂等键。 |
| [`src/runtime.ts`](src/runtime.ts) | Runtime 响应校验、Invocation 状态检查与有界结果投影。 |
| [`src/types.ts`](src/types.ts) | 品牌化已发布 id 与模型结果类型。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ontology)——模型看到的精确参数 schema。
- [Ontology Auth Controller](../../api/ontology-auth-controller/README.zh.md)——按浏览器隔离的登录与仅 Host 可见的 Runtime 传输。
- [Ontology 登录 bundle](../../bundle/ontology-login/README.zh.md)——完整 Web profile layer。
- [Ontology 包组](../README.zh.md)——本能力系列的归属映射。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

本包增加一段固定的发现与 Action 顺序说明。

##### Ontology 指引

```markdown
Use Ontology tools only with ids returned by discovery. List Projects before selecting one, list and describe Objects before querying their Property ids or Link ids, and never guess ids. Prepare every Action before execution. Execute only the invocation_id returned by preparation; do not claim a write succeeded until ontology_execute_action returns status succeeded.
```

#### Token 影响

插件挂载期间，每个请求都包含一个固定的简短区段。

#### KV Cache 影响

插件、工具可见性与指引文本不变时保持前缀稳定。

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`ontology_list_projects`、`ontology_list_objects`、`ontology_describe_object`、`ontology_query_objects`、`ontology_get_object`、`ontology_traverse_link`、`ontology_prepare_action` 与 `ontology_execute_action` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ontology)。稳定 id 与有界分页是显式参数；Runtime Token、数据源凭证、表名与原始写表达式不会出现。

#### Token 影响

八个固定 schema 在可见时随每个请求发送。

#### KV Cache 影响

工具定义与可见性不变时保持前缀稳定。

### 工具结果

#### 模型看到的内容

每个成功调用返回有界 JSON。发现返回已发布 id 与标签；读取返回以 Property id 为键的已校验记录；预备返回 invocation id、过期时间、确认要求、摘要与受影响 Object。在确认执行前，用户会看到 Runtime 摘要、Action 与 Project id 以及有界的受影响 Object 列表；拒绝会返回工具错误且不执行。执行只返回成功的 invocation 及其 Runtime 结果。工具失败会返回错误，而不是未经校验的 Runtime 字段。

#### Token 影响

结果随数据变化，并在压缩前保留于已记录工具历史中；记录列表受请求的分页大小限制，最多 100 条。

#### KV Cache 影响

追加式调用与结果内容位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Web 请求身份**——调用需要携带有效 Ontology 登录的浏览器请求；没有该请求本地身份的后台执行会被拒绝。
- **仅等值过滤**——Object 查询目前公开 Property id 等值过滤，不支持任意表达式、排序、聚合或 join。
- **显式选择 Project**——每个 Project 范围调用都需要 `project_id`；本包不维护可变的当前 Project。
- **Runtime 拥有写入**——受支持 Action 操作取决于已发布 Ontology Runtime 及其数据源 provider；Harness 不能绕过只读数据源或 provider 不支持的操作。
- **Approval 策略**——共享 approval 策略为 `never` 的会话会拒绝需要确认的 Action，而不会绕过 Runtime 要求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每次调用都会在返回模型可见 JSON 前校验当前浏览器登录与 Runtime 响应。
