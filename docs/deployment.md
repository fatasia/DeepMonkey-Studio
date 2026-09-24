# Docker Compose 部署

本文档描述仓库根 `docker-compose.yml` 的一键交付:PostgreSQL + MinIO 存储基础设施(持久卷、健康检查、固定镜像)。裸机生产部署、systemd 托管、HTTPS 与回滚见[从零开发与原生部署](native-deployment.md);镜像边界评估见[容器部署评估](../apps/web/src/docs/container-deployment.md)。

## 覆盖范围(先读)

- **只交付基础设施**:Compose 内只有 PostgreSQL 与 MinIO 两个服务。应用本体(Web/API/桌面客户端)当前没有官方镜像,仍然按原生方式运行:`pnpm studio start`(开发)或 `pnpm studio deploy`(Linux 生产)。不要把未验证的临时应用镜像用于生产。
- **不包含反向代理(nginx/caddy)**:HTTPS 终结、域名与统一入口属于部署环境职责,由宿主网关或云负载均衡承担;Compose 只暴露 PostgreSQL 与 MinIO 端口。未来做 SaaS 多实例统一入口时另行立项(倾向 caddy 自动 HTTPS)。
- **MinIO 镜像来源(2025-10-23 起)**:MinIO 官方已停止发布社区版 Docker 镜像,`minio/minio` 的全部 tag(含历史 tag)已从 Docker Hub 与 quay.io 移除,不可再拉取。本仓库改用 Bitnami legacy 快照并以 **digest 固定**(`APP_VERSION=2025.5.24`,即 MinIO RELEASE.2025-05-24),保证可复现拉取;该快照不再获得更新,升级需评估自行构建或商业支持,见下方"升级注意"。注意 Bitnami 镜像数据目录为 `/bitnami/minio`(非官方 `/data`),Compose 已适配。
- **存储拓扑固定**:生产为 PostgreSQL + MinIO;单机开发仍推荐 SQLite + 本地对象目录,不要求 Docker。多实例生产必须使用 PostgreSQL + MinIO。
- **凭据只经 `.env` 注入**:Compose 从仓库根 `.env` 读取全部密码与密钥;真实 `.env` 已被 `.gitignore` 忽略,严禁把真实凭据写入任何仓库文件。后台管理账号约定保持 `BIM_STUDIO_ADMIN_PASSWORD=admin` 默认值,生产环境应在 `.env` 中改为强密码。

## 1. 环境要求

- Docker Engine 与 Compose v2+ 插件(`docker compose version`)。
- Node.js 24、Corepack、pnpm 11.18(用于运行应用与初始化系统元数据)。
- PostgreSQL 模式初始化需要 `psql` 可执行文件:Linux 安装 `postgresql-client`(或使用容器内 `docker compose exec postgres psql` 手工操作);Windows 按 `.env` 的 `POSTGRES_PSQL_PATH` 指向本机安装。

## 2. 一键启动

```bash
cp .env.example .env
# 编辑 .env,至少设置:
#   POSTGRES_PASSWORD=<强密码>
#   MINIO_ROOT_USER / MINIO_ROOT_PASSWORD=<强密码,至少 8 字符>
#   并把 MINIO_ACCESS_KEY/MINIO_SECRET_KEY 设为与 MINIO_ROOT_* 完全一致
# 生产/多实例再设置:
#   METADATA_STORE=postgres
#   OBJECT_STORE=minio
docker compose up -d
docker compose ps        # postgres 与 minio 状态均应为 healthy
```

镜像固定(`postgres:18-alpine` 主版本 tag;MinIO 为 Bitnami legacy digest 固定快照,原因见"覆盖范围"),数据写入显式命名的卷 `bim_studio_postgres_data`、`bim_studio_minio_data`,不随项目名或目录名漂移。默认只暴露 `POSTGRES_PORT`、`MINIO_API_PORT`(9000)与 `MINIO_CONSOLE_PORT`(9001)。

## 3. 初始化系统元数据

基础设施 healthy 后,初始化数据库表和 MinIO Bucket 并导入无密钥开源种子:

```bash
pnpm install --frozen-lockfile
pnpm run init
```

`pnpm run init` 读取 `.env` 的 `METADATA_STORE` 与 `OBJECT_STORE`:PostgreSQL 模式自动创建数据库与 `bim_studio_state` 表;MinIO 模式首次启动会创建缺失的 Bucket。种子内容与边界见[开源数据库交付](open-source-database-seed.md)。只准备数据不启动服务时加 `--prepare-only`;只有明确要重置数据库时才使用 `--force`(先备份)。

## 4. 健康检查

```bash
docker compose ps                                    # 两服务均 healthy
docker compose exec postgres pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DATABASE:-bim_studio}"
curl -fsS http://127.0.0.1:9000/minio/health/live    # MinIO 存活探针
pnpm studio check                                    # 应用级:验证 API 到 PG/MinIO 的真实连通
```

容器内置健康检查:PostgreSQL 使用 `pg_isready`,MinIO 使用 `mc ready local`; unhealthy 时 `docker compose logs postgres|minio` 查看原因。

## 5. 备份与恢复

正式备份优先使用仓库脚本(一致性顺序、清单与回读校验由脚本保证,细节见 `native-deployment.md` 第 8 节):

```bash
pnpm backup:production     # 同时覆盖 PostgreSQL 与 MinIO,先停写入
pnpm verify:restore        # 用临时库和临时 Bucket 回读校验,不碰生产数据
pnpm restore:production    # 恢复是破坏性操作,必须 --confirm 匹配 backupId
```

容器场景的手动备份(应急/补充):

```bash
# 停止写入(停掉应用进程),然后:
docker compose exec -T postgres pg_dump -Fc -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DATABASE:-bim_studio}" > postgres.dump
docker run --rm -v bim_studio_minio_data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/minio-data.tar.gz -C /data .

# 恢复(保持服务停止):
docker compose exec -T postgres pg_restore --clean --if-exists -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DATABASE:-bim_studio}" < postgres.dump
docker run --rm -v bim_studio_minio_data:/data -v "$PWD:/backup" alpine \
  sh -c "cd /data && tar xzf /backup/minio-data.tar.gz"
```

## 6. 升级注意

1. 升级前完成一致性备份并执行 `pnpm verify:restore`,记录当前 Git tag 与镜像 tag。
2. `docker compose down` **不会**删除数据卷;`docker compose down -v` 会删除全部数据,严禁随手执行。
3. PostgreSQL 只能升级小版本 tag(如 `18-alpine` 内补丁版);跨大版本(18 → 19)不能直接换 tag,必须走 `pg_dump`/`pg_restore` 或 `pg_upgrade`,否则数据目录不兼容、服务拒绝启动。
4. MinIO 升级替换 RELEASE tag 一般可直接 `docker compose up -d`;回退 MinIO 版本前确认元数据格式兼容。
5. 升级后按第 4 节完整过一遍健康检查与应用级 `pnpm studio check`。

## 7. 未覆盖的能力

Revit/RVT 转换 Worker、DWG 转换、云渲染 GPU Worker、实时视频与 Oracle/TDengine 连接器不在本 Compose 交付内,按需参照对应文档另行部署。应用镜像、SBOM 与 clean Linux 全链路验收按 `container-deployment.md` 的工作量判断单独立项。
