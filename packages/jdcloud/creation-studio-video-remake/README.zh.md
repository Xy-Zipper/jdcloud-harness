---
description: "部署需要登录的造物片场参考视频拆解服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-creation-studio-video-remake

[English](README.md) | 中文

## 概述

造物片场用户可以上传 MP4 或 MOV，将镜头切点和带时间的对白带入新项目。Harness 校验调用者身份，由私有 rea-video 服务完成媒体解码与拆解。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将[可选 Compose 配置](../../../compose.video-remake.yaml)与 [JDCloud Harness 部署](../../../Docker.README.md)一起使用。配置 Worker 地址和两项单价后启用报价和拆解。拆解服务没有宿主机端口、模型密钥或互联网路由，每次请求结束后清理临时文件。

`POST /api/external/v1/creation-studio/video-remake/quote` 和 `POST /api/external/v1/creation-studio/video-remake/analyze` 均接收原始文件字节和 `Authorization: Bearer …`、`X-Tenant-Id` 请求头。Worker 校验时长，接受 4–30 秒、最大 30 MiB、横竖均最高 1080p、最高 60 fps 的视频。报价含实测秒数、字节数、单价和费用，金额单位是百分之一积分。两种用量分别向上取整后计价。

报价、拆解和原片转存的上传请求等待 Worker 空位。Harness 按到达顺序放行当前可执行的请求，同一空间的付费拆解一次处理一单。默认最多八单排队，210 秒的请求时限含排队时间。Harness 在排队时暂不读取请求体，断开连接会移除该请求，排队期间不扣费。队列满时返回 HTTP 503（`video-remake/queue-full`），等候超时返回 HTTP 504（`video-remake/queue-timeout`）。原任务回执可独立查询。

Worker 启动时按每路 2 个逻辑 CPU 和 1.5 GiB 估算，并给宿主机其他服务留出 2 个逻辑 CPU 和 2 GiB。Worker 读取进程可用 CPU、宿主机可用内存和更低的 cgroup v1 或 v2 限额，选择一到四路。启动日志显示 `slots`、`cpu_budget` 和 `memory_budget_mib`。默认 `videoRemake.concurrency: auto` 从一路开始，接到 `/probe` 的容量后调整。数字设置限制 Worker 上报的容量，旧 Worker 未上报容量时使用该数字作为入口并发上限。媒体插件的 `videoRemake.maxQueued` 和 `videoRemake.timeoutMs` 控制排队和请求时限。

在外层 `Bearer` 前缀后填写 JDCloud 返回的完整授权值，保留原值中的认证方案。Harness 将该值交给 JDCloud 校验账号和租户。

确认拆解时发送 `X-Studio-Space-Id`、`X-Studio-Request-Id`（UUID v4）和 `X-Studio-Remake-Max-Cents`（百分之一积分，用户确认的费用上限）。Harness 校验空间编辑权限和积分余额。媒体插件同时保存切点与带时间的 `dialogue`，核对扣款后返回结果。`dialogue` 为空数组表示识别已完成且未检测到对白。`video-remake/transcript-unavailable` 表示本次新请求未扣费，可沿用原确认重试。

使用原认证与确认请求头发送无请求体的 `POST /api/external/v1/creation-studio/video-remake/status`，查询原任务。200 返回保存的拆解结果，旧回执只含切点。`settlement-pending` 表示尚未匹配到扣款，`settlement-check-unavailable` 表示扣款记录暂时无法读取，两者均可直接重新查询。`settlement-conflict` 需要人工核对。首次上传中断或返回 `settlement-sync-pending` 时，重发原文件和确认信息可恢复原任务。

`POST /api/external/v1/creation-studio/video-remake/prepare-source` 接收原始 MOV 字节及相同的认证和确认请求头。Harness 核对文件摘要与已结算的拆解回执。私有 Worker 返回用于项目入库的 H.264 MP4，音轨编码为 AAC。转存复用已保存的拆解结果，无额外费用。

数据助手直接扣减空间余额时，在 `videoRemake.balanceDebitAssistant.id` 和 `nodeId` 设置数据助手编号和扣分节点编号。JDCloud 配置已为造物片场设置这两个值。积分账本没有关联扣款时，Harness 使用调用者现有权限读取近期助手执行记录。

新复刻任务使用 Worker 拆解和预备原片。媒体插件仅在回执带有本地合成计划、需要继续入库时调用 `/merge-edit`、`/mix-bgm` 和 `/sync-captions`。`/merge-edit` 将生成结果按原片时间线合成，默认直接复制 MP4 兼容的原声音轨。各接口限制本地文件大小，并在每次操作结束后清理临时文件。

Worker 在准备和合成成功时返回 `X-Remake-Output-Settings: 1`。调用 `/merge-edit` 时在此标头传入 JSON 对象 `{}`，可在生成视频的尺寸范围内适配原片画幅。模型生成固定整秒时长时，将请求的 `seconds` 一并传入，由 Worker 对齐原片时间线。未设置固定 `seconds` 的整片合成允许最多 0.4 秒的时长偏差，偏差超过 0.2 秒时调整画面速度以对齐原片时间线。

Worker 镜像在构建时安装 SenseVoice、语音活动检测和人声分离模型。`/transcript` 通过 `X-Remake-Ranges` 接收切点数组，首项为零，末项为原片时长，返回带起止时间和从 1 开始的 `shotNumber`。`/probe` 返回 `X-Remake-Audio-Edit: 1` 表示支持整片生成音轨。`/merge-edit` 的成片设置接受 `audio: "generated"` 或 `audio: "keep-music"`。设为 `keep-music` 时，由 Worker 分离原片配乐并和生成的人声混合。

继续执行已保存的配乐计划时，`/mix-bgm` 保留视频流，将选段与分离出的人声合成，并通过裁剪或循环使配乐覆盖画面时长。分离效果取决于原片混音，音效可能变化。

继续执行已保存的字幕计划时，`/sync-captions` 接收合成 MP4 和附在其后的 JSON 计划，计划上限为 256 KiB，`X-Remake-Source-Length` 标记 MP4 边界。Worker 按已保存的台词和时间窗绘制字幕，复制音轨并核对输出大小。原片编辑会保留未修改的文字字幕，并清理编辑区间内文字与位置均匹配原片的残留硬字幕。Worker 镜像内置 OCR 和中文字体。MOV 转存保留兼容的文字字幕轨。

-----

<a id="model-experience"></a>
## 模型体验

### 参考视频拆解

#### 模型所见

HTTP `analyze` 操作不注册工具或创建会话事件。Worker 在本地测量镜头边界，并转写首条音轨的完整时间范围。识别出的词按发声起点归属，新结果的每段对白只落在一个镜头。[媒体插件](../creation-studio-media/README.zh.md)将镜头编号、时间和确认的对白修改写入生成请求。

#### Token 影响

拆解占用本地 CPU、内存和临时磁盘，不消耗模型 Token。拆解成功后按实测时长和上传文件大小收费。

#### KV Cache 影响

插件不增加提示词前缀或工具定义。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 机器转写可能遗漏低声或重叠的对白。造物片场支持手动添加和标注发言人。快速闪现、手写或移动的硬字幕可能无法被 OCR 捕获。画面解读及供应商生成在拆解接口之外。每个回执目录由单个 Harness Host 负责对接账本。

<a id="dev-note"></a>
### 开发备注

无。
