# Agent Note: 移除内测声明

Status: implemented

[English](2026-09-15-remove-internal-testing-notice.md) | 中文

## Problem

Web Client 会在展示有实际操作价值的 DeepSeek 凭据配置之前，用一份版本化内测声明阻塞每个新的浏览器 profile。该声明把产品描述为开发者测试阶段，即使部署已经提供自己的登录和发布说明，用户仍需确认。

## Decision

Web Client 不注册或渲染内测声明。Settings 外壳继续按顺序协调功能包贡献的引导步骤；之后移除 DeepSeek 凭据步骤的决定由[远程 Web 部署由服务器管理模型](../bug-fix/2026-09-15-server-managed-models-for-remote-web.zh.md)记录。

被移除的声明不再拥有确认状态 store 或本地化文案。没有剩余功能读取 `ui-onboarding.welcomeNoticeVersion`，因此 `ui-settings-general` 的 Host 入口不执行行为；既有 settings 文档可以保留这个未知字段，不提供兼容行为。

浏览器测试验证应用打开时不显示该声明。专用于远程欢迎声明的场景和 welcome golden 已移除，preview boot 与 stress lane 也不再关闭或隐藏该声明。

## Alternatives considered

**只在 JDCloud Docker overlay 中禁用声明。** 未采用，因为内测声明在其他发布部署中同样不是有用的产品行为，而且仅限部署的开关会保留组件、持久化字段、翻译和测试，只为在此处隐藏它们。

**为兼容保留确认字段。** 未采用，因为当前没有消费方读取它，且用户设置可以容纳既有的未知 section，无需迁移或回退路径。

**把声明替换为更短的欢迎消息。** 未采用，因为需求是移除强制声明，而且发布部署已经提供自己的入口说明。

## Consequences

新用户无需确认产品阶段文案即可进入 JDCloud 登录或应用。代码库移除了声明组件、状态 controller、持久化 settings namespace、本地化字符串、专用远程行为及其测试。通用 onboarding 账本仍可承载功能包自己的流程；如果将来恢复产品公告，需要新的当前需求、文案 owner、完成策略和浏览器覆盖。
