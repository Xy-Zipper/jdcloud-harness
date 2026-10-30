---
kind: upgrade-guide
description: "自定义 SessionPersistence 后端必须实现会话永久删除。"
---

# 实现 SessionPersistence.delete

[English](guide.md) | 中文

## 变更

`SessionPersistence` 要求实现 `delete(id: SessionId): Promise<void>`。自定义子类必须实现此方法，以支持从 GUI 永久删除会话。随附 JSONL 后端已实现该方法，现有日志不需要转换。

## 迁移

1. 在每个自定义 `SessionPersistence` 子类中实现 `delete`。要求调用方先停止数据生产方，排空并关闭本地写句柄，拒绝其他进程持有的写入，并移除后端持有的会话存储。不存在的 id 必须直接成功，存储失败必须拒绝。
2. 项目文件与全局共享附件对象不在此操作范围内。
3. 编译后端，确认删除一个会话会移除其存储文件与列表记录，同时不影响其他会话或项目文件。
