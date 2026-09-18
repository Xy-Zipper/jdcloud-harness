# Agent Note: JDCloud 普通用户浏览器控件

Status: implemented

[English](2026-09-17-jdcloud-ordinary-user-browser-controls.md) | 中文

## Problem

JDCloud 认证会把 `systemAdministrator` 提供给 Web 客户端，但普通用户仍可打开交互式终端并选择 Session 权限 preset。终端 UI 可以删除容器文件，而 `danger-full-access` 可以移除 Agent 命令的 sandbox。只隐藏一个终端按钮并不充分，因为引导入口、保留终端恢复、已有标签页渲染和侧栏直接导航是相互独立的浏览器路径。

## Decision

JDCloud 登录 UI 根据当前已认证租户应用一项可撤销的普通用户策略。它用已有管理员控件覆盖权限选择器，在拒绝 `/model` 的同时拒绝 `/permission`，并从右侧栏注册表中过滤 `terminal` 页面 kind。切换租户时会更新同一策略，无需重新挂载应用。

右侧栏注册表拥有通用的 `registerAvailabilityFilter()` 操作。被过滤的 kind 不会出现在引导入口、注册表查询、渲染分派和浏览器直接导航中，但底层类型注册仍保持挂载。终端恢复在查询或重新打开保留进程之前，也会检查当前注册表结果。

浏览器策略会在普通用户认证后注册有序的新 Session 初始化器。在复用或新建的空白 Session 打开前，它执行 `/permission workspace-write`；命令失败或命令不可用时会阻止导航。管理员不会注册该初始化器。该策略不会改写已有 Session 的持久权限选择，不会授权 Host endpoint，也不会限制 Agent 工具。它是浏览器工作流限制，不是安全隔离；需要保密或防篡改的部署必须实施已认证的 Host 授权以及进程和文件系统隔离。

## Alternatives considered

**从 JDCloud bundle 移除终端插件。** 未采用，因为管理员仍需要终端，而且租户变化必须能在不重启 Client graph 的情况下更新访问权限。

**只覆盖终端引导卡片。** 未采用，因为保留终端恢复、已有布局记录和程序化 `openTab('terminal')` 仍可使用。

**把 JDCloud Login 视为 Host 授权。** 本次修改未采用，因为 Docker 组合禁用了 Harness 浏览器认证，并且已存储的 JDCloud 登录是 Host 全局状态。安全的逐用户策略需要独立的传输身份与授权设计，而不是浏览器过滤器。

## Consequences

普通用户无法通过受支持的 Web UI 选择权限，也无法打开、渲染或恢复终端标签页。管理员保留这些控件，切换租户时会立即更新。聚焦的 Client 测试覆盖注册过滤、普通用户与管理员切换、卸载和终端恢复。直接 Host 调用与 Agent 访问不属于该策略，并作为部署限制记录。
