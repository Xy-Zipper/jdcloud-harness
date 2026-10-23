---
description: "Web Client 的 JDCloud 登录、账号控制与部署可配置品牌。"
kind: "package-reference"
---

# JDCloud Login UI

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-client-ui-jdcloud-login` 在 Host 没有已保存登录时提供 JDCloud 账号密码登录页和 Token 中转登录页，在已登录时提供账号摘要，并在 Web 外壳中呈现部署配置的产品名称。它自行挂载生成的 JDCloud Remote contribution，因此通用 API Remote assembly 不需要依赖这个可选集成。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

通过 [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.zh.md) bundle 安装。本页面要求填写服务地址、账号和密码。初始服务地址来自 Host controller 的脱敏状态，bundle 可以通过 `JDCLOUD_DEFAULT_BASE_URL` 提供默认值。

页面以 priority `-100` 占用 `root`。登录成功后，该 contribution 被移除，已经挂载的应用重新显示，不替换 Session 状态。当 Host 因 `600`、`601` 或 `602` 校验响应删除 JDCloud credential record 时，转发的 `credentials/record-updated` 事件会恢复登录页。被拒绝的对话草稿仍留在 Client 状态中，重新登录后不会自动提交。

`GET /login/transfer?token=...&baseUrl=...` 会返回一个禁止缓存的跳板文档，再把内部参数放入 URL fragment，并发起同源导航进入 Web 外壳。fragment 可确保 JDCloud Token 不进入根路径 HTTP 请求和子资源 Referer。该文档默认拒绝 iframe 嵌入；`transferFrameAncestorOrigin` 接受一个准确的 HTTP(S) 父页面 origin，也可使用 `*` 允许全部父页面。通配符允许任意网站实施点击劫持，因此必须由部署显式配置。JDCloud bundle 选择 Connection 的 Bearer 浏览器会话载体，因此跨站 iframe 可以通过同源 HTTP 请求初始化标签页范围内的身份，不依赖第三方 cookie 或 HTTPS；明文 HTTP 仍会向网络观察者和中间节点暴露该 bearer 凭证。Client 随即把地址栏替换为 `/login/transfer`。priority 为 `-110` 的 root contribution 只调用一次 `loginWithToken()`；成功后显示应用，失败后显示本地化恢复页。选择恢复操作会关闭中转页并显示账号密码登录。原始 JDCloud Token 校验后只归 Host 所有，不写入浏览器存储；单独的 Harness 浏览器会话 token 存放在当前标签页的 `sessionStorage` 中。

登录后，本包会占用 `sidebar.account`。展开侧边栏时显示 Host 返回的账号和当前租户，折叠轨道只显示账号图标。账号菜单使用匹配当前主题的不透明背景，列出全部自有与加入租户，高亮当前租户，并通过 `GET /api/system/corp/switchCorp/{corpId}` 切换到其他租户而不显示登录页。租户行在 240 像素高的区域内滚动，“退出登录”保持固定。切换失败时保留当前租户，并在菜单中显示错误。选择“退出登录”会删除 Host credential 并恢复登录页。

认证状态还携带 `systemAdministrator`。非管理员会以 priority `-100` 覆盖 `sidebar.settings`、`conversation.input.model`、`conversation.input.permission` 和 `conversation.hero.agentPreset`，拒绝 `/model` 与 `/permission`，隐藏插件与自动化面板，并从引导页、渲染、恢复和浏览器直接导航中过滤 `terminal` 标签页类型。新 Session 使用部署的权限默认值，不再接受 JDCloud 专用覆盖。切换租户会立即重新应用仅限管理员的控件策略。管理员可看到底层控件。已有 Session 保留其持久模型与权限选择。

本包还以优先级 `-10` 填充 `sidebar.brand.mark`、`sidebar.brand.name` 与 `conversation.hero.brand.mark`。蓝青渐变的六边形 J 标志遵循各宿主请求的尺寸，登录页复用同一图形。登录页标签与侧栏名称读取构建期 `DSH_CLIENT_TITLE`，未配置时回退为 `LSY-Agent`；Docker Compose 会把 `JDCLOUD_PRODUCT_NAME` 传入该变量。这些 single slot 选择更低优先级的填充，因此插件激活时 JDCloud 品牌会替换通用或官方品牌，卸载时自动恢复原填充。

密码只保存在组件本地 state 中，成功后清空，永不进入共享 store。所有产品文案归 `jdcloud.login` locale namespace 所有。

<a id="model-experience"></a>
## 模型体验

无，因为本包只控制浏览器呈现并调用 Host 认证方法。

#### KV Cache 影响

无。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 中转链接控制接收其 Token 的 HTTP(S) 服务地址；Host controller 不校验目的地址白名单。
- 不会自动重试因认证校验被拒绝的 Prompt。
- 管理员控件属于浏览器呈现策略，不是 Host 授权。能够直接调用 Host endpoint 的客户端可以绕过这些控件，Agent 工具仍拥有 Session 实际权限 preset 提供的访问能力。

<a id="dev-note"></a>
### 开发备注

无。

**运行时不变式：** 不发布伴生入口。生成的 Remote mount、root 登录 contribution、侧边栏账号 contribution、管理员控件覆盖、命令过滤器与品牌填充共用同一个插件生命周期，并会一起卸载。
