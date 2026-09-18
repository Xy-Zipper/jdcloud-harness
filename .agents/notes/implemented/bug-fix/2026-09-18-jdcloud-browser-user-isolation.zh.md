# Agent Note: JDCloud 浏览器与租户用户隔离

Status: implemented

[English](2026-09-18-jdcloud-browser-user-isolation.md) | 中文

## Problem

JDCloud 登录凭据原本保存在一个进程级全局键下，因此第二台电脑会继承第一台浏览器的 token，不登录也能读取相同的 Session 和 Workspace 投影。部署又关闭了 Harness 浏览器认证，Host 没有请求级身份可用于授权。

## Decision

Connection 部署可以在保持 Harness 启动令牌认证关闭的同时，签发独立的签名 HttpOnly `dsh-user-session` cookie。RPC 和 Fetch 处理器通过 AsyncLocalStorage 传递浏览器身份。JDCloud 登录凭据按浏览器 ID 分键保存，新归属记录由规范化服务地址、租户 ID 和 `userInfo.id` 计算确定性哈希；旧的无归属记录会被忽略。

Session 列表、搜索、历史和 Workspace 命令及初始基线会检查当前租户用户归属。交互式终端操作要求当前 JDCloud 登录具有系统管理员权限。浏览器 cookie 只作为传输身份，不会暴露 JDCloud bearer token。

## Alternatives considered

**继续使用进程级共享的 JDCloud 登录记录。** 未采用，因为另一台电脑可以继承 token，在未登录的情况下访问第一台电脑的数据。

**改为启用 Harness 浏览器认证。** 未采用，因为本部署明确使用不带 Harness 浏览器认证的 JDCloud 登录；独立 cookie 只补充请求级浏览器身份。

**迁移现有未归属记录。** 未采用，因为这些记录没有可靠的租户用户归属，迁移可能把历史数据暴露给错误账号。

## Consequences

不同浏览器必须分别登录。同一租户和 `userInfo.id` 在不同电脑登录后可共享新创建的数据。没有归属的旧数据不会迁移。实时控制广播及其他 Host 表面仍需要继续过滤，完成后才能宣称完全保密隔离。
