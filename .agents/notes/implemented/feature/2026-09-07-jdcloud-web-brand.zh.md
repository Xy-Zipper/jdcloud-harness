# Agent Note: JDCloud Web 品牌覆盖

Status: implemented

[English](2026-09-07-jdcloud-web-brand.md) | 中文

## 问题

JDCloud 认证 layer 在登录后仍显示 DeepSeek 鱼形标志、通用本地构建名称、浏览器标题和 favicon。修改 package 名称、npm scope、CLI 命令或内部产品身份会增加与上游的差异，却不能改善低代码用户的浏览器体验。

## 决策

JDCloud 登录 Client 插件拥有一枚蓝青渐变的六边形 J 标志和 `JDCloud Harness` 显示名称。它把标志注册到 `sidebar.brand.mark` 与 `conversation.hero.brand.mark`，把名称注册到 `sidebar.brand.name`，并在登录页复用同一标志。每个 single slot 注册使用优先级 `-10`，因此 JDCloud 插件激活时会覆盖通用或官方填充，插件移除时会恢复原填充。

Web 外壳将默认 document title、本地化本地构建名称、PWA 名称、短名称和 SVG favicon 设为 JDCloud Harness。Session 标题保留现有的 `<session> — <product>` 投影。favicon 使用与 React 标志相同的几何图形，并为深色配色调整蓝青色调。

Package 名称、`@deepseek-ai` npm scope、`dsh` 命令、构建环境变量名称、仓库元数据和模型可见的 DeepSeek Harness 身份保持不变。official 构建 profile 也保留显式的 DeepSeek Harness 标题；本 fork 的默认 Web 资源与可选 JDCloud bundle 提供公司品牌。

## 备选方案

**重命名全部 package 与内部身份。** 否决，因为浏览器品牌不需要在 package 解析、命令、持久化路径、Prompt 或上游文档上进行仓库级分叉。

**替换共享 FishLogo primitive。** 否决，因为该 primitive 是通用与官方回退；修改它会把 JDCloud 图形耦合到所有消费者，并增加上游合并难度。

**创建独立品牌 package。** 否决，因为登录 bundle 已经是 JDCloud 用户的部署边界。增加 package 与 bundle row 会引入额外安装和生命周期复杂度，却没有独立复用价值。

## 后果

安装 JDCloud 登录 bundle 会在同一生命周期内改变登录页、展开与折叠侧边栏标志、空会话标志和侧边栏名称。删除 bundle 会恢复底层 slot 填充，而 Web 外壳的静态标题和 PWA 资源仍作为本 fork 的 JDCloud 默认值。

SVG 标志存在两个需要维护的形式：插件 slot 使用的 React 组件，以及 Client 插件加载前使用的静态 favicon。测试固定它们的共用识别几何、请求尺寸、slot 优先级、生命周期卸载、标题回退与 PWA 元数据。
