---
kind: upgrade-guide
description: "升级后，造物片场阶段推荐计入客户用量。"
---

# 造物片场推荐用量由客户承担

[English](guide.md) | 中文

## 变更

造物片场媒体插件此前将阶段推荐请求归为平台承担。新的已认证推荐操作使用提交用户的项目和已发布的 Token 价格计量。供应商错误尝试和没有本轮用户操作的自动调用仍由平台承担。历史回执保留原费用归属；本次变更不执行钱包扣款。

## 迁移

1. 部署更新后的 Harness 构建，保留媒体插件的 `stateDirectory`。
2. 为已认证项目生成阶段推荐，检查已同步用量回执：`skillNames` 包含 `creation-studio-stage-recommender`，`payer` 为 `customer`，费用由实际返回的 Token 用量计算。
3. 保留历史回执。缺少用量或价格的记录保持待核对；供应商失败尝试仍由平台承担。
