# 容器部署评估

当前官方运行入口仍是 `pnpm studio` 的原生部署；Docker 镜像和 Compose 只在全部核心能力、全量测试与发布验证完成后按单独指令制作。容器化可以作为开源用户的一键启动方式，但必须先固定镜像、数据卷、健康检查、迁移和备份合同。

## 推荐的镜像边界

- **应用镜像**：Node.js 24，包含 API 与 Web 正式产物；容器只读运行，配置从环境变量或 Secret 注入。
- **PostgreSQL**：使用上游固定主版本镜像，数据挂载独立卷。
- **MinIO**：使用上游固定版本镜像，数据与管理凭据独立保存。
- **反向代理**：部署者可选择 Caddy、Nginx 或平台网关；TLS 不写进应用镜像。

首个 Docker Compose 交付建议保持三项服务（应用、PostgreSQL、MinIO），本地零基础设施模式仍由 `pnpm studio start web` 提供。Revit、DWG、云渲染和实时视频是可选外部 Worker，不塞进基础镜像。

## 一键部署需要补齐的工作

1. 在干净 Linux runner 固定 Node、pnpm、依赖锁文件和构建产物，生成可追溯 tag 与 SBOM。
2. 提供 `.env.example`、随机 Secret 初始化、首次数据库迁移和 MinIO Bucket 初始化；启动命令不能使用默认管理员密码。
3. 为 `/health`、数据库、对象存储和迁移失败分别提供健康检查与可读日志；应用未准备好时 Compose 不应报告成功。
4. 定义 PostgreSQL 与 MinIO 的一致性备份、恢复演练、升级和回滚顺序；镜像升级不能删除卷。
5. 在 Linux clean clone 上验证登录、项目、素材、保存、发布和重启恢复，并将结果写入发布证据。

## 目前的工作量判断

单机 Compose 入口预计属于中等工作量：镜像构建、PostgreSQL、MinIO、健康检查、持久化卷、备份恢复和 clean Linux 验证。把它提升为多节点、TLS、备份编排、监控和升级服务仍是独立交付项目；生产部署的原生步骤和边界见[从零开发与原生部署](/docs/deployment-operations)。

## 用户选择

- 只体验编辑器：源码安装后使用本地 JSON 与本地对象存储，不需要 Docker。
- 单机自托管：优先使用固定版本 Compose，持久化 PostgreSQL、MinIO 和上传目录。
- 企业生产：使用原生部署或企业编排平台，明确注入 Secret、TLS、备份和审计策略。
