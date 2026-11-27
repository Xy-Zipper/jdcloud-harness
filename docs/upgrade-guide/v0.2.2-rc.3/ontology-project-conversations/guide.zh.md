---
kind: upgrade-guide
description: "Ontology 内嵌助手按所选项目分别打开工作区与对话历史。"
---

# Ontology 助手的项目会话历史

[English](guide.md) | 中文

## 变更

内嵌助手以前在各项目间共用账号的工作区文件夹、对话和个人 Skill。现在助手按所选项目 ID 打开对应内容。原来按账号保存的历史仍可在独立打开的 Harness 中查看。

## 迁移

1. 更新 Harness 时保留现有的 Harness 数据目录与 `ONTOLOGY_BASE_URL`。已通过 `ONTOLOGY_USER_WORKSPACE_DIR` 将账号目录存到独立卷的部署应保留该配置。
2. 在 Ontology 选一个项目，打开智能助手并创建测试文件夹。切换到另一个项目，再切回原项目，确认能看到原来的文件夹。
3. 要查阅原有的账号会话，在 Ontology 智能助手页点击**新窗口打开**，使用同一账号登录 Harness。
