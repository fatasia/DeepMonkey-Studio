# 容器部署评估

0.2.0 应用镜像在一个 Node.js 24 进程中运行 API 和正式 Web，配套 PostgreSQL、MinIO 三服务 Compose。应用以普通用户、只读根文件系统运行，配置由 `.env` 注入，数据保存在三个持久卷。构建与离线镜像导入见代码包 `docs/docker-application.md`。

## 推荐的镜像边界

- 应用镜像：Node.js 24，包含 API 与 Web 正式产物；容器只读运行，配置从环境变量或 Secret 注入。
- PostgreSQL：使用上游固定主版本镜像，数据挂载独立卷。
- MinIO：使用上游固定版本镜像，数据与管理凭据独立保存。
- 反向代理：部署者可选择 Caddy、Nginx 或平台网关；TLS 不写进应用镜像。

启动时叠加 `docker-compose.yml`、`docker-compose.app.yml`，用 `docker compose -f docker-compose.yml -f docker-compose.app.yml up -d`；三个服务 healthy 后访问 `http://localhost:4100`。自定义端口同时设置 `STUDIO_PORT` 与 `STUDIO_PUBLIC_ORIGIN`。API 首次启动自动初始化数据库表和 MinIO Bucket。

## 发行合同

1. 在干净 Linux runner 固定 Node、pnpm、依赖锁文件和构建产物，生成可追溯 tag 与 SBOM。
2. 提供 `.env.example`、随机 Secret 初始化、首次数据库迁移和 MinIO Bucket 初始化；启动命令不能使用默认管理员密码。
3. 应用 `/api/meta`、PostgreSQL 与 MinIO 使用各自健康检查；应用依赖两个存储服务健康，初始化失败保留可读日志。
4. 定义 PostgreSQL 与 MinIO 的一致性备份、恢复演练、升级和回滚顺序；镜像升级不能删除卷。
5. 在 Linux clean clone 上验证登录、项目、素材、保存、发布和重启恢复，并将结果写入发布证据。

## 更新与边界

更新前备份三个数据卷，导入新镜像并更新 `STUDIO_VERSION`。回滚恢复旧 tag，保留卷；`down -v` 会删除数据。GPU Native 窗口、Windows 桌面与平台 Worker 使用各自交付物，能力检查报告当前平台可用项。HTTPS、域名、网关、监控与多节点编排由部署环境配置；备份与恢复见[部署与系统运维](/docs/deployment-operations)。

## 用户选择

- 只体验编辑器：源码安装后使用本地 JSON 与本地对象存储，不需要 Docker。
- 单机自托管：优先使用固定版本 Compose，持久化 PostgreSQL、MinIO 和上传目录。
- 企业生产：使用原生部署或企业编排平台，明确注入 Secret、TLS、备份和审计策略。
