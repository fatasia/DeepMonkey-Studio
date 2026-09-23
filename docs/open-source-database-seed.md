# 开源数据库交付

GitHub 不携带工作机的 `data/database.json`。它包含用户项目、发布记录、对象引用和可能的连接配置，不能作为公共样例提交。仓库提供可复现的无密钥数据库种子：`examples/open-source/database.seed.json`。

克隆后用一个命令初始化系统元数据并启动 Web/API（安装依赖与 PostgreSQL/MinIO 服务的准备见 `docs/native-deployment.md`）：

```bash
pnpm run init
```

命令读取 `.env` 的 `METADATA_STORE` 和 `OBJECT_STORE`。支持三种元数据后端：`json`（`DATA_DIR/database.json`，零依赖）、`sqlite`（`SQLITE_DATABASE`，默认 `DATA_DIR/database.sqlite`，Node 24 内置 SQLite/JSON1）和 `postgres`（由 `POSTGRES_*` 配置）。生产使用 PostgreSQL + MinIO，个人单机建议 SQLite + 本地对象目录。它会检测现有元数据并跳过写入，不覆盖用户项目；已有服务健康时也不会重复启动。未指定 `--data-dir` 时使用 `DATA_DIR`，再回退到仓库 `data/`。只有明确要重置数据库时才使用 `--force`：

`OBJECT_STORE=local|minio` 独立选择模型和附件对象的存放位置：`local` 使用 `DATA_DIR` 下的本地目录，`minio` 使用 `MINIO_ENDPOINT`、`MINIO_BUCKET` 和服务账号凭据。MinIO 模式要求 MinIO Server 已运行，并安装 MinIO Client (`mc`)；API 首次启动会用 `mc` 创建缺失 Bucket。`pnpm run init` 只初始化元数据种子并启动 Web/API，不会导入 MinIO 对象；公开案例素材按独立素材包或 MinIO 导入流程交付。

PostgreSQL 模式要求 `psql` 可执行。首次初始化时，`POSTGRES_USER` 必须能连接 PostgreSQL 的 `postgres` 管理库，并在目标数据库尚不存在时创建它；也可以预先创建数据库。生产预检还会验证目标库和 MinIO Bucket 的读写权限。Windows 可用 PowerShell 设置 `.env` 并运行同一命令；Linux 需确保 PostgreSQL、MinIO Server 服务已启动。三种元数据后端均可配本地对象存储；推荐部署组合为 `postgres + minio`，单机组合为 `sqlite + local`。

```bash
pnpm run init -- --force
```

`--force` 会用公开种子替换目标元数据文档，可能删除其中已有的用户数据；运行前先完成备份。

种子包含一个 `default` 项目、两个脱敏的数据连接、两个字段目录，以及可编辑的 4 页智造园区案例（4 个三维场景）。案例由现有 showcase 生成器生成并冻结到 `examples/open-source/showcases.seed.json`；初始化不复制开发者的项目和场景。它不包含模型二进制、用户上传文件、访问令牌、密码、API Key、发布历史或 MinIO 对象；模型和素材由公开静态资源或独立资源包交付。

交付分三层：

- **仓库内置**：Nature Kit、模板、二维组件、公开样例和 Lab fixtures，随 Git/构建产物发布。
- **独立素材包**：工业模型、环境材质、音视频等带 `catalog.json`、来源、许可证、SHA-256，经审计后挂载到 `ASSET_LIBRARY_DIR` 或对象存储。
- **用户数据**：`DATA_DIR` 中的 JSON 元数据或 PostgreSQL `bim_studio_state` 与 MinIO 对象按项目备份/迁移，不进入源码仓库。

生产环境设置 `METADATA_STORE=postgres` 后，`pnpm init:open-source` 会创建目标数据库、`bim_studio_state` 表并写入同一份脱敏种子；它不会导入开发者的私有项目、场景、发布记录或 MinIO 对象。SQL 只作为 PostgreSQL 运维排障手段，默认不要求用户手工执行 SQL。案例素材按独立素材包或 MinIO 导入。

验证种子不会覆盖已有库且不含密钥：

```bash
node --test scripts/seed-open-database.test.mjs
node --test scripts/init-open-source.test.mjs
pnpm assets:verify:open
```

2026-09-23 真实隔离 smoke：在临时 `DATA_DIR` 使用 SQLite 执行 `node scripts/init-open-source.mjs --data-dir <temp>`，初始化数据库后由同一命令启动 Web/API；API 与 Web 健康检查均通过，随后关闭隔离实例。该证据不覆盖本机 PostgreSQL 服务未运行时的连接成功，也不改变用户现有 `data/`。
