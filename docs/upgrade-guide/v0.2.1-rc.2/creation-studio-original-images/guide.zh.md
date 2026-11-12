---
kind: upgrade-guide
description: "造物片场视频提交使用 Seedream 文生图参考时，必须保留 Host 原始图片回执。"
---

# 保留造物片场视频使用的原始图片

[English](guide.md) | 中文

## 变更

造物片场原先从低代码下载所有视频参考图并提交 Base64 字节。现在 Seedream 文生图参考使用供应商原始 URL，并固定使用生成该图的同一方舟账号。Host 在视频提交前核对生图和上传回执、文件绑定及 URL 有效期。

没有原始 URL 或 Host 回执的历史文生图不能使用这条路径。原始产物缺失或过期时停止提交；Host 不换账号、不替换为低代码字节，也不自动创建付费替代任务。

## 迁移

1. 同步部署匹配的造物片场前端、媒体包，以及需求理解、分镜资产、生图和视频生成 Skill ZIP。
2. 一并保留 `stateDirectory/images`、`stateDirectory/uploads` 和 `stateDirectory/provider-calls`，并保持原方舟账号启用且支持所选视频模型。
3. 历史或已过期的文生图如需继续使用，返回分镜明确规划并确认新的文生图请求。人脸图不选择参考图片。不要在低代码记录中伪填原始 URL。
4. 确认素材的 `generatedImage` 保留 `originalUrl` 和 `originalUrlExpiresAt`，视频提交使用已记录的供应商账号。原始产物缺失或过期时，应在调用视频供应商前显示明确处理提示。有效期和审核要求见[媒体包](../../../../packages/jdcloud/creation-studio-media/README.zh.md)。
