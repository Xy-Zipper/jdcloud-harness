# Agent Note: Web 项目内 skill（技能）管理

Status: implemented

[English](2026-10-15-web-project-skill-management.md) | 中文

## 问题

Web 编辑器可以通过 `/name` 调用已知 skill，但用户只能间接发现名称，并且必须离开产品编辑项目文件才能添加 skill。这种方式排除了只使用图形界面的用户，也没有为浏览器发起的文件写入明确规定 Session、工作区、校验和冲突策略。

## 决策

Web 编辑器为普通 Session 在 `conversation.input.left` 中注册独立的 skill 按钮。可搜索面板读取与 `/` trigger 相同的 `skills/list` 目录，选择条目后插入既有的字面文本 `/name`。选择面板不引入第二套调用协议，也不通过草稿传输 skill 正文。

面板中的管理弹框可以根据引导字段创建 `SKILL.md`，也可以导入一份完整的 `SKILL.md`。按 Session 寻址的 `skills/create` Remote 负责校验与持久化。它校验发现流程所需的 frontmatter，要求 skill 保持允许用户调用，把 UTF-8 文档限制在 256 KiB 以内；Ontology 控制器存在时还会检查 Session 所有权与工作区包含关系，并通过文件系统的 `workspace-write` 策略写入。

安装后的 skill 位于 Session cwd 最近的含 `.git` 祖先目录下的 `.dsh/skills/<name>/SKILL.md`；没有该标记时，Session cwd 就是项目根目录。安装使用受保护的创建操作，绝不替换已存在的文件。目录继续只暴露元数据而不暴露指令正文；安装成功后仅更新当前 Session 的内存目录快照，使新条目可以立即选择。

## 曾考虑的替代方案

**把用户创建的 skill 存入数据库。** 不予采纳，因为现有 skill provider 发现的是项目文件，而项目内文件可以和使用它们的代码一起检查、版本化和迁移。数据库需要第二套 provider 与同步策略，却不能改善首个受支持工作流。

**让浏览器直接写项目文件。** 不予采纳，因为 Host 必须在可信写入位置执行 Session 所有权、规范路径包含关系、文件系统策略、大小限制、内容校验和仅创建冲突处理。

**在编辑器中引入结构化 skill 引用。** 不予采纳，因为 `/name` 已经是跨客户端的调用表示。复用它可以让手动输入、`/` 建议与新选择面板保持完全相同的行为。

**导入包含配套文件的 ZIP 包。** 首个受支持的管理器不采用此方案，因为解压缩会引入路径穿越、冲突和部分写入决策。配套的 `references/`、`scripts/`、`assets/` 与模板文件仍通过外部项目文件工作流处理。

## 后果

非开发用户无需离开 Web 界面，即可发现、创建、导入和调用项目 skill。Host 提供唯一且可审计的写入路径，同名导入保持安全，安装后的 skill 仍是由现有 provider 消费的普通项目文件。

管理弹框不能安装多文件 skill。在实时 registry 不监视项目变更的环境中，新建或导入的 skill 可能要等 provider 观察到新文件后才完全可用；选择面板会立即更新当前 Session 缓存，重载后的普通 provider 发现结果仍是权威来源。
