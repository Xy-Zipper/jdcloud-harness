---
description: "在 Harness 中配置造物片场生图、Seedance 视频任务及已认证项目素材上传。"
kind: "package-reference"
---

# @deepseek-ai/dsh-creation-studio-media

[English](README.md) | 中文

## 概述

生成分镜图片和参考视频，再将文件及项目引用保存到低代码平台。JDCloud bundle 随 Harness 构建和部署此能力。Skill 仍以 ZIP 独立安装。密钥保留在 Host 凭据中，生成图片需要用户确认。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[JDCloud bundle patch](../../bundle/jdcloud-login/cordis.patch.yml) 挂载此插件。仓库构建会产出运行代码，Docker 通过该 bundle 包含插件；无需在 creation-studio 执行打包或单独安装媒体插件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `platformURL` / `tenantId` | 必填 | 固定平台与租户，调用身份必须匹配 |
| `stateDirectory` | 必填 | 持久化生成回执和上传进度 |
| `imageModel` | `gpt-image-2.5` | 图片供应商模型 |
| `imageRetryLimit` | `2` | 供应商指定可重试错误后的最大自动重提次数 |
| `imageKeyRef` / `arkKeyRef` | `GPT_IMAGE_API_KEY` / `ARK_API_KEY` | Host 凭据引用 |

在 Harness 服务器环境或凭据存储中配置 `GPT_IMAGE_API_KEY` 和 `ARK_API_KEY`。Compose 将变量传入容器，并把媒体状态保存在既有持久化目录 `data/creation-studio-media` 中。造物片场 Skill ZIP 仍通过 Skill 管理单独安装。

前端继续将 `/harness-api` 代理到 Harness。认证后的媒体接口保持 `/api/external/v 1/creation-studio/media/*`，网关读取超时需超过420秒。缺少供应商密钥不阻止 Harness 启动，生成配置会显示为未配置。

迁移已有任务前先停止旧执行器，将 images/seedance 回执复制到 `stateDirectory` 对应子目录。更换容器时保留同一目录。上传恢复沿用原请求编号；付费提交结果不明时先核对供应商记录，再决定是否新建请求。

分镜批量补图使用 `creation_studio_image_task` 和媒体前缀下的已认证 POST 接口 `images/tasks`、`images/refresh`、`images/list`。Submit 为每个缺图创建一个 `n=1` 异步供应商任务，模型保持 `gpt-image-2.5`。参考编辑用原始 JSON 请求体的 images 数组传已核验平台预览 URL，省略 Content-Type；文生图使用 JSON Content-Type。两者均传 async=true、response_format=url，认证为一个 Bearer 前缀加解析后的图片密钥。提交返回持久化请求及任务编号，无需等待图片生成完成。

Refresh 查询已保存的供应商编号，只有 completed 才下载内容；HTTPS 跳转跨域时不转发供应商密钥，实际解码后继续项目上传。succeeded 在 result 中返回已保存图片，pending、upload_pending、upload_failed 均保留原请求。只有明确 failed 且错误为 image generation failed; please retry 才允许自动重提，上限为 imageRetryLimit；次数及旧任务编号随同一 requestId 落盘。认证或其他客户端拒绝返回 failed 和 image/provider-rejected，结果不明仍为 unknown，绝不自动重提。既有 unknown 回执需核对供应商记录后才能新建请求。List 不创建任务。页面关闭后供应商继续生成，下载、符合条件的重提及平台上传在后续已认证查询中恢复。同步接口保留供既有单图调用方使用。

批量刷新传入 `projectId`、`planId`、`spaceId` 和非空 `taskIds` 数组，响应为任务视图数组。开始查询供应商之前，必须确认全部编号属于该项目、方案和空间。各图独立下载及上传，单项查询失败以 `refresh_failed` 返回，不隐藏其他结果。后续请求移除 `succeeded` 项；自动重提后跟随返回的新 `taskId`。工具仍可使用单个 `requestId` 的调用形式。创意或脚本确认失效时，以 `creation-studio/stale-confirmation` 停止生成，并提示重新确认对应阶段。

Seedance 视频任务保留已确认脚本的旁白、字幕、音乐与音效。分镜说话人设置对应租户音色目录中当前可读的记录；共享音色不带空间 ID，私有音色须与项目空间一致。Host 下载所选音频文件并实测时长，以 audio_url 和 reference_audio 提交。样音须为 MP3 或 WAV，每条2–30秒且不超过15MB，总长不超过30秒；每次请求最多十种不同音色。提示词将说话人及原台词映射到 @音频N，样音仅作音色参考。音色无效、缺失或不可读时，在发出付费供应商请求前停止；已有任务刷新保留原参数。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

[插件](src/index.ts) 将工具和 HTTP 路由注册到同一个[运行模块](src/runtime.mjs)。JDCloud controller 负责调用者身份、文件访问和平台请求。生成前重读项目确认链和权限，记录供应商回执，再依次保存上传文件、素材和项目引用。卸载撤销注册，并等待在途操作落盘。

迁入的 JavaScript 执行模块保留既有行为，随包的 TypeScript 构建一起输出。包内请求辅助代码对应前端持久化 JSON 字段，运行时不依赖前端源码或已安装 Skill。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [JDCloud bundle](../../bundle/jdcloud-login/README.zh.md)
- [认证 controller](../../api/jdcloud-auth-controller/README.zh.md)
- [Docker 部署](../../../Docker.README.md)

-----

<a id="model-experience"></a>
## 模型体验

### 媒体工具

#### 模型可见内容

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-creation-studio-media) 定义媒体工具，包含异步图片提交、查询和列表。执行需要当前项目上下文，返回任务状态或平台引用，不包含密钥或生成文件的二进制内容。

#### Token 影响

插件加载后增加三个工具 schema。调用将参数和媒体回执追加到正常工具事件中。

#### KV Cache 影响

配置不变时工具 schema 保持稳定。调用追加历史，修改挂载工具可能使工具前缀缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 持久化表 ID 和确认协议针对造物片场租户；其他租户需匹配表结构及配置。
- 视频输入使用图片和所选音色参考进入 Seedance 2.5 参考任务。真实供应商可用性及音色匹配效果需配置账号并实测。
- 低代码记录创建接口没有事务性幂等键，创建响应丢失时需先核对平台再重试。

<a id="dev-note"></a>
### 开发备注

无。
