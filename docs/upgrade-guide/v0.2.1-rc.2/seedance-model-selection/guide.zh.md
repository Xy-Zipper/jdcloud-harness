---
kind: upgrade-guide
description: "造物片场新视频批次要求 Host 读取明确保存的 Seedance 模型选择。"
---

# 保留用户选择的 Seedance 模型

[English](guide.md) | 中文

## 变更

造物片场新视频批次以 `seedance-models-1` 保存 `generation.model`。Host 按各自限制接受 Seedance 2.0、2.0-fast、2.0-mini 和2.5。旧版 Host 会拒绝新批次格式。历史 `seedance-2.0-1` 和 `seedance-2.5-1` 批次仍可读取，缺少模型的批次沿用原2.5默认值。已有任务继续使用原模型与请求编号。

## 迁移

1. 同时部署新版造物片场前端与 Harness，并更新 `creation-studio-video-generation` Skill ZIP。
2. 将已开通模型的 ID 加入现有视频账号的 `models`，按支持的模型、分辨率和输入视频类型发布价格；保留密钥、并发上限与历史价格。
3. 选择模型后保存批次，确认创建请求、任务回执和用量记录均包含所选模型。不支持的时长、分辨率或参考数量应在发出供应商请求前停止。
