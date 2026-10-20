---
description: "面向外部项目的 Token 鉴权 HTTP 与 SSE API，覆盖账号 Skill、工作区、文件和 Session 对话。"
kind: "package-reference"
---

# 外部 API

[English](README.md) | 中文

## 摘要

`@deepseek-ai/dsh-api-external` 提供固定的 `/api/external/v1/*` 路由。JDCloud 部署使用低代码原始 Token 与 `X-Tenant-Id`；Ontology 部署使用 Runtime Access Token 与 `X-Project-Id`。每次请求都由当前认证 Controller 校验，再复用现有 Skill、Workspace、文件和 Session 服务。

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/external/v1/skills` | 查询个人与内置 Skill。 |
| `POST` | `/api/external/v1/skills/upload` | 上传完整的 `personal` 或 `built-in` Skill 文件夹。 |
| `POST` | `/api/external/v1/skills/delete` | 删除有权限管理的个人或内置 Skill。 |
| `GET` | `/api/external/v1/workspaces` | 查询可见工作区。 |
| `POST` | `/api/external/v1/workspaces/create` | 创建或复用一个子目录和工作区。 |
| `GET` | `/api/external/v1/workspaces/files` | 查询工作区目录内容。 |
| `POST` | `/api/external/v1/chat` | 创建或继续 Session，并返回 SSE 事件。 |

所有请求都携带 `Authorization: Bearer <token>`。JDCloud 只接受低代码 Token 与 `X-Tenant-Id`；Ontology 只接受 Go Runtime Access Token 与 `X-Project-Id`。两个范围 Header 不是别名，当前部署会拒绝另一种 Header。对话请求体包含 `message`，可选的 `sessionId`，新建 Session 时使用的 `workspaceId`，以及可选的 `skillNames`。SSE 会发送 `session`、`snapshot`、`event`、`assistant`、`done` 和 `error`。模型提供 reasoning 字段时会原样包含在 `assistant` 实时块中；接口不会生成或暴露隐藏推理。

## 模型体验

### 已选 Skill

#### 模型看到的内容

当 `skillNames` 非空时，API 提交的日志用户消息先包含一行以空格分隔的 `/<skill-name>` 调用标记，再换行追加调用方的 `message`。Session Controller 与 Skill runtime 会按现有规则解析这些调用标记。

#### Token 影响

每个已选 Skill 都会向请求上下文添加其调用文本和 Skill runtime 解析出的指令。指令长度由对应 Skill 文件决定。

#### KV Cache 影响

选择、移除或调整 Skill 顺序会改变有日志记录的用户消息与解析出的指令，因此受影响请求不会保留其他条件相同但未选择 Skill 的前缀。

## 已知限制与后续事项

- 路由不主动添加浏览器 CORS 策略；浏览器项目应使用同源部署或服务端代理。
- 当前工作区文件接口只提供目录列表，不提供文件内容下载。

<a id="dev-note"></a>
### 开发说明

无。

**运行时不变量：** 任何业务服务执行前，当前认证 Controller 都会校验原始平台 Token 与请求的租户或项目。
