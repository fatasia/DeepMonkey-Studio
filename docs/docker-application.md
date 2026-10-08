# Docker 应用部署

应用容器用一个 Node.js 24 进程运行 API 和正式 Web，沿用 PostgreSQL、MinIO 与生产配置校验。数据放在三个持久卷，应用以普通用户、只读根文件系统运行。

## 构建

发行流水线先运行正式 WASM 构建：`node scripts/build-wasm-bundle.mjs`。Docker 构建会核对这份产物的源码指纹和文件 SHA-256；从干净源码克隆后也必须先生成它。Node 基础镜像固定 digest，pnpm 固定 11.18.0，依赖用仓库锁文件。

```sh
docker build --build-arg VERSION=0.2.0 --build-arg REVISION=$(git rev-parse HEAD) -t deep-monkey-studio:0.2.0 .
```

## 单容器启动

导入 Release 镜像后，一条命令启动 Web/API，使用显式本地 JSON 元数据和文件对象存储；数据库模式仍使用后面的 Compose 配置。

```sh
docker run -d --name deepmonkey-studio --restart unless-stopped -p 4100:4100 -v deepmonkey-studio-data:/var/lib/studio -e BIM_STUDIO_STORAGE_MODE=standalone deep-monkey-studio:0.2.0
docker exec deepmonkey-studio node -e "console.log(JSON.parse(require('fs').readFileSync('/var/lib/studio/standalone-credentials.json','utf8')).adminPassword)"
```

第二条命令读取自动生成的管理员密码；账号为 `admin`。密码和会话密钥仅首次创建，随数据卷保留；重启不会重新生成。自定义端口时设置 `WEB_ORIGIN` 为实际访问地址。默认生产模式继续要求 PostgreSQL、MinIO 和非默认凭据。

## 素材库

大型素材包单独发布在 [asset-library-v1](https://github.com/fatasia/DeepMonkey-Studio/releases/tag/asset-library-v1)。下载三个分卷并从 `.7z.001` 解压；将目录中含 `catalog.json` 与审核清单的素材根目录设为 `.env` 的 `STUDIO_ASSET_LIBRARY_DIR`。Compose 将它只读挂载到应用，素材导入后进入工程持久存储。内置 Nature Kit 随应用镜像交付。

单容器可增加 `-v /path/to/library:/opt/studio/asset-library:ro -e ASSET_LIBRARY_DIR=/opt/studio/asset-library`。Pages 的素材列表、预览和导入复用同一 API；四 GB 素材分卷放在 Release 下载。

## 启动

部署目录放仓库的 `docker-compose.yml`、`docker-compose.app.yml` 和私有 `.env`。配置 `POSTGRES_PASSWORD`、`MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD`，管理员密码至少 12 位、会话密钥至少 32 位；完整变量参考 `.env.example`。自定义端口用 `STUDIO_PORT`，相应设置 `STUDIO_PUBLIC_ORIGIN`。

```sh
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d
docker compose -f docker-compose.yml -f docker-compose.app.yml ps
```

访问 `http://localhost:4100`，等待三服务 healthy。数据库表和对象 Bucket 在 API 初始化时创建；健康检查读取正式 `/api/meta`，初始化失败时保留错误日志。

## 离线包

发布的 `DeepMonkey-Studio-Docker-0.2.0.tar.gz` 包含应用与两个存储镜像，先核对随包 JSON 清单，再导入：

同时下载 `DeepMonkey-Studio-Docker-0.2.0-deployment.zip`。解压后把镜像归档放在 `start.ps1` / `start.sh` 旁；Windows 运行 `powershell -File ./start.ps1`，Linux 运行 `sh ./start.sh`。脚本先校验 SHA-256，导入三个镜像，再以 `--no-build --pull never` 启动。首次启动创建随机本地凭据的 `.env`；用其中的 `BIM_STUDIO_ADMIN_PASSWORD` 登录 `admin`。已有 `.env` 保持不变，修改端口时同时改 `STUDIO_PORT` 和 `STUDIO_PUBLIC_ORIGIN`。

从同版代码包取 `docker-compose.yml`、`docker-compose.app.yml` 和 `.env.example`，放到镜像归档旁；把 `.env.example` 复制为私有 `.env` 并按上文配置凭据。

```sh
gzip -dc DeepMonkey-Studio-Docker-0.2.0.tar.gz | docker load
BIM_STUDIO_MINIO_IMAGE=deep-monkey-minio:2025.5.24 docker compose -f docker-compose.yml -f docker-compose.app.yml up -d --no-build --pull never
```

生成发行镜像归档：`pnpm exec node scripts/export-release-docker.mjs`。工具先构建、读取 OCI 版本/提交身份，然后流式导出三个镜像并记录 SHA-256。存储镜像加固定本地 tag 供离线加载，原始 MinIO digest 留在清单；需要 Docker Engine，构建机器能访问固定上游镜像和锁定依赖，导入后的运行无需拉取镜像。

## 更新与边界

更新前按[部署文档](deployment.md)备份 PostgreSQL、MinIO 与应用数据卷。导入新镜像后设置 `STUDIO_VERSION` 并执行同一 Compose 命令；回滚改回旧 tag，保留数据卷，不执行 `down -v`。

此镜像交付 Web/API。GPU Native 窗口、Windows 桌面安装器和本地 CAD 转换 worker 使用各自平台交付物；容器启动不会把缺失的平台能力标为可用。上游制作方式见 [pnpm deploy](https://pnpm.io/cli/deploy) 与 [Node 官方镜像](https://github.com/nodejs/docker-node)。
