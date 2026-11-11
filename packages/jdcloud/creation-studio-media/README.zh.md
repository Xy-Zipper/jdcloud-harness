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
| `billingWriterKeyRef` | `CREATION_STUDIO_BILLING_WRITER_TOKEN` | 可选的受限 JDCloud 凭据，用于实际用量计费同步 |
| `jimengAccessKeyRef` / `jimengSecretKeyRef` | `JIMENG_ACCESS_KEY_ID` / `JIMENG_SECRET_ACCESS_KEY` | 仅在 Host 使用的即梦 Visual API 签名凭据 |

方舟 API Key 和即梦 AK/SK 存入私有账号池表。`CREATION_STUDIO_ACCOUNT_POOL_USERNAME` 和 `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` 使用专用租户账号，仅允许读取租户身份和账号池表；禁止向普通调用者授权该表。Host 登录固定租户，Token 只缓存在内存中；遇到 HTTP 401 或平台600/601/602时，并发请求共用一次重新登录，再重试原只读请求一次。权限和密码失败不循环重试或回退，凭据变化后替换登录缓存。Compose 将账号密码传入容器。两项均未配置时仍可使用可选的历史 `CREATION_STUDIO_ACCOUNT_POOL_TOKEN`。完全未配置读取凭据时，以 `ENV-ARK`、`ENV-JIMENG` 编号保留历史单密钥部署；已配置但不可读或为空的账号池不会回退。`GPT_IMAGE_API_KEY` 仅在旧 GPT 任务仍需恢复时保留。更新的造物片场 Skill ZIP 仍通过 Skill 管理单独安装。

前端继续将 `/harness-api` 代理到 Harness。认证后的媒体接口保持 `/api/external/v 1/creation-studio/media/*`，网关读取超时需超过420秒。缺少供应商密钥不阻止 Harness 启动，生成配置会显示为未配置。

需求的 `specification.durationMode` 可选 `fixed` 或 `estimated`，缺省沿用固定模式。固定模式下脚本与已确认方案时长一致。预计模式下方案与脚本可采用不同的实际时长，均至少4秒且不超过需求选定时长。生成沿用已确认脚本的时间安排。前端、阶段 Skill ZIP 与 Host 须配套部署。

通过 `jdcloud_lowcode_create` 新建造物片场项目时，每次执行前读取目标团队空间的当前 `points`。积分为0或负数时以 `creation-studio/insufficient-points` 拒绝创建并提示充值，正数小数积分可继续。积分缺失或格式无效、平台读取失败、空间停用或账号变化时，以 `creation-studio/points-unavailable` 拒绝创建。调用者须为空间所有者或生效的管理员、编辑者。充值后重试会重新读取。此校验不扣减或预留积分，也不限制已有项目更新。

已认证造物片场会话的每次模型请求，包括 Skill 后续轮次、推荐、继承绑定的 subagent 和重试，都会在供应商调用前重读绑定空间的 `points`。没有已核验造物片场绑定的调用不适用此策略。图片、视频和白底图的新提交在获取供应商账号前也检查积分；历史 GPT 失败重提及历史白底图在付费 POST 前检查。积分必须严格大于0，零或负数时提示充值，读取失败时停止新增调用。已有任务查询、下载、上传和结果保存继续可用。充值后下次重试读取新值，此检查不预留或扣减积分。

迁移已有任务前先停止旧执行器，将 images/seedance 回执复制到 `stateDirectory` 对应子目录。更换容器时保留同一目录。上传恢复沿用原请求编号；付费提交结果不明时先核对供应商记录，再决定是否新建请求。

分镜生图可选 `doubao-seedream-5-0-pro-260628` 或 `doubao-seedream-5-0-flash-260915`，默认取 `imageModel`。生成规划和工具参数均保存 `model`。最多十张已核验项目参考图组成方舟 `image` URL 数组。Host 调用 `/api/v3/images/generations`，返回 PNG Base64，不加水印；尺寸支持8种比例及1K/1.5K/2K，场景资产优先16:9，16:9和9:16为推荐画幅。`images/quote`核对项目及参考图，返回当前预计积分，不调用供应商或占用账号。图片按实际解码像素范围选价，参考图超出每请求免费张数的部分另计；完成任务返回`consumption`。`images/tasks` 返回已持久化的 Host 任务：分配账号后为 `pending`，符合条件的账号占满时为 `queued`。名额释放会自动唤醒已接受的图片，无需再次提交。卸载保留尚未提交的排队任务并等待在途回执落盘。重启后通过已认证的 `images/refresh` 恢复排队工作，开始前重新核对项目、参考图、积分和写权限；`images/list` 仅作读取。未知提交和重启中断请求需核对供应商记录，不自动重发；已持久化的 GPT 任务保留原查询和受限重试流程。

待人工确认的生成图在核对项目归属、版本、文件类型和使用范围后，可作为继续生图或编辑的参考。图片报价和提交不会确认这些画面。新结果仍为待确认状态；最终分镜确认和视频提交仍要求已选生成图完成人工确认。

图片、视频和白底图的参考校验将素材使用范围缺失、空值或历史“待确认”按“自有”处理，引用的历史快照也使用同一规则。明确的内部参考限制保持生效。此默认值不改写原素材，也不确认生成图画面。

仅从 `models` 包含本次完整API模型ID且 `scenarios` 包含本次服务的账号中分配。表单选择 `Doubao-Seedream-5.0-flash` 等具体模型名，渠道字段仅作服务端路由元数据。同一Key的多个模型共用一条账号与并发上限。账号分配优先选择在途任务数除以 `maxConcurrent` 最小的账号，同等负载随机选择。符合条件的账号占满时，分镜图片进入排队；其他新媒体提交返回 `accounts/busy`。缺少符合条件的账号时返回 `accounts/unavailable`。方舟生图和视频共享并发额度，新白底图共享方舟额度；历史即梦任务保留AK/SK池。提交前在 `stateDirectory/provider-calls` 持久化占用及每次调用的用户、项目、请求、模型、账号 ID/编号、时间和状态，不保存密钥。未知结果保留占用；生成完成或明确失败释放额度，上传恢复不重新生成。视频和白底图查询使用原账号，即使该账号已停用；任务结束前须保留原凭据。用量记录仅公开 `providerAccountRef`，不返回密钥。每个状态目录由一个 Host 独占，此实现不是分布式调度器。

批量刷新传入 `projectId`、`planId`、`spaceId` 和非空 `taskIds` 数组，响应为任务视图数组。开始查询供应商之前，必须确认全部编号属于该项目、方案和空间。各图独立下载及上传，单项查询失败以 `refresh_failed` 返回，不隐藏其他结果。后续请求移除 `succeeded` 项；自动重提后跟随返回的新 `taskId`。工具仍可使用单个 `requestId` 的调用形式。创意或脚本确认失效时，以 `creation-studio/stale-confirmation` 停止生成，并提示重新确认对应阶段。

`request.generateImages=false` 的分镜轮次允许规划、报价、列出和恢复已有图片，但两个生图工具均拒绝新的付费提交。前端按已保存的缺图请求报价，等待明确确认后才提交。已有任务和多目标共用图片不计入新费用；保存的规划或当前选图变化时拒绝确认。图片预估不包含单独计量的分镜整理对话费用。

Seedance 视频任务使用已保存批次的 `generation.model`：`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615` 或 `doubao-seedance-2-5-260628`。缺少模型的历史批次沿用2.5。新批次使用 `seedance-models-1`，需同时部署匹配的前端与 Host。所选模型用于匹配供应商账号、任务回执、用量记录和价格。仅2.5发送 `omni_reference_task_type=reference` 和 `output_format=mp4`。同一请求编号返回原任务和原模型。2.5支持4–30秒、30张图片、10条音频和480p/720p/1080p；2.0系列支持4–15秒、9张图片和3条音频，2.0支持480p/720p/1080p/4k，fast和mini支持480p/720p。无效组合在付费请求前停止，不丢弃参考素材。

逐镜分镜图、资产图和场景图槽位均为可选。参考生视频每批至少需要一张已核验的项目图片，可只用商品、人物、场景或道具参考，不要求逐镜图片。已选分镜与批次参考图仍须核对项目归属、有效版本、商用授权及生成图人工确认。已保存批次的参考图顺序决定 `@图片N`；列表内所有图片都会提交，即使提示词未提及。

Seedance 视频任务保留已确认脚本的旁白、字幕、音乐与音效。分镜说话人设置对应租户音色目录中当前可读的记录；共享音色不带空间 ID，私有音色须与项目空间一致。Host 下载所选 MP3 或 WAV 样音并实测时长，以 `audio_url` 和 `reference_audio` 提交。每条样音至少2秒且不超过15MB；单条及合计时长不能超过所选模型的最大视频时长。提示词将说话人及原台词映射到 `@音频N`，样音仅作音色参考。音色无效、缺失或不可读时，在发出付费供应商请求前停止；已有任务刷新保留原参数。

Seedream白底图使用所选pro/flash、明确尺寸与方舟账号池，付费同步调用前固定模型和尺寸。历史即梦4.0回执保留AK/SK恢复。已认证POST接口仍为`white-background/tasks`、`white-background/refresh`、`white-background/list`。提交需要当前空间项目和自有或可商用图片，无需采纳方案。Host单独生成JPEG参考图并附加优先保留商品可见细节的背景编辑要求：保留轮廓、比例、颜色、材质、文字、图案、按钮、接口和部件，移除无关背景物体，使用纯白背景并保留自然接触阴影，不编造配件或遮挡细节。默认保留原视角，仅在用户明确要求时使用多视角构图。这些提示词不能保证逐像素保真，生成后仍须对照原图检查再确认。原图保持不变。返回的单张图片经核验、上传后关联为生成的项目素材，保存原始素材来源；同空间其他项目可以复用。稳定请求编号恢复生成与上传进度，未知付费提交不自动重发。新用量记录的供应商为 `ark` 及所选模型；没有匹配的已发布价格时费用保持待计算。

-----

按用量计费从持久 assistant 事件采集已认证造物片场调用尝试，不增加模型消息。正常供应商用量（含阶段推荐）归属于提交用户和空间，供应商错误尝试和没有本轮用户操作的自动调用由平台承担。历史回执保留原费用归属。缺用量或价格保持待核对。视频回执先于下载保存 completion_tokens，不再加一次 total_tokens。图片和视频仅在项目入库后将客户费用标为可核对；Host 写入用量回执，平台数据助手更新积分。

用量字段 `customerCharge` 和 `gatewayCost` 保存两位小数的元／积分金额字符串，1元=1积分。每次调用先精确计算最终费用，再四舍五入到分；项目合计累加这些已取整金额。报价和工具消耗使用同一口径，单价仍可保留六位小数。读取历史 `shadow-billing-1` 回执时转换原微元金额，不重新计价，也不重新同步已完成历史记录；新回执使用 `usage-decimal-2`。

每次模型调用结束后自动向低代码用量表同步回执。已核算的客户费用在新增和更新时均写为 `chargeStatus=settled`；本地回执保留 `ready`，执行状态独立保存，`pending` 和 `waived` 费用状态保持原值。配置受限服务写入凭据时优先使用；它仅需读取租户身份、查询用量表以及新增/更新用量记录。未配置时，使用原发起人当前认证请求已有的权限，不额外保存用户 Token，账号变化时拒绝继续写入。权限或网络失败保留持久待同步回执。本轮结束后在后台补同步绑定空间和项目的待处理记录；已认证 POST billing/list 也会先补同步、重算待处理记录，再按每页50条返回当前空间的本地回执。billing/sync 显式执行同样的恢复，每次最多处理50条。回执和已核验会话绑定保存在 stateDirectory/billing。更新使用 PUT；创建响应丢失时按原事件键核对，不盲目再次创建。每个状态目录由一个 Host 独占，多写入端在财务使用前须补平台唯一键。

图片任务提交、列表和刷新响应在费用未确定前省略 `consumption.credits`，缺失的报价金额和价格版本也不返回。回执仍是 Agent 工具可接收的无损 JSON；费用待核对不会隐藏已接受任务，也不代表允许重复提交。

新回执保存 `billingMode=metered`，计费列表和同步响应返回 `mode=metered`。未记录模式的历史回执保留 `shadow`，不迁移已同步记录。视频供应商编号分别保存在任务 `id`、用量 `providerRequestId` 和素材 `generatedVideo.taskId`，与本地操作 `requestId` 分开。平台记录已为 `settled` 时，恢复只核对原金额、承担方、发起人及已提供的供应商编号，不再更新该行，避免再次触发扣分数据助手；不一致时保留待人工核对。

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
- 已确认字幕与旁白原文置于画面提示词之前，保留原文。生成的文字与朗读未逐字核验；Host 不执行后期字幕排字或独立旁白合成。
- 低代码记录创建接口没有事务性幂等键，创建响应丢失时需先核对平台再重试。

<a id="dev-note"></a>
### 开发备注

无。
