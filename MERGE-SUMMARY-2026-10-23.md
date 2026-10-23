# JDCloud Harness 代码合并记录

记录日期：2026 年 10 月 23 日。适用分支：`jdcloud-main`。本文记录本次合并处理、JDCloud 功能保留、运行问题修复及验证结果，供后续提交和维护时查阅。

## 合并结果与范围

本次处理以保留 JDCloud 业务代码和已有模型配置为前提，整合合入版本的启动、连接、设置和客户端组件实现。用户已确认最新页面可正常使用。

截至本文生成时，Git 没有未解决的冲突条目，但仍存在 `MERGE_HEAD`，合并提交尚未完成。当前大量合并内容已暂存；“冲突已处理”不等于“已提交、推送或发布”。本记录只覆盖本次排障和确认过的功能，不将整个暂存区的上游变更逐项列为本次新增功能。

## 保留的 JDCloud 功能与配置

| 范围 | 处理结果 |
| --- | --- |
| JDCloud 登录 | 保留登录页面、Host 认证控制器、认证状态及可选登录 bundle。 |
| 账号和租户 | 保留账号显示、租户列表、租户切换、退出登录及当前租户高亮。 |
| 权限控制 | 保留按当前租户管理员状态控制界面入口的逻辑；自动化入口仅管理员可见。 |
| 低代码功能 | 保留 JDCloud 低代码工具、功能选择和相关客户端展示。 |
| 产品品牌 | 保留 `JDCloud Harness` 品牌，没有为满足旧测试而替换品牌文案。 |
| 模型配置 | JDCloud 登录不覆盖已有默认提供商、模型和推理配置；已有 Session 保留持久模型选择。 |
| 对话与工作区 | 修复连接和工作区订阅，没有通过删除历史对话或重建用户数据来恢复页面。 |
| 租户与用户隔离 | 保留现有租户、用户范围；自动化任务的服务端访问继续校验所属 Session。 |

本次处理没有清空用户配置、凭据或历史 Session，也没有在文档中记录 API 密钥、登录 Token 或密码。

## 主要问题与修复

### 依赖安装失败

安装时曾出现 `ERR_PNPM_UNUSED_PATCH`，提示 `@earendil-works/pi-ai@1.1.0` 的补丁没有匹配到实际依赖。本次对齐了依赖、补丁声明与锁文件，安装随后成功。当前提供商包声明 `@earendil-works/pi-ai` 为 `^1.1.0`，工作区保留对应 `1.1.0` 补丁。

Windows 上出现的 Darwin、Linux 包 `Unsupported platform` 警告，以及从 C 盘 store 改用 D 盘 store 的硬链接警告，与此次补丁匹配错误是不同问题，不应将它们视为同一个安装失败原因。

### Web 启动缺少导出

CLI 启动时导入 `getDshRuntimeVersion`，但合并后的 app-boot 入口没有导出该函数，导致 ESM 在应用启动前报错。已恢复入口导出，并通过构建与实际 Web 启动验证。

相关代码：[app-boot 入口](packages/boot/app-boot/src/index.ts)、[CLI 入口](apps/cli/src/bin.ts)。

### 持续“重新连接中”与工作区对话不显示

浏览器 HTTP 请求使用 Bearer 会话，而原生 WebSocket 建连不能沿用自定义 Authorization 请求头。本次补齐一次性 WebSocket 票据的申请、传递和 Host 接纳流程，并调整鉴权处理顺序，恢复事件流与工作区数据订阅。

已通过真实 HTTP 与 WebSocket 冒烟验证票据握手、事件流就绪、工作区初始数据及票据不可复用。该修复恢复的是数据连接，没有迁移或重写历史对话。

相关代码：[浏览器会话](packages/client/connection/src/client/browser-session.ts)、[Host 浏览器会话](packages/client/connection/src/browser-session.ts)、[RPC Host](packages/client/connection/src/rpc-host.ts)。

### “更多”入口与管理员功能

侧边栏原“更多”入口改为“设置”图标和文字。点击该设置入口直接打开设置窗口，取消中间菜单；展开、折叠侧边栏及中英文界面都有对应测试。已登录 DeepSeek 账号的头像菜单仍承担账号操作，JDCloud 的账号与租户操作保留在上方账号入口。

自动化入口仅管理员可见；切换租户后重新应用相应权限状态。服务端任务访问校验与界面入口隐藏分别保留，避免只靠前端展示限制访问。

相关代码：[设置入口](packages/client/ui-settings-account/src/client/AccountMenu.tsx)、[JDCloud 界面挂载](packages/client/ui-jdcloud-login/src/client/mount.ts)。

### 模型设置页只有说明、没有输入表单

模型页遇到账号模型提供商时会读取 Session 模型目录，但插件漏声明 `remote.session` 服务依赖，实际运行时加载停住。已补齐依赖声明，恢复提供商编辑和 API 密钥输入。

浏览器回归验证了直接打开设置、进入模型页、选择提供商、输入密钥，以及取消编辑后 Host 配置文件内容保持不变。测试只使用隔离的临时配置，没有修改用户实际模型配置。

相关代码：[模型设置插件入口](packages/client/ui-settings-models/src/client/index.ts)、[模型设置浏览器测试](apps/web/tests/models-settings.e2e.ts)。

### 切换租户菜单背景透明

租户菜单局部覆盖公共菜单材质，改用当前主题的不透明基础背景，不影响其他菜单。另修正滚动容器选择器，使租户列表在 240 像素范围内滚动，退出登录区域保持独立。

真实浏览器已分别验证浅色、深色主题下菜单背景不透明。

相关代码：[租户菜单样式](packages/client/ui-jdcloud-login/src/client/AccountSeat.module.css)、[租户菜单浏览器测试](apps/web/tests/jdcloud-ordinary-user.e2e.ts)。

## 验证记录

以下为本次修复阶段实际执行过的检查，不代表整个仓库测试全绿。文档交付时另检查了本文的本地链接，并重跑快速文档检查、完整文档检查与全仓 lint；遗留失败记录在下一节。

| 检查 | 观察结果 |
| --- | --- |
| 依赖安装 | `pnpm install --no-frozen-lockfile` 成功。 |
| 最终产物构建 | `pnpm run build:artifacts`：7 项通过。 |
| 最终聚合类型检查 | 紧随最终构建执行 `pnpm run build:check`：Host、Client 共 2 项通过。 |
| 设置、模型存储、模型组件与租户菜单单元测试 | 4 个测试文件、222 项通过。 |
| 模型目录依赖回归 | 选中的 2 项通过，其余 14 项未运行。 |
| 设置入口最终复测 | 61 项通过；与上面的单元测试有重叠，不累加计算。 |
| 最终浏览器回归 | 直接打开设置和模型密钥输入、深浅主题租户菜单共 2 项通过；名称过滤排除了其余 16 项。 |
| 客户端文案检查 | `verify-client-ui-i18n` 通过。 |
| 本次修改文件的定向 lint | 通过。 |
| 三组 README 中英文配对 | 账号设置、模型设置、JDCloud 登录配对检查通过。 |
| Git 检查 | 未解决冲突条目为空；暂存区和工作区差异的空白检查通过。 |
| 实际 Web 服务 | 在 `http://127.0.0.1:3080/` 启动，首页 HTTP 响应为 200。 |

最终浏览器回归所用命令如下；`DSH_SNAPSHOT` 在运行前设置为 `replay`，测试使用内置隔离环境。

```powershell
pnpm run test:web:built apps/web/tests/models-settings.e2e.ts apps/web/tests/jdcloud-ordinary-user.e2e.ts -t 'opens Settings directly|keeps the tenant menu opaque'
```

## 尚未解决的检查项

以下失败已记录，未通过删除断言、替换品牌或扩大本次修改范围来隐藏。功能验收通过不等于这些检查已经通过。

| 检查 | 已知失败或限制 |
| --- | --- |
| 全量 GUI 测试 | 当次运行 638 个文件通过、13 个文件失败；10814 项通过、25 项失败、2 项跳过。该结果属于修复过程中的全量基线，不是最终构建后的全量重跑。 |
| 模型设置插件完整注册测试 | 仍有旧 analytics 断言失败：期望触发 `api_key_save_click`，实际未调用。模型目录依赖的定向回归通过。 |
| 原模型页浏览器快照 | 首个失败为实际导航比旧快照多出“技能”项；此后依赖同一页面状态的用例产生连带失败，未认定整套模型编辑流程通过。 |
| 构建后启动快照 | 测试仍查找 `LSY-Agent`，页面实际为保留的 `JDCloud Harness`。 |
| 快速文档检查 | 最近一次 `test:docs` 为 12 项通过、9 项失败，涉及其他文档及生成内容。 |
| 完整文档检查 | 最近一次 `doc-sync` 为 20 项通过、23 项失败，涉及类型摘录、链接、翻译配对、目录生成、历史记录及文档预算等。 |
| 全仓 lint | 仍有此前检查发现的遗留问题；本次定向 lint 通过不能替代全仓通过。 |

## 后续合并注意事项

后续提交前应检查完整暂存区，因为它包含大量合入版本变更。本次没有代为创建合并提交、推送分支或发布版本。

再次合入其他版本时，应特别检查 app-boot 公开导出、浏览器 WebSocket 票据流程、JDCloud 登录对模型配置的影响、管理员入口策略，以及模型设置插件的服务依赖。保留用户配置和历史对话是这些检查的前提。

旧快照、analytics 断言和全仓文档问题应独立核对其当前产品行为后处理；不应直接以更新全部预期文件的方式消除失败。
