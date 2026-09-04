# 从零开发与原生部署

Deep Monkey Studio 不使用 Docker。开发、联调、健康检查和生产部署统一从 `pnpm studio` 进入；内部仍按平台调用经过验证的进程守护适配器，但开发者无需记忆第二套命令。

## 1. 环境要求

| 场景 | 必需环境 | 可选环境 |
| --- | --- | --- |
| Web / API 开发 | Git、Node.js 24、Corepack、pnpm 11.18 | PostgreSQL、MinIO、Node-RED、实时视频服务 |
| Windows 客户端源码开发 | 上述环境、Rust stable、Visual Studio C++ Build Tools、WebView2 | Revit 与格式转换 Worker |
| Windows 已安装客户端 | WebView2 | 服务端 Origin；本地工作台不要求 Node、Python、PostgreSQL 或 MinIO |
| Linux 生产服务器 | 64 位 Linux、Node.js 24、Corepack、systemd、bash、sudo、PostgreSQL、MinIO | 企业反向代理与 TLS 证书 |

Python 不是主应用、Web、API 或客户端的运行依赖。Revit、DWG、云渲染和现场协议等按实际业务启用，不是首次启动的前置条件。

## 2. 获取代码与安装依赖

Windows PowerShell 与 Linux Shell 的核心步骤相同：

```bash
git clone git@github.com:fatasia/bim-studio.git
cd bim-studio
node --version
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm --version
pnpm install --frozen-lockfile
```

`node --version` 必须为 24 或更高版本，`pnpm --version` 应与根目录 `packageManager` 一致。若系统没有 `corepack` 命令，先按 Node.js 官方方式安装 Corepack，再继续；不要改用 npm 或 yarn 生成第二份锁文件。

复制环境模板：

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# Linux
cp .env.example .env
```

`.env` 包含凭据且已被 Git 忽略。不得把真实密码、Access Key、会话密钥或 AI Key 写入文档、提交记录和诊断包。

## 3. 本地零基础设施模式

个人开发和离线演示优先使用本地存储，不要求安装 PostgreSQL 或 MinIO：

```dotenv
METADATA_STORE=json
OBJECT_STORE=local
API_PORT=4100
BIM_STUDIO_WEB_HOST=0.0.0.0
BIM_STUDIO_WEB_PORT=5173
WEB_ORIGIN=http://localhost:5173
```

Windows 客户端联调：

```bash
pnpm studio start client
```

Windows 或 Linux 的 Web 联调：

```bash
pnpm studio start web
```

只启动后端 API：

```bash
pnpm studio start api
```

`client` 会启动 API、Web 和 Tauri 开发客户端，只支持 Windows。安装包中的“本地工作台”是另一种运行形态：项目保存在客户端 IndexedDB，无需填写服务 IP，也不依赖 Node、PostgreSQL、MinIO 或 Python；需要协作、数据服务和在线发布时才连接服务器 Origin。

## 4. 唯一运行入口

所有平台都使用下列命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm studio start client` | Windows：启动 API、Web 和桌面开发客户端 |
| `pnpm studio start web` | Windows / Linux：启动 API 和 Web 开发服务器 |
| `pnpm studio start api` | 只启动 API，供已有客户端或其它前端连接 |
| `pnpm studio stop` | 关闭本入口管理的整套开发进程 |
| `pnpm studio restart` | 按上次目标与参数重启 |
| `pnpm studio status` | 显示目标、进程归属、API/Web 地址与健康状态 |
| `pnpm studio check` | 执行只读健康检查；异常时返回非零退出码 |
| `pnpm studio help` | 查看参数与示例 |

入口一次只管理一套运行环境。再次启动前使用 `restart`；`stop` 只结束入口创建并通过身份校验的进程，不会误杀同端口的其它程序。运行状态保存在 `data/runtime/studio-manager.json`，聚合日志位于 `data/logs/studio.out.log` 和 `data/logs/studio.err.log`。

### 主机、端口与远程 API

```bash
# 自定义本机 API 与 Web 监听地址
pnpm studio start web --api-host 0.0.0.0 --api-port 4200 --web-host 0.0.0.0 --web-port 5200

# Web 使用另一台机器上的 API，不在本机重复启动 API
pnpm studio start web --api-origin http://192.168.1.20:4100

# API 使用生产型存储；基础设施已由系统服务管理时可跳过代启
pnpm studio start api --metadata-store postgres --object-store minio --skip-infra

# 使用 .env 指定的本地证书启动 HTTPS 开发站点
pnpm studio start web --https
```

参数约束：

- `--api-host` 和 `--web-host` 接收主机名或 IP；默认均为 `0.0.0.0`。
- `--api-port` 默认 4100，`--web-port` 默认 5173，范围为 1–65535。
- `--api-origin` 必须是无账号、无路径、无查询参数的完整 HTTP(S) Origin；启动器会校验服务身份，不会把任意监听端口误判为本项目。
- `client` 的开发 Web 端口固定为 5173，这是 Tauri 开发配置的明确约束；需要其它端口时使用 `web`。
- `client` 不接受 `--https`，避免桌面开发地址与 Web 协议不一致；需要 HTTPS 联调时使用 `web`。
- `--metadata-store` 仅接受 `json` 或 `postgres`；`--object-store` 仅接受 `local` 或 `minio`。
- `--skip-infra` 只禁止代启 PostgreSQL/MinIO，不会降低健康检查要求。
- Linux 默认不打开浏览器；其它平台可用 `--no-open` 禁止自动打开。

## 5. PostgreSQL 与 MinIO

生产必须使用 PostgreSQL 和 MinIO。它们是独立原生服务，`pnpm studio deploy` 会预检连接，但不会替系统安装数据库或对象存储。

最小配置示例：

```dotenv
METADATA_STORE=postgres
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DATABASE=bim_studio
POSTGRES_USER=bim_studio_service
POSTGRES_PASSWORD=<从密钥管理器注入>

OBJECT_STORE=minio
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=<平台专属服务账号>
MINIO_SECRET_KEY=<从密钥管理器注入>
MINIO_BUCKET=bim-studio

BIM_STUDIO_ADMIN_PASSWORD=<至少12位随机密码>
BIM_STUDIO_SESSION_SECRET=<至少32位随机密钥>
WEB_ORIGIN=https://studio.example.com
```

API 会初始化所需表和 Bucket，并在首次切换时迁移原本地数据但不删除源文件。生产账号应使用最小权限的专属服务用户；建库、恢复和临时 Bucket 验证所需的维护账号只在命令执行时注入，不长期写入 `.env`。

在 Windows 本机开发中，启动器可尝试启动已安装的 PostgreSQL 服务和通过 `MINIO_SERVER_PATH` 配置的 MinIO。Linux 若服务未运行，会直接提示运维先启动相应 systemd 服务，不会绕过系统服务管理。

## 6. 构建与发布前检查

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm verify:release
```

`pnpm build` 生成 API 与 Web 正式产物；`pnpm verify:release` 还执行源码体量、测试、品牌、资源、数据中心、浏览器与在线闭环门禁。只改局部代码时可先运行所在工作区的聚焦测试，交付前仍应执行完整门禁。

Windows 桌面安装包只能在具备 Rust、MSVC 工具链和 WebView2 的 Windows 构建机生成：

```bash
pnpm desktop:bundle
pnpm desktop:verify-bundle
```

安装包是 Windows 交付物，不在 Linux 服务器构建或运行。未配置 Authenticode 证书时，安装包会显示未知发布者；包体检查不能替代真实安装、覆盖升级和卸载验收。

## 7. 生产部署

### 部署前准备

1. 安装并启动 PostgreSQL 与 MinIO，创建平台专属服务账号。
2. 按第 5 节配置生产 `.env`，设置真实 `WEB_ORIGIN`、强密码和随机会话密钥。
3. 让数据库、对象存储只监听受信网络；公网只暴露经反向代理保护的 Web/API Origin。
4. 先执行预检，不通过时不要带病部署。

```bash
pnpm studio deploy --check
```

### Windows 服务器

在管理员终端执行：

```bash
pnpm studio deploy
```

部署会安装锁定依赖、构建正式产物并注册 Windows 计划任务，提供开机启动和失败重启；API 在生产模式下同源托管 `apps/web/dist`。非管理员运行只能创建当前会话后台进程，不具备可靠的开机自启能力。

### Linux 服务器

在具有 sudo 权限的部署账号下执行同一命令：

```bash
pnpm studio deploy
```

入口会注册项目独立的 systemd 服务，设置失败重启、工作目录和最小进程权限。TLS、域名证书、限流和企业统一认证由 Nginx、Caddy 或现有网关承担；PostgreSQL 5432 和 MinIO 9000/9001 不应直接暴露到公网。

已确认依赖和正式构建产物没有变化时，可显式跳过构建：

```bash
pnpm studio deploy --skip-build
```

停止并移除生产守护：

```bash
pnpm studio undeploy
```

`undeploy` 不删除 `.env`、数据库、对象、备份或构建产物。

## 8. 备份、升级与回滚

正式备份要同时覆盖 PostgreSQL 与 MinIO。为获得跨存储一致性，应先停止写入：

```bash
pnpm studio undeploy
pnpm backup:production
pnpm verify:restore -- --input data/backups/<backup-id>
pnpm studio deploy --skip-build
```

`verify:restore` 使用临时数据库和临时 Bucket 回读校验，不修改生产数据。在线执行 `backup:production -- --allow-live` 只生成 `best-effort-live` 审计备份，不能作为正式灾备点。

升级建议流程：

1. 记录当前 Git tag 或 commit，并完成停机一致性备份与恢复验证。
2. 拉取目标版本，执行 `pnpm install --frozen-lockfile`。
3. 执行 `pnpm studio deploy --check` 和发布门禁。
4. 执行 `pnpm studio deploy`，再检查 `/health`、登录、场景浏览、保存和发布。

应用回滚时先 `pnpm studio undeploy`，切回已记录的稳定 tag/commit，重新安装锁定依赖并执行 `pnpm studio deploy`。只有数据库或对象结构也发生不兼容变化时才恢复数据；恢复是破坏性操作，必须保持服务停止并让 `--confirm` 精确匹配备份清单的 `backupId`：

```bash
pnpm restore:production -- --input data/backups/<backup-id> --confirm <backup-id>
```

## 9. 健康、日志与故障排查

先执行：

```bash
pnpm studio status
pnpm studio check
```

常见问题按以下顺序处理：

- **Node 版本错误**：确认 `node --version` 为 24+，重新执行 Corepack 与锁定依赖安装。
- **已有环境运行**：使用 `pnpm studio restart`，不要重复启动第二套进程。
- **端口被占用**：更换 `--api-port` / `--web-port`，或停止实际占用者；入口不会接管身份不匹配的进程。
- **API 异常**：检查 `data/logs/studio.err.log`，再访问 `http://127.0.0.1:4100/health`；远程 API 使用实际 Origin。
- **PostgreSQL/MinIO 不健康**：检查 `.env` 主机、端口和服务账号，确认原生服务已经运行，再执行 `pnpm studio deploy --check`。
- **Linux 部署失败**：查看 `systemctl status deep-monkey-studio-<id>` 与 `journalctl -u deep-monkey-studio-<id>`；确认部署账号有 sudo 权限且 Node 绝对路径未变化。
- **Windows 守护失败**：检查任务计划程序与 `.runtime-logs/production.err.log`；管理员身份决定能否注册开机任务。
- **浏览器无法访问**：检查主机防火墙、反向代理、`WEB_ORIGIN` 和 HTTPS 终止位置；不要开放数据库与 MinIO 管理端口代替正确代理。
- **客户端无法连接服务器**：填写完整 HTTP(S) Origin，不带路径；先用 `pnpm studio check` 或 `/health` 证明服务可达。离线时切换本地工作台，恢复网络后再同步，避免静默覆盖。

管理页面的“设置 → 服务健康”和“设置 → 审计与日志”会展示服务状态、延迟、失败原因并导出脱敏诊断；诊断包不包含项目、模型、业务数据或凭据。

## 10. 可选能力边界

- Node-RED、实时视频和云渲染是按需部署的外部原生服务，不进入首次启动的必需链路。
- RVT 转换只在装有合法 Revit 的 Windows 转换机运行；客户端和 Linux Web 服务器不因未安装 Revit 而失去普通场景能力。
- DWG 开源转换器、Revit Worker、Unity 包和外部工业格式转换链路分别按对应文档安装，不应塞进基础启动命令。
- 弱网重试、离线状态和冲突保护由应用运行时处理；基础设施不可达时启动器会明确失败，不会伪报健康。
