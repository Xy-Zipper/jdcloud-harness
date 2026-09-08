# Agent Note: 按请求投影沙箱升权 schema

Status: implemented

[English](2026-09-08-request-scoped-sandbox-escalation-schemas.md) | 中文

## 问题

使用沙箱的 shell 与文件系统工具会在每个模型请求中公开组合级的全部 `sandbox_permissions` 目标。已经运行于 `danger-full-access` 的会话、审批策略为 `never` 的会话或未组合审批服务的环境因此都会显示永远无法成功的参数。模型有时会把这些参数用于普通写入，严格执行校验会在命令或文件变更运行前拒绝调用。使用另一个非加宽目标重复调用后，请求的文件可能始终无法创建。

执行时的严格加宽检查是安全规则，必须保持故障关闭。缺陷是请求时能力与展示给模型的静态 schema 不一致，而不是拒绝行为本身。

## 决策

`ToolDefinition.modelSchema()` 可以在系统提示词组装期间投影按请求生效的描述与参数 schema。完整注册 schema 继续作为执行校验器，不带 agent 的目录检查继续保留该静态 schema。原生工具 schema 与生成的 PTC SDK 声明使用相同的请求投影。

使用沙箱的 Bash、PowerShell、`write` 与 `edit` 根据当前 agent 的会话投影升权参数。`read-only` 公开 `workspace-write` 和 `danger-full-access`，`workspace-write` 只公开 `danger-full-access`。当前模式为 `danger-full-access`、审批策略为 `never`、缺少审批服务或后端不施加限制时，这些字段不存在。`ApprovalService.policyOf()` 提供请求投影与审批执行共同使用的会话有效策略。

执行仍接受完整静态参数词汇，使持久化调用和显式注入的参数进入既有校验路径。`approveEscalation()` 会独立拒绝没有严格加宽的目标，空白或未配对的 justification 仍然无效。仅当同一请求存在可用的更宽模式时，拒绝结果才包含升权提示；即使升权不可用，PowerShell 仍保留受限语言和命名管道指导。

## 考虑过的替代方案

- **把相同模式的请求视为普通调用**——这会削弱严格加宽安全规则，并掩盖格式错误的模型输出，而不是修正公开的能力。
- **只依赖运行时上下文文案**——事故中已经包含不设置 `sandbox_permissions` 的明确指令；相互矛盾的 schema 仍提供更强的操作暗示并导致重复失败。
- **从所有 schema 中移除升权字段**——这会阻止 `read-only` 和 `workspace-write` 会话进行有效的单次审批。
- **按权限 preset 注册不同工具**——权限状态按会话生效且可在请求间改变，静态注册会复制工具实现并与执行策略发生漂移。

## 后果

模型请求只包含能够通过会话当前模式与审批门禁的升权选项。`danger-full-access` 下的普通操作不会再因为模型被引导去请求已有模式而失败，无人值守会话也不会再收到不可用的审批参数或提示。执行边界仍会对手工注入、陈旧或非加宽调用保持故障关闭。

沙箱模式或审批策略变化时，按请求 schema 可能改变模型提示词缓存前缀；这些变化本来就会改变请求运行时策略，因此必须可见。静态生成目录继续记录完整执行词汇，请求快照则验证有效子集。
