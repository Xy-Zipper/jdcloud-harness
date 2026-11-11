---
kind: upgrade-guide
description: "造物片场图片任务响应在提交供应商前包含排队状态。"
---

# 造物片场图片任务支持排队

[English](guide.md) | 中文

## 变更

`images/tasks` 在分配账号前可以返回 `status: "queued"`。此前账号达到并发上限会导致图片任务失败；现在已接受的图片会在 Host 中等待名额。账号缺失或无效仍会失败。已提交但结果未知的请求不会重新提交。

## 迁移

1. 同时部署配套的造物片场前端和 Harness。将 `queued` 与 `pending` 一样视为进行中的任务，继续使用原 `requestId` 和 `taskId` 查询。
2. 保留已配置的 `stateDirectory`。Host 停止时保留尚未提交的排队回执；通过已认证的 `images/refresh` 或沿用原参数再次提交，可以恢复已接受的排队任务。
3. 运行 `pnpm exec vitest run packages/jdcloud/creation-studio-media/tests/runtime.spec.ts -t 'queues eight accepted images'` 验证：账号上限为五个名额时，八张图片均应完成，供应商同时在途的请求不得超过五个。
