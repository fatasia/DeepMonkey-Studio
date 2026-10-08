# 文档索引

从安装、制作场景到发布交付，按当前任务选择入口。应用内 `/docs` 提供离线图文指南，正文在 `apps/web/src/docs`，GitHub Wiki 是它的导出镜像。

## 使用产品

按下面的顺序读，就是一条从零到交付的路线。

| 任务 | 阅读入口 |
| --- | --- |
| 安装并启动 | [安装与首次启动](../apps/web/src/docs/getting-started.md)、[完整部署指南](native-deployment.md) |
| 理解平台 | [项目、资源与发布版本](../apps/web/src/docs/core-concepts.md)、[运行方式与扩展](../apps/web/src/docs/runtime-and-extensions.md)、[总体架构](platform-architecture.md)、[功能清单](capabilities.md) |
| 做出第一个场景 | [从项目到首个可发布场景](../apps/web/src/docs/dashboard-scene.md) |
| 管理资源、导入模型 | [管理资源并插入 2D / 3D](../apps/web/src/docs/resource-workflow.md)、[模型导入与格式选择](../apps/web/src/docs/model-import.md)、[格式支持说明](converter-plugin-and-format-support.md)、[内置 profile 登记表](builtin-profiles.md) |
| 三维效果与出图 | [三维效果、环境与物理光照出图](../apps/web/src/docs/scene-effects-rendering.md)（根运动、火焰粒子、体积雾、固定步长、物理光照出图） |
| 连接数据 | [连接数据、处理逻辑并发布接口](../apps/web/src/docs/data-pipeline.md) |
| 使用 AI | [AI 助手与视觉能力](../apps/web/src/docs/ai-workflows.md)、[视觉 AI 上手](vision-quickstart.md) |
| 发布与交付 | [预览、体检与发布](../apps/web/src/docs/server-publish.md) |
| 排障 | [交付自检与故障恢复](../apps/web/src/docs/troubleshooting.md)、[常见问题](../apps/web/src/docs/faq.md) |
| 浏览器在线体验 | [工作台与本地保存](guides/online-browser.md) |
| 本地 HTTPS | [开发证书与启动](local-https.md) |
| Docker / Compose 一键启动 | [应用镜像与离线启动包](docker-application.md) |

## 渲染引擎与 SDK

| 任务 | 阅读入口 |
| --- | --- |
| 切换渲染器、构建客户端 | [Deep Engine](../apps/web/src/docs/deep-engine.md) |
| 在自己的网页里接入引擎 | [Deep Engine 独立 SDK](../apps/web/src/docs/deep-engine-sdk.md) |
| 用 Codex / Claude 开发、连接 MCP | [Skill、MCP 与 SDK 接入教程](ai-development.md) |
| 脚本与 HTTP API | [SDK 与 API 总览](../apps/web/src/docs/sdk-api-overview.md) |
| 性能与画质结论、Three 与 Deep 一致性门 | [引擎性能与画质基准](../apps/web/src/docs/engine-benchmarks.md) |

## 三维格式与插件

格式解析边界、离线限制和当前支持范围见[格式支持说明](converter-plugin-and-format-support.md)。
插件运行时和扩展入口见[插件运行时基础](plugin-runtime-foundation.md)；产线流程扩展见[工厂流程插件](factory-flow-plugin.md)。

## 维护文档

| 任务 | 阅读入口 |
| --- | --- |
| 修改产品文档、同步 Wiki | [Wiki 镜像说明](wiki-mirroring.md)（文档中心是唯一事实源，Wiki 只做导出） |
| 了解写作与渲染约束 | [开发与贡献](../apps/web/src/docs/contributing.md#修改产品文档) |
| 查看最近一次文档审计 | [文档中心审计记录](specs/docs-center-audit-20261003.md) |
