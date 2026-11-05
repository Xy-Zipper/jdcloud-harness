---
kind: upgrade-guide
description: "造物片场新生图请求改用 Seedream，支持两个模型 ID，最多十张参考图。"
---

# 造物片场生图使用 Seedream 与私有账号池

[English](guide.md) | 中文

## 变更

造物片场新生图请求通过方舟使用 Seedream 5.0 pro 或 flash。`imageModel` 接受 `doubao-seedream-5-0-pro-260628` 或 `doubao-seedream-5-0-flash-260915`，默认 pro。生图规划和工具接受 `model`，参考图最多十张。生图支持8种比例及1K/1.5K/2K像素尺寸，`images/quote`按已发布像素档和参考输入价报价，不调用供应商。新白底图也使用同一组Seedream模型，旧即梦任务保留原恢复流程。Host 任务接口保留，但 Seedream 在 Host 持有的后台任务中执行，不再创建远端异步 GPT 任务。未知或中断的提交不会自动重发。已有 GPT 任务回执保留原查询和重试实现。

## 迁移

1. 同时更新造物片场前端、分镜和生图两个 Skill ZIP，以及 JDCloud Harness 部署。将 `cordis.yml` 或覆盖配置中显式的 GPT `imageModel` 改为支持的 Seedream ID。
2. 在仅管理员可访问的账号池表 `6aead43ac3ca9f3dcdaf4b23` 维护凭据。在 `models` 勾选 `Doubao-Seedream-5.0-flash` 等具体模型名，保存值为完整API模型ID；保留渠道元数据供路由使用，不为共用额度的同Key按模型重复建行。`CREATION_STUDIO_ACCOUNT_POOL_USERNAME` 和 `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` 使用专用租户服务账号密码，仅允许读取租户身份和私有账号表。Host 将 Token 缓存在内存中，过期后重新登录一次，无需固定 Token。不要向普通调用者授权此表。保留唯一账号编号、适用的 `scenarios`、`enabled` 和正整数 `maxConcurrent`。
3. 保留完整 `stateDirectory`，包括 `provider-calls`，每个目录由一个 Host 独占。旧 GPT 任务结束前保留原凭据。未配置账号池读取凭据时，现有方舟和即梦环境密钥以编号单账号继续使用；配置后，账号池读取失败不会回退。
4. 用选定模型提交一张测试图片，核对返回的 `providerAccountRef`、生成项目素材和用量记录。提供匹配的已发布方舟/Seedream 售价，旧 GPT 售价不适用。核对视频和白底图查询保持原账号。失败和并发额度语义见[媒体包](../../../../packages/jdcloud/creation-studio-media/README.zh.md)。
