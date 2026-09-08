# Agent Note: JDCloud 低代码对话工具与 Host 授权

Status: implemented

[English](2026-09-07-jdcloud-low-code-conversation-tools.md) | 中文

## 问题

JDCloud 浏览器 Prompt 准入会验证已存储的登录信息，但仅靠该检查不能告诉模型当前租户开放了哪些表单和流程。通用低代码工具可能接受猜测的菜单 id 或模型传入的权限，从而让其他调用方尝试 `/api/oauth/currentUser` 未授权的操作。服务地址和 Token 必须由 Host 持有，而建表需要更强的 `systemAdministrator` 授权，尽管其上游操作跨越多个请求。

## 决策

`@deepseek-ai/dsh-tool-jdcloud-lowcode` 插件为每个通过准入的浏览器用户 Prompt 推导一份授权快照，并在完整轮次（Turn）中使用该快照：

- 认证控制器在 Session 投递前检查 `/api/system/corp/getCorpList`。低代码插件随后通过控制器的 Host 认证请求方法调用 `/api/oauth/currentUser`，因此服务地址和 Token 不会进入浏览器状态、工具参数或模型上下文。
- 插件递归筛选 `menuList`，仅保留 type `3` 表单和 type `4` 流程。其持久化模型消息只包含当前租户标识、`systemAdministrator`、菜单 id、名称、路径、类型和 `agentPermissions`；其余 current-user 响应不会进入消息。
- 工具执行要求当前开放轮次的快照、Host 本地当前租户 id 与快照一致，并要求每个请求的菜单 id 都存在于其中。租户不匹配时会在发起任何 JDCloud 网络请求前返回 `JDCLOUD_LOWCODE_TENANT_CHANGED`。读取操作只要求菜单可见。`jdcloud_lowcode_create`、`jdcloud_lowcode_update` 和 `jdcloud_lowcode_delete` 分别要求 `addData`、`editData` 和 `deleteData`；缺失或为空的 `agentPermissions` 列表不授予任何写操作。
- `jdcloud_lowcode_create_table` 要求 `systemAdministrator === true` 和明确的授权对象 id。它通过三个有序上游请求创建菜单、写入可视化 schema 并分配权限。后续步骤失败时会报告已创建的菜单 id，而不会在没有事务的情况下删除先前资源。
- 其余工具用于描述字段、查询记录和读取单条记录。type `4` 创建操作会提交流程任务；插件不公开审批、退回或驳回操作，因为三项写权限并不授权这些决定。
- JDCloud 业务码 `600`、`601` 和 `602` 会通过认证控制器清除已存储登录，并使操作以需要认证失败。其他业务错误或传输失败会保留登录。

## 备选方案

- **复用完整的外部 `@jdcloud/api` 包。** harness 只需要少量由 Host 持有的请求及不同的授权时点，复制其包结构会引入无关的浏览器假设和 API 表面。
- **仅在模型选择工具后获取能力。** 模型将不得不猜测菜单名称和 id，而影响其决策的能力信息也不会成为持久化 Session 输入。
- **公开完整的 current-user 响应。** 完整资料和菜单数据会增加模型 token，并暴露对 type `3` 或 type `4` 操作没有帮助的字段。
- **把提示词指导或工具 schema 当作授权。** 两者都是面向模型的描述，其他执行器调用方可以绕过；发送每个请求的 Host 操作会执行权限校验。
- **自动回滚部分创建的表。** 上游序列没有事务，在后续失败状态不确定时删除先前资源可能破坏服务端已经接受的资源；该包会报告部分创建状态，以便显式恢复。

## 后果

- 每个通过准入的浏览器 Prompt 都会在租户列表准入请求之后增加一次 current-user 请求。同一轮次中的工具续步复用已记录快照，不会重复发现能力。
- 模型只看到当前响应开放的表单和流程。切换租户会使该快照失效，直到下一次通过准入的浏览器 Prompt；轮次中发生的其他权限变更也会在该 Prompt 生效。
- 读取访问与每项写授权保持独立。菜单可见性绝不意味着新增、编辑、删除或建表权限。
- 后续请求失败时，建表可能留下菜单或 schema；运维人员可用返回的菜单 id 检查并修复该部分资源。
- 该包明确放弃流程审批操作和任意低代码 API 访问。包 README 负责说明面向使用方的行为与限制。
