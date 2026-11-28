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

分镜生图可选 `doubao-seedream-5-0-pro-260628` 或 `doubao-seedream-5-0-flash-260915`，默认取 `imageModel`。生成规划和工具参数均保存 `model`。最多十张已核验项目参考图组成方舟 `image` URL 数组。Host 调用 `/api/v3/images/generations`，返回 PNG 图片，不加水印；尺寸支持8种比例及1K/1.5K/2K，场景资产优先16:9，16:9和9:16为推荐画幅。`images/quote`核对项目及参考图，返回当前预计积分，不调用供应商或占用账号。图片按实际解码像素范围选价，参考图超出每请求免费张数的部分另计；完成任务返回`consumption`。`images/tasks` 返回已持久化的 Host 任务：分配账号后为 `pending`，符合条件的账号占满时为 `queued`。名额释放会自动唤醒已接受的图片，无需再次提交。卸载保留尚未提交的排队任务并等待在途回执落盘。重启后通过已认证的 `images/refresh` 恢复排队工作，开始前重新核对项目、参考图、积分和写权限；`images/list` 仅作读取。未知提交和重启中断请求需核对供应商记录，不自动重发；已持久化的 GPT 任务保留原查询和受限重试流程。

新的分镜生图和编辑请求使用 URL 输出，在下载未修改的 PNG 入库前持久化原始 URL、有效期、生成时间和供应商账号。视频提交从 Host 生图及上传回执解析原始产物并核对平台文件。同一租户和空间中的新项目引用，在素材、文件和版本一致且有使用权限时，可复用原项目或原方案的回执。文生图原始产物固定使用同一启用的方舟账号，不同账号的文生图不能合并成同一批；编辑产物不因此获得文生人脸信任资格。原始下载链接有效期为 24 小时。链接过期后，Host 使用已核验的同一入库图片的低代码预览地址。支持的 Seedream 文生图受信期为 30 天，两种地址都使用原生成账号。缺少回执、文件变化或文生图受信期过期时停止提交。平台仍会审核。迁移 Host 数据时须一并保留 images、uploads 和 provider-calls 目录。

上传参考图、历史编辑产物和原下载链接已过期的图片在 Host 核对项目归属、选定版本、使用范围和画面确认后，使用固定平台的 `/api/file/previewImage/<tenant>/<fileId>` URL。匿名 GET 核对图片内容和单文件小于30 MiB，不缓冲或转为 Base64。私有或不可读链接在视频提交前停止，图片 URL 不携带登录信息。完整 JSON 请求仍限制64 MiB。参考图错误显示镜头和批次图片编号，复刻任务使用主体编号。任务回执按提交顺序保存编号，后续供应商错误可对应原选图。`video/tasks` 的明确提交前错误携带 `submissionState=not-submitted`，客户端可返回设置，不查询不存在的任务；没有此标识的传输错误仍视为结果未知。

待人工确认的生成图在核对项目归属、版本、文件类型和使用范围后，可作为继续生图或编辑的参考。图片报价和提交不会确认这些画面。新结果仍为待确认状态；最终分镜确认和视频提交仍要求已选生成图完成人工确认。

图片、视频和白底图的参考校验将素材使用范围缺失、空值或历史“待确认”按“自有”处理，引用的历史快照也使用同一规则。明确的内部参考限制保持生效。此默认值不改写原素材，也不确认生成图画面。

仅从 `models` 包含本次完整API模型ID且 `scenarios` 包含本次服务的账号中分配。表单选择 `Doubao-Seedream-5.0-flash` 等具体模型名，渠道字段仅作服务端路由元数据。同一Key的多个模型共用一条账号与并发上限。账号分配优先选择在途任务数除以 `maxConcurrent` 最小的账号，同等负载随机选择。符合条件的账号占满时，分镜图片进入排队；其他新媒体提交返回 `accounts/busy`。缺少符合条件的账号时返回 `accounts/unavailable`。方舟生图和视频共享并发额度，新白底图共享方舟额度；历史即梦任务保留AK/SK池。提交前在 `stateDirectory/provider-calls` 持久化占用及每次调用的用户、项目、请求、模型、账号 ID/编号、时间和状态，不保存密钥。未知结果保留占用；生成完成或明确失败释放额度，上传恢复不重新生成。视频和白底图查询使用原账号，即使该账号已停用；任务结束前须保留原凭据。用量记录仅公开 `providerAccountRef`，不返回密钥。每个状态目录由一个 Host 独占，此实现不是分布式调度器。

批量刷新传入 `projectId`、`planId`、`spaceId` 和非空 `taskIds` 数组，响应为任务视图数组。开始查询供应商之前，必须确认全部编号属于该项目、方案和空间。各图独立下载及上传，单项查询失败以 `refresh_failed` 返回，不隐藏其他结果。后续请求移除 `succeeded` 项；自动重提后跟随返回的新 `taskId`。工具仍可使用单个 `requestId` 的调用形式。创意或脚本确认失效时，以 `creation-studio/stale-confirmation` 停止生成，并提示重新确认对应阶段。

`request.generateImages=false` 的分镜轮次允许规划、报价、列出和恢复已有图片，但两个生图工具均拒绝新的付费提交。前端按已保存的缺图请求报价，等待明确确认后才提交。已有任务和多目标共用图片不计入新费用；保存的规划或当前选图变化时拒绝确认。图片预估不包含单独计量的分镜整理对话费用。

Seedance 视频任务使用已保存批次的 `generation.model`：`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615` 或 `doubao-seedance-2-5-260628`。缺少模型的历史批次沿用2.5。加入项目或系统音频片段的批次使用 `seedance-audio-references-1`。有视频且未加入音频片段的批次使用 `seedance-video-references-1`。需同时部署匹配的前端与 Host。所选模型用于匹配供应商账号、任务回执、用量记录和价格。方舟 2.5 发送 `omni_reference_task_type=reference` 和 `output_format=mp4`。同一请求编号返回原任务和原模型。2.5 输出 4–30 秒，支持 480p、720p 和 1080p。2.0 系列输出 4–15 秒。2.0 支持 480p、720p、1080p 和 4k，fast 和 mini 支持 480p 和 720p。

Seedance 2.5 每批最多接受 50 个参考素材，包括最多 30 张图片、10 段视频和 10 段音频。2.0 系列每批最多接受 15 个参考素材，包括最多 9 张图片、3 段视频和 3 段音频。旁白样音及选用的项目、系统音频都计入音频数量。单项或合计超限时停止付费提交。参见[方舟能力对照表](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)。

<a id="seedance-25-provider"></a>

在私有账号池 `6aead43ac3ca9f3dcdaf4b23` 为 Seedance 2.5 新任务启用马栏山。设置 `provider=malanshan`、`scenarios=["video"]`、模型 ID `doubao-seedance-2-5-260628`、唯一账号编号、供应商 `apiKey` 和正整数并发上限。仅含图片或音频参考的批次在有匹配启用账号时选择马栏山，符合条件的马栏山账号均满时返回 `accounts/busy`。没有匹配的启用账号时选择方舟。任务查询使用提交时保存的供应商和账号。部署需允许 HTTPS 出站访问 8559 端口。两家供应商共用方舟已发布的 Seedance 2.5 价格，按回执 `completion_tokens` 结算。用量记录标明实际供应商。Harness 向马栏山发送文本、有权使用的参考图片和本批已核验的参考音频。旁白批次须开启生成音频。同账号 Seedream 产物使用方舟模型。视频复刻可使用马栏山进行分镜重拍。

`media/config` 在 `video.providers` 返回 Seedance 2.5 当前供应商，并在 `video.availability` 逐模型报告账号可用性。供应商配置错误显示在使用该供应商的模型上。调用 `video/tasks` 时在 `expectedProvider` 传入报价对应的供应商。如果账号池已切换供应商，Harness 会在提交前返回 `video/provider-changed`。重新获取报价后可再次提交。

Harness 使用马栏山成功回执里的 `id` 调用 `tasksGet/{id}`。支持方舟格式和网关带成功 `code` 与 `data` 的结构。HTTP 200 可能包含业务错误。明确的鉴权、输入和参数拒绝显示为请求失败。结果不明的回执保留待核对状态，并显示可取得的 HTTP 状态码、业务码和追踪号。新建任务前请向供应商核对这类回执。

逐镜分镜图、资产图和场景图槽位均为可选。Seedance 2.0 批次需要已核验的项目图片或视频。Seedance 2.5 也支持仅使用音频参考。商品、人物、场景或道具参考可直接用于生成。已选分镜与批次参考图仍须核对项目归属、有效版本、商用授权及生成图人工确认。已保存批次的参考图顺序决定 `@图片N`；列表内所有图片都会提交，即使提示词未提及。

项目视频引用按 `generation.videoReferences` 的保存顺序对应 `@视频N`。Host 核对素材归属、使用范围和固定版本，再从平台流式读取 MP4 或 MOV 以核验格式和时长。Host 向方舟提交 `reference_video` URL，并记录 `inputVideoMode=present`。`video.referenceVideoAvailability` 按模型报告方舟账号可用性。参考视频总长在 Seedance 2.5 中最多 30 秒，在 2.0 系列中最多 15 秒。单段均至少 2 秒。

批次保存的 `generation.audioClips` 按选用顺序排在旁白后，共用 `@音频N` 编号。项目音频用 `relationId` 指定固定版本的文件。系统音频用 `voiceId` 匹配当前账号可读的共享或本空间目录。Host 按文件内容识别 MP3 或 WAV 并实测时长。格式标注正确的项目音频使用原下载地址，系统音频和标注错误的项目音频按识别出的 MIME 类型提交文件字节。每段至少 2 秒，大小不超过 15 MB，所有参考音频与旁白样音共用模型的段数和总时长上限。同一批次复用样音已有的编号。添加参考音频会开启生成音频，沿用所选模型的供应商路由。

说话人可以沿用分镜的系统音色或有权使用的项目音频，也可以按视频批次选用样音。分镜的项目默认样音保存在 `storyboard-speech-2` 中。使用项目样音或明确改选音色的批次采用 `seedance-voice-overrides-1`。应用批次音色时沿用已有分镜确认。Host 根据已确认脚本核对角色，读取有权使用的样音，并按编号提交音色参考。视频回执记录本次提交的改选结果，旧配置下的成片可在历史中查看。

复刻项目保存原片、有序替换规则和所选输出设置。Harness 核对归属、编辑权限、图片确认和文件版本。原片编辑使用具备视频参考权限的方舟账号。Seedance 2.5 使用自适应画幅，成片时长参照原片。2.0 系列接收不超过 15 秒的整段原片，并以最接近的整秒数生成。新任务直接入库模型返回的 MP4，并优先记录供应商返回的时长。带有本地合成计划的回执在继续入库时沿用原计划。

原片编辑提示词只替换指定范围内原本出现的对象，保留构图和编辑范围之外的内容。换镜或换手后，同一替换对象沿用参考外观。对白中的 `主体2` 等编号指向本次请求实际发送的 `@图片2` 对应角色，也支持自由填写发言人描述。

复刻媒体请求省略 `planId`。主体图复用 Seedream 5.0 pro 和 flash 任务，人工采用后才能加入规则。同一复刻项目的文生图沿用同一个方舟账号，以便一次视频编辑能使用多张原始产物。视频任务编号由原片、已保存的规则和所选输出设置确定。缺少输出设置的旧任务沿用原编号。同一套设置的原任务须明确失败、取消或过期才可重新提交。

`video/remake-transcript` 读取已授权复刻项目的参考片和切点，返回带 `shotNumber`、`start`、`end` 和 `original` 原文的 `lines`。保存 `dialogue` 后，生成请求使用镜头编号、修改过的台词、时间和发言人。未包含镜头编号的旧台词沿用原任务编号。`shotNotes` 为分镜重拍提供逐镜描述。Seedance 生成声音，原片编辑提示模型保留未改动的对白、配乐和环境声。自动配乐要求生成新配乐。已授权的 MP3 或 WAV 作为 `reference_audio` 发送，文件至少 2 秒，时长不超过模型上限，大小不超过 15 MB，选段起止时间写入提示词。实际使用的对白、逐镜描述及配乐选段参与任务编号计算。

对白改动时，原片编辑提示模型更新对应的可见对白字幕并保留其他文字。分镜重拍提示模型为改写的对白生成同步字幕。字幕文字、原声还原和配乐选段的精确度由模型决定。

保存 `storyboardGeneration` 的画面提示词和固定画幅会明确要求按镜头时间和已确认的主体图生成新片。请求和用量记录使用所选模型、分辨率和输出时长。默认使用 Seedance 2.5、720p 和原片向上取整的秒数。两种模式下标记为 `portrait` 的主体都须使用已确认的 Seedream 文生图原始产物。方舟因肖像审核拒绝上传原片后，对该片的后续编辑在提交前停止。分镜重拍按无输入视频的售价结算。

`redoSelected: true` 要求每个主体指定镜头且至少保留一个未选镜头。整段原片作为视频参考提交和计价。提示词使用原片时间码限定画面编辑范围，并要求模型保留其他镜头。此模式也可使用对白和配乐设置。入库重试沿用原供应商任务。

整片编辑可随替换规则保存 `sourceVideoAssetId`，使用与原片对应的[方舟已授权素材](https://docs.volcengine.com/docs/ark/seedance-portrait-asset-guide)。Harness 核对项目保存的原片引用，并以 `asset://<asset ID>` 提交参考视频。素材 ID 与原片引用、替换规则共同确定任务身份。方舟审核视频生成账号的素材访问权限，使用 Seedream 文生图原始产物时沿用生图账号。

Seedance 逐镜旁白、字幕、音乐和音效取自已保存的批次正文。Host 在提示词开头放一次旁白与字幕规则，随后加入全局风格和约束、批次正文及编号媒体用途。发给模型的提示词过滤场景来源备注和技术文件名。分镜说话人设置对应租户音色目录中当前可读的记录。共享音色不带空间 ID，私有音色须与项目空间一致。Host 实测所选 MP3 或 WAV 样音时长，以 `audio_url` 和 `reference_audio` 提交。每条样音至少 2 秒且不超过 15 MB。旁白样音和项目音频共用单次请求的时长上限，Seedance 2.0 为 15 秒，2.5 为 30 秒。音色无效、缺失或不可读时，在发出付费供应商请求前停止。已有任务刷新保留原参数。

Seedance 2.5 批次保存 `generation.trimVoiceSamples` 后，实测合计超过 30 秒时，Host 可将较长的旁白样音取开头片段并转为 WAV 提交。先计入项目和系统参考音频的完整时长，再为每段旁白样音留至少 2 秒。剩余时长不足时停止提交并报告实测合计时长。裁剪作用于供应商请求，源样音、参考编号和批次台词保留。

Seedream白底图使用所选pro/flash、明确尺寸与方舟账号池，付费同步调用前固定模型和尺寸。历史即梦4.0回执保留AK/SK恢复。已认证POST接口仍为`white-background/tasks`、`white-background/refresh`、`white-background/list`。提交需要当前空间项目和自有或可商用图片，无需采纳方案。Host单独生成JPEG参考图并附加优先保留商品可见细节的背景编辑要求：保留轮廓、比例、颜色、材质、文字、图案、按钮、接口和部件，移除无关背景物体，使用纯白背景并保留自然接触阴影，不编造配件或遮挡细节。默认保留原视角，仅在用户明确要求时使用多视角构图。这些提示词不能保证逐像素保真，生成后仍须对照原图检查再确认。原图保持不变。返回的单张图片经核验、上传后关联为生成的项目素材，保存原始素材来源；同空间其他项目可以复用。稳定请求编号恢复生成与上传进度，未知付费提交不自动重发。新用量记录的供应商为 `ark` 及所选模型；没有匹配的已发布价格时费用保持待计算。

-----

按用量计费从持久 assistant 事件采集已认证造物片场调用尝试，不增加模型消息。正常供应商用量（含阶段推荐）归属于提交用户和空间，供应商错误尝试和没有本轮用户操作的自动调用由平台承担。历史回执保留原费用归属。缺用量或价格保持待核对。视频回执先于下载保存 completion_tokens，不再加一次 total_tokens。图片和视频仅在项目入库后将客户费用标为可核对；Host 写入用量回执，平台数据助手更新积分。

用量字段 `customerCharge` 和 `gatewayCost` 保存两位小数的元／积分金额字符串，1元=1积分。每次调用先精确计算最终费用，再四舍五入到分；项目合计累加这些已取整金额。报价和工具消耗使用同一口径，单价仍可保留六位小数。读取历史 `shadow-billing-1` 回执时转换原微元金额，不重新计价，也不重新同步已完成历史记录；新回执使用 `usage-decimal-2`。

每次模型调用结束后自动向低代码用量表同步回执。已核算的客户费用在新增和更新时均写为 `chargeStatus=settled`；本地回执保留 `ready`，执行状态独立保存，`pending` 和 `waived` 费用状态保持原值。配置受限服务写入凭据时优先使用；它仅需读取租户身份、查询用量表以及新增/更新用量记录。未配置时，使用原发起人当前认证请求已有的权限，不额外保存用户 Token，账号变化时拒绝继续写入。权限或网络失败保留持久待同步回执。本轮结束后在后台补同步绑定空间和项目的待处理记录；已认证 POST billing/list 也会先补同步、重算待处理记录，再按每页50条返回当前空间的本地回执。billing/sync 显式执行同样的恢复，每次最多处理50条。回执和已核验会话绑定保存在 stateDirectory/billing。更新使用 PUT；创建响应丢失时按原事件键核对，不盲目再次创建。每个状态目录由一个 Host 独占，多写入端在财务使用前须补平台唯一键。

图片任务提交、列表和刷新响应在费用未确定前省略 `consumption.credits`，缺失的报价金额和价格版本也不返回。回执仍是 Agent 工具可接收的无损 JSON；费用待核对不会隐藏已接受任务，也不代表允许重复提交。

新回执保存 `billingMode=metered`，计费列表和同步响应返回 `mode=metered`。未记录模式的历史回执保留 `shadow`，不迁移已同步记录。视频供应商编号分别保存在任务 `id`、用量 `providerRequestId` 和素材 `generatedVideo.taskId`，与本地操作 `requestId` 分开。平台记录已为 `settled` 时，恢复只核对原金额、承担方、发起人及已提供的供应商编号，不再更新该行，避免再次触发扣分数据助手；不一致时保留待人工核对。

会话外的[参考视频拆解插件](../creation-studio-video-remake/README.zh.md)使用本包结算。计量模块先保存镜头切点、识别出的对白和用户确认的费用，再提交用量记录。计量模块核对积分流水中的实扣金额。没有关联扣款时，可核对已配置的空间余额更新节点，要求原用量单号、空间和金额一致且执行成功。核实的执行编号随原结果保存。查询原任务不会重跑拆解或再次写入用量。

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
- 字幕和朗读效果在生成后核对成片。Host 向 Seedance 提交批次正文与音色参考。
- 低代码记录创建接口没有事务性幂等键，创建响应丢失时需先核对平台再重试。

<a id="dev-note"></a>
### 开发备注

无。
