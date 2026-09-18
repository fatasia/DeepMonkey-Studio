# 文档索引

从安装、制作场景到发布交付，按当前任务选择入口。应用内 `/docs` 提供离线图文指南。

## 使用产品

| 任务 | 阅读入口 |
| --- | --- |
| 安装并启动 | [首次启动](../apps/web/src/docs/getting-started.md)、[完整部署指南](native-deployment.md) |
| 理解平台 | [总体架构](platform-architecture.md)、[项目与版本](../apps/web/src/docs/core-concepts.md)、[功能清单](capabilities.md) |
| 创建应用 | [首个场景](../apps/web/src/docs/dashboard-scene.md)、[模型导入](../apps/web/src/docs/model-import.md) |
| 连接数据与 AI | [数据中心](../apps/web/src/docs/data-pipeline.md)、[视觉 AI](vision-quickstart.md) |
| 发布与恢复 | [发布指南](../apps/web/src/docs/server-publish.md)、[故障恢复](../apps/web/src/docs/troubleshooting.md)、[常见问题](../apps/web/src/docs/faq.md) |

## 三维格式接入设计

[七方向三维格式工作计划](specs/industrial-3d-format-work-plan-2026-09-16.md)是统一执行入口，先看依赖边界、阶段和验收门槛；
[七方向内置接入总方案](specs/jt-xt-rvt-offline-integration-plan-2026-09-16.md)涵盖 JT、X_T、RVT 与四类扩展；[点云、3D Tiles、3DM、SolidWorks 接入细案](specs/additional-four-formats-integration-plan-2026-09-16.md)列出追加任务与验收，[格式价值排序](specs/high-value-3d-formats-2026-09-16.md)说明后续投资建议。以上为设计文档，实际已支持能力仍以[格式支持说明](converter-plugin-and-format-support.md)为准。
