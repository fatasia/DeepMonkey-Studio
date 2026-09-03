# 原生启动与云部署

项目全局不使用 Docker。开发进程由本地启动器编排，生产进程使用 Windows 计划任务或 Linux systemd 守护；PostgreSQL 与 MinIO 均作为原生服务运行。

## 本地开发

```powershell
# 默认：检查/启动 PostgreSQL、MinIO、API，并打开 Tauri 客户端；客户端仍可选择零服务依赖的“本地工作台”。
pnpm dev:local

# 只启动 API + Web 并打开浏览器。
pnpm dev:local:web

# 只启动服务端，供客户端或其它前端联调。
pnpm dev:local:services

# 只检查当前依赖与端口，不改变运行状态。
pnpm dev:local:check

# 查看严格参数说明；未知参数不会被静默忽略或误触发启动。
node scripts/start-local.mjs --help
```

`--skip-infra` 可跳过 PostgreSQL/MinIO 代启。安装后的 Windows 客户端本地模式不依赖这些服务、Node.js 或 Python。
`--check` 会验证端口后的服务身份，而不是只判断“有人监听”：API 必须返回 Industrial Studio `/health` 合同，Web 必须返回 Industrial Studio 页面标识。JSON 结果中的 `required` 说明当前目标和存储配置真正依赖哪些服务；任一必需项不健康时命令返回非零退出码，可直接用于交付前检查。

### 修改开发 API 接口

默认情况下，Web 开发代理和 `dev:local` 都使用 `http://127.0.0.1:${API_PORT}`。如果 API 在另一端口或另一台开发机，在仓库 `.env` 写入完整 Origin：

```dotenv
API_PORT=4100
BIM_STUDIO_API_ORIGIN=http://192.168.1.20:4100
```

`BIM_STUDIO_API_ORIGIN` 只能是无账号、无路径、无查询参数的 HTTP(S) Origin。启动器会请求 `${BIM_STUDIO_API_ORIGIN}/api/meta`，而不是只检查端口是否被占用；配置错误或错误服务不会被误判为已启动。

## Windows 原生云服务

生产 `.env` 必须使用 PostgreSQL、MinIO，并配置至少 12 位管理员密码和至少 32 位会话密钥。

```powershell
pnpm deploy:cloud:check
pnpm deploy:cloud
pnpm deploy:cloud:stop
```

管理员运行时会注册开机启动、失败自动重启的计划任务；非管理员运行只启动当前机器上的后台进程并给出提示。API 在生产模式下直接托管 `apps/web/dist`，Web/API/模型保持同源。

## Linux 原生云服务

```bash
bash scripts/deploy-cloud.sh --check
bash scripts/deploy-cloud.sh
bash scripts/deploy-cloud.sh --stop
```

脚本构建后注册独立 systemd 服务，设置失败重启和最小权限。TLS、域名证书和企业网关由现有反向代理承接；PostgreSQL、MinIO 不应直接暴露到公网。

## 健康与日志

- API 基础健康入口：`/health`；管理员综合健康入口：`/api/admin/health`
- “设置 → 服务健康”实时检查 API、Web、流程服务、实时视频、视觉运行时、PostgreSQL 与对象存储，展示状态、延迟、检查时间和失败原因；未启用的存储明确显示“未配置”，不会伪报健康。
- “设置 → 审计与日志”可按服务、级别、起止时间和关键词筛选，并导出当前筛选；服务端在返回和导出前统一脱敏。操作审计只供页面核对，不提供审计导出。
- 诊断包包含运行元数据、综合健康与脱敏错误日志，不包含凭据、审计记录、项目数据、业务数据或模型。
- Windows 日志：`.runtime-logs/production.out.log` 与 `.runtime-logs/production.err.log`
- 本地 Windows 服务日志：`data/logs/<服务>.out.log` 与 `data/logs/<服务>.err.log`
- Linux 日志：`journalctl -u industrial-studio-<id>`

部署预检不输出密码或访问密钥；失败时只报告缺失项、不可达服务或缺少的本地客户端工具。

## 生产备份与恢复

生产备份同时覆盖 PostgreSQL 元数据和 MinIO 项目对象，并在 `manifest.json` 中记录数据库摘要、每个对象的字节数与 SHA-256。为得到跨存储一致的停机备份，应先停止写入：

```powershell
pnpm deploy:cloud:stop
pnpm backup:production
pnpm verify:restore -- --input data/backups/<backup-id>
pnpm deploy:cloud
```

`verify:restore` 不修改生产库。它恢复到随机临时 PostgreSQL 数据库和临时 MinIO Bucket，回读全部对象并校验摘要，随后清理沙箱。创建/删除沙箱需要通过进程环境临时注入 `POSTGRES_MAINTENANCE_USER/PASSWORD` 和 `MINIO_MAINTENANCE_ACCESS_KEY/SECRET_KEY`；日常 API 服务账号不授予建库或管理 Bucket 的权限。API 仍在运行时，备份命令默认拒绝执行；`--allow-live` 只用于非一致性审计，清单会明确标为 `best-effort-live`，不能作为正式灾备点。

生产恢复是破坏性操作，因此同时要求服务停止、备份完整且 `--confirm` 精确匹配清单中的 `backupId`：

```powershell
pnpm restore:production -- `
  --input data/backups/<backup-id> `
  --confirm <backup-id>
```

恢复顺序为：校验全部摘要 → PostgreSQL `pg_restore` → MinIO 精确镜像。未完成备份保留 `.incomplete` 标记，恢复器会直接拒绝。

## 应用密钥轮换

管理员密码和会话签名密钥使用密码学安全随机数轮换，密钥只写入 `.env` 和权限收紧的恢复文件，不输出到终端。轮换会使现有登录会话失效，因此必须先停服务：

```powershell
pnpm deploy:cloud:stop
pnpm rotate:secrets -- --confirm ROTATE-APPLICATION-SECRETS
pnpm deploy:cloud:check
pnpm deploy:cloud
```

命令会保留 `.env.previous` 作为单步回滚，并只输出恢复文件路径。PostgreSQL 账号和 MinIO 服务账号可能被同机其它应用共用，且 MinIO Root 凭据轮换需要协调原生服务重启，因此本命令不会擅自修改基础设施账号；这两类账号应使用平台专属服务用户，由数据库/对象存储管理员按各自策略轮换，再更新 `.env` 并执行生产预检。

若当前只是开发进程不能立刻停止，可显式添加 `--defer-until-restart`，只更新下一次启动使用的配置；当前进程继续使用旧值，不能把文件已更新误认为轮换已经生效。

若当前还是共享管理员账号，可一次性创建平台专属的 PostgreSQL 登录角色和 MinIO `readwrite` 服务用户。命令会验证新账号实际可读目标数据库/Bucket 后再原子更新 `.env`，且不会在终端打印凭据：

```powershell
pnpm provision:service-accounts -- `
  --confirm PROVISION-DEDICATED-SERVICE-ACCOUNTS
```

当前进程仍使用旧连接，重启后才切到新账号。命令不会自动删除旧基础设施账号；确认新进程预检、备份和上传通过后，再由管理员按 PostgreSQL/MinIO 策略回收旧账号，避免误伤同机其它应用。

## 断网与弱网边界

- HTTP/数据库等数据源的预览重试次数限制为 0–10 次，初始延迟 100–10,000ms，最大退避 60 秒，倍率 1–5，并只重试超时、连接中断和 HTTP 5xx；401 等配置/鉴权错误不会重试。
- WebSocket 场景数据与直接绑定采用指数退避并限制最大间隔；取消订阅、切换页面或关闭运行时会清理定时器和连接。
- 数据中心展示 `healthy/degraded/offline`、连续失败、延迟与重连次数。网络恢复后的成功读取会清零连续失败，但保留累计重连证据。
- 本地工作台请求由 IndexedDB 适配器在进程内处理，不会因为 PostgreSQL、MinIO 或服务 IP 不可达而进入网络重试。

## Windows 客户端交付证据

`pnpm desktop:bundle` 先构建同一份 `apps/web/dist` 静态前端，再生成 MSI 与 NSIS。`pnpm desktop:verify-bundle` 会检查两种安装包、桌面主程序，以及随包交付的 `index.html`、IFC WASM 和 Draco 解码资源。

安装后的客户端首次启动可直接选择“本地工作台”，无需填写服务 IP；本地项目保存在客户端 IndexedDB。需要协作、数据服务或在线发布时，才在连接页填写服务器 Origin。该配置写入应用配置目录，采用临时文件、旧值备份、原子激活和启动恢复；它不包含登录令牌。

真正的 per-machine 安装、覆盖升级和卸载必须在干净的管理员 Windows 虚拟机中运行 `apps/desktop/scripts/verify-windows-install-lifecycle.ps1`。普通开发机的构建、包体校验或管理镜像解包都不能替代此证据。

## 2026-08-31 本机验证证据

本轮在不输出任何凭据的前提下完成：

- `pnpm dev:local:check`：PostgreSQL、MinIO、API、Web 四项均可达。
- `pnpm dev:local -- --no-open`：首次真实执行发现已有 Web 服务时 `--config` 被错误传给 Cargo；修复后 Tauri 编译完成并实际启动 `target/debug/bim-studio-desktop.exe`，随后仅停止本次启动的客户端子进程。
- 本地工作台聚焦测试：项目/场景保存、重新创建 API 适配器后恢复，全程零 `fetch`；需要云能力时返回明确的 server-only 状态，不偷偷联网或伪造结果。
- `pnpm provision:service-accounts`：创建平台专属 PostgreSQL/MinIO 服务账号，新凭据分别通过真实数据库查询和 Bucket 访问后才更新 `.env`；旧基础设施账号未自动删除。
- `pnpm rotate:secrets -- --defer-until-restart`：管理员密码和会话签名密钥已更新到下一次启动配置，当前正在运行的开发 API 仍使用旧进程值，必须重启后才生效。
- `pnpm deploy:cloud:check`：使用更新后的 `.env` 真实完成 PostgreSQL 查询、MinIO 健康、Bucket 读取和临时对象写入/读取/删除预检。
- `pnpm backup:production -- --allow-live`：生成 `best-effort-live` 审计备份，包含 PostgreSQL 自定义格式 Dump 和 60 个 MinIO 对象，共 165,645,484 bytes。
- `pnpm verify:restore`：使用临时注入的维护账号恢复到随机数据库和 Bucket，数据库状态行 1、回读对象 60，全部 SHA-256 一致；数据库、Bucket 和回读目录清理成功。
- 连接可靠性测试：HTTP 503 严格在配置次数后停止，401 不重试，非法退避参数回到安全默认值；场景 WebSocket 退避上限 10 秒，取消订阅后不再重连。

这里没有声称三项未执行事项：没有覆盖生产库执行破坏性恢复；`best-effort-live` 不是停机一致性灾备点；干净 Windows 安装、升级和卸载生命周期仍属于最终环境验收。
