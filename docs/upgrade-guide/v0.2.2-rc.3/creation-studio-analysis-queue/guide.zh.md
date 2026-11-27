---
kind: upgrade-guide
description: "造物片场的视频上传在拆解繁忙时等待处理空位，替代 HTTP 429 响应。"
---

# 造物片场视频拆解上传队列

[English](guide.md) | 中文

## 变更

`/api/external/v1/creation-studio/video-remake/` 下的 `quote`、`analyze` 和 `prepare-source` 在繁忙时等待处理空位。队列满时返回 HTTP 503 和 `video-remake/queue-full`，等待超时返回 HTTP 504 和 `video-remake/queue-timeout`。有上传占用 Worker 时仍可通过 `status` 查询原任务回执。`videoRemake.concurrency` 默认为 `auto`，Harness 在首次探测后采用 Worker 上报的容量。明确设置数字时，数字为容量上限。

## 迁移

1. 更新按 HTTP 429 分支处理的客户端，等候原请求完成，重试时继续使用原确认的请求编号。代理等待时间需覆盖配置的 `videoRemake.timeoutMs`，其中包含排队时间。
2. 同步更新 Worker 镜像、Harness 镜像和 Compose 配置以启用自动并发。在 Worker 启动日志查看 `slots`。需要串行放行时设置 `videoRemake.concurrency: 1`，用 `videoRemake.maxQueued` 调整默认八单的排队上限。
