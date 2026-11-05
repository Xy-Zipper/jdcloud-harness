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
| `imageModel` | `doubao-seedream-5-0-pro-260628` | 图片供应商模型 |
| `imageRetryLimit` | `4` | 仅用于已持久化的历史 GPT 任务的自动重提预算 |
| `imageKeyRef` / `arkKeyRef` | `GPT_IMAGE_API_KEY` / `ARK_API_KEY` | Host 凭据引用 |
| `accountPoolTableId` | `6aead43ac3ca9f3dcdaf4b23` | 私有账号池表 |
| `accountPoolUsernameRef` / `accountPoolPasswordRef` | `CREATION_STUDIO_ACCOUNT_POOL_USERNAME` / `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` | 仅 Host 使用的服务账号与密码 |
| `accountPoolKeyRef` | `CREATION_STUDIO_ACCOUNT_POOL_TOKEN` | 可选历史 Token；账号密码登录优先 |
| `billingWriterKeyRef` | `CREATION_STUDIO_BILLING_WRITER_TOKEN` | 可选的受限 JDCloud 凭据，用于影子用量同步 |
| `jimengAccessKeyRef` / `jimengSecretKeyRef` | `JIMENG_ACCESS_KEY_ID` / `JIMENG_SECRET_ACCESS_KEY` | 仅在 Host 使用的即梦 Visual API 签名凭据 |

方舟 API Key 和即梦 AK/SK 存入私有账号池表。`CREATION_STUDIO_ACCOUNT_POOL_USERNAME` 和 `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` 使用专用租户账号，仅允许读取租户身份和账号池表；禁止向普通调用者授权该表。Host 登录固定租户，Token 只缓存在内存中；遇到 HTTP 401 或平台600/601/602时，并发请求共用一次重新登录，再重试原只读请求一次。权限和密码失败不循环重试或回退，凭据变化后替换登录缓存。Compose 将账号密码传入容器。两项均未配置时仍可使用可选的历史 `CREATION_STUDIO_ACCOUNT_POOL_TOKEN`。完全未配置读取凭据时，以 `ENV-ARK`、`ENV-JIMENG` 编号保留历史单密钥部署；已配置但不可读或为空的账号池不会回退。`GPT_IMAGE_API_KEY` 仅在旧 GPT 任务仍需恢复时保留。更新的造物片场 Skill ZIP 仍通过 Skill 管理单独安装。

前端继续将 `/harness-api` 代理到 Harness。认证后的媒体接口保持 `/api/external/v 1/creation-studio/media/*`，网关读取超时需超过420秒。缺少供应商密钥不阻止 Harness 启动，生成配置会显示为未配置。

迁移已有任务前先停止旧执行器，将 images/seedance 回执复制到 `stateDirectory` 对应子目录。更换容器时保留同一目录。上传恢复沿用原请求编号；付费提交结果不明时先核对供应商记录，再决定是否新建请求。

分镜生图可选 `doubao-seedream-5-0-pro-260628` 或 `doubao-seedream-5-0-flash-260915`，默认取 `imageModel`。生成规划和工具参数均保存 `model`。最多十张已核验项目参考图组成方舟 `image` URL 数组。Host 调用 `/api/v3/images/generations`，返回 PNG Base64，不加水印；尺寸支持8种比例及1K/1.5K/2K，场景资产优先16:9，16:9和9:16为推荐画幅。`images/quote`核对项目及参考图，返回当前预计积分，不调用供应商或占用账号。图片按实际解码像素范围选价，参考图超出每请求免费张数的部分另计；完成任务返回`consumption`。`images/tasks` 立即返回 Host 任务，同步供应商请求在有生命周期所有者的后台运行；卸载会等待回执持久化。`images/refresh` 继续上传，`images/list` 不创建付费任务。未知提交和重启中断请求需核对供应商记录，不自动重发；已持久化的 GPT 任务保留原查询和受限重试流程。

仅从 `models` 包含本次完整API模型ID且 `scenarios` 包含本次服务的账号中分配。表单选择 `Doubao-Seedream-5.0-flash` 等具体模型名，渠道字段仅作服务端路由元数据。同一Key的多个模型共用一条账号与并发上限。账号分配优先选择在途任务数除以 `maxConcurrent` 最小的账号，同等负载随机选择，符合模型条件的启用账号占满时拒绝新任务。方舟生图和视频共享并发额度，新白底图共享方舟额度；历史即梦任务保留AK/SK池。提交前在 `stateDirectory/provider-calls` 持久化占用及每次调用的用户、项目、请求、模型、账号 ID/编号、时间和状态，不保存密钥。未知结果保留占用；生成完成或明确失败释放额度，上传恢复不重新生成。视频和白底图查询使用原账号，即使该账号已停用；任务结束前须保留原凭据。影子用量记录仅公开 `providerAccountRef`，不返回密钥。每个状态目录由一个 Host 独占，此实现不是分布式调度器。

批量刷新传入 `projectId`、`planId`、`spaceId` 和非空 `taskIds` 数组，响应为任务视图数组。开始查询供应商之前，必须确认全部编号属于该项目、方案和空间。各图独立下载及上传，单项查询失败以 `refresh_failed` 返回，不隐藏其他结果。后续请求移除 `succeeded` 项；自动重提后跟随返回的新 `taskId`。工具仍可使用单个 `requestId` 的调用形式。创意或脚本确认失效时，以 `creation-studio/stale-confirmation` 停止生成，并提示重新确认对应阶段。

Seedance 视频任务保留已确认脚本的旁白、字幕、音乐与音效。分镜说话人设置对应租户音色目录中当前可读的记录；共享音色不带空间 ID，私有音色须与项目空间一致。Host 下载所选音频文件并实测时长，以 audio_url 和 reference_audio 提交。样音须为 MP3 或 WAV，每条2–30秒且不超过15MB，总长不超过30秒；每次请求最多十种不同音色。提示词将说话人及原台词映射到 @音频N，样音仅作音色参考。音色无效、缺失或不可读时，在发出付费供应商请求前停止；已有任务刷新保留原参数。

Seedream白底图使用所选pro/flash、明确尺寸与方舟账号池，付费同步调用前固定模型和尺寸。历史即梦4.0回执保留AK/SK恢复。已认证POST接口仍为`white-background/tasks`、`white-background/refresh`、`white-background/list`。提交需要当前空间项目和自有或可商用图片，无需采纳方案。Host单独生成JPEG参考图并应用白底提示词，保留商品文字与用户指定的多视角构图；生成图仍需人工检查。原图保持不变。返回的单张图片经核验、上传后关联为生成的项目素材，保存原始素材来源；同空间其他项目可以复用。稳定请求编号恢复生成与上传进度，未知付费提交不自动重发。新用量记录的供应商为 `ark` 及所选模型；没有匹配的已发布价格时费用保持待计算。

-----

影子计费从持久 assistant 事件采集已认证造物片场调用尝试，不增加模型消息。正常供应商用量（含阶段推荐）归属于提交用户和空间，供应商错误尝试和没有本轮用户操作的自动调用由平台承担。历史回执保留原费用归属。缺用量或价格保持待核对。视频回执先于下载保存 completion_tokens，不再加一次 total_tokens。图片和视频仅在项目入库后将客户费用标为可核对；不写余额、预留或账本流水。

每次模型调用结束后自动向低代码用量表同步回执。配置受限服务写入凭据时优先使用；它仅需读取租户身份、查询用量表以及新增/更新用量记录。未配置时，使用原发起人当前认证请求已有的权限，不额外保存用户 Token，账号变化时拒绝继续写入。权限或网络失败保留持久待同步回执。本轮结束后在后台补同步绑定空间和项目的待处理记录；已认证 POST billing/list 也会先补同步、重算待处理记录，再按每页50条返回当前空间的本地回执。billing/sync 显式执行同样的恢复，每次最多处理50条。回执和已核验会话绑定保存在 stateDirectory/billing。更新使用 PUT；创建响应丢失时按原事件键核对，不盲目再次创建。每个状态目录由一个 Host 独占，多写入端在财务使用前须补平台唯一键。

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
