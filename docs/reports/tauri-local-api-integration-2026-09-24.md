# Tauri 本地完整 API 接入记录（2026-09-24）

## 现状核查

### 已有（不重建）

- 契约与消费方：Web 已统一通过 `ServerClient` 和 `api.ts` 访问项目、场景、二维应用、数据源、AI、转换与发布接口；Tauri 已有本地/服务器启动选择和服务器配置适配器。
- 数据层：API 已有 `SqliteStore`、本地 `ObjectStore` 和相同的 `MetadataStore` 合同；`METADATA_STORE=sqlite`、`OBJECT_STORE=local` 可以运行完整 `buildApp()`。
- 项目迁移：现有 `.bimproject` 已覆盖项目内容、哈希、身份重映射、断点续导和凭据剔除；本轮没有新增第二种导出格式。
- 发布能力：Native、Android、Web、DMDA 等发布继续由现有 API 路由与编译器提供；本轮没有在 Tauri 或前端复制打包器。
- 旧本地实现：`DesktopLocalApi` 和 IndexedDB Store 只保留兼容测试/迁移用途，不继续扩建为第二套后端。
- 依赖：Node 24 已随开发环境使用，SQLite 来自 `node:sqlite`；无需新增 npm 或 Rust 数据库依赖。

### 真实缺口

1. 本地模式仍把请求分流到 IndexedDB 子集，数据源、AI、转换和发布返回 server-only，无法达到本地/服务器功能一致。
2. Tauri 没有管理完整 API 子进程、动态回环端口、生命周期、启动健康检查和无登录直达令牌。
3. 桌面包没有自包含 Node + API production dependencies；干净机器仍需要开发环境。
4. 旧 WebView2 bootstrapper 可能在首次安装联网，桌面资源门禁也没有检查完整 API、WASM 和 Draco 运行文件。

## 实施

- Tauri 新增 `start_local_api`：分配随机 `127.0.0.1` 端口，启动包内 Node/API，30 秒内轮询 `/health`，异常退出或超时返回可操作错误；宿主退出时终止子进程。
- 本地工作区固定使用应用数据目录下的 `workspace/metadata.sqlite` 与 `workspace/data/`，日志写入 `workspace/logs/local-api.log`。
- API 只在 `BIM_STUDIO_DEPLOYMENT_MODE=desktop-local` 且请求来自回环地址时接受宿主生成的 256-bit 会话令牌；普通服务部署、远程地址和错误令牌不走该旁路。
- Web 本地模式不再进入 IndexedDB API，和服务器模式一样走正式 HTTP `ServerClient`。本地/服务器只切换 origin 和凭据，页面、请求路径与合同不分叉。
- 本地 API sidecar 使用 `pnpm --config.inject-workspace-packages=true deploy --prod` 生成，不再使用会把共享根 `node_modules` 裁成 production-only 的 legacy deploy；构建前强制重建 API，避免打入陈旧 `dist`。
- sidecar 包含当前 Node 可执行文件和 production dependencies；部署后裁掉运行时不读取的 sourcemap、TypeScript 声明与源码，避免 Windows 安装器长路径失败。运行所需 JS、package metadata、native addon 与发布资源保持不变。
- WebView2 改为 `offlineInstaller`；桌面验收脚本新增本地 API、正式 WASM、Draco GLTF 解码器、本地前端入口和远程脚本/样式检查。

## 真实 sidecar 验证

使用 `apps/desktop/local-api-bundle/node.exe dist/index.js`，配置 SQLite、本地对象存储、随机本地令牌和 `http://tauri.localhost` CORS 后验证：

| 检查 | 结果 |
|---|---|
| `GET /health` | HTTP 200，`status=ok` |
| 无令牌 `GET /api/projects` | HTTP 401 |
| 本地令牌 `GET /api/auth/me` | `admin` / `admin` role |
| 项目创建与列表 | 创建成功，列表可读 |
| API 重启后 SQLite 恢复 | 同一项目 ID 恢复成功 |
| `GET /api/demo/sensors` | 30 行 SQLite 示例数据 |
| `GET /api/meta` | API 版本 `1.0` |
| Tauri Origin CORS | `Access-Control-Allow-Origin: http://tauri.localhost` |

测试数据位于未跟踪的 `test-output/desktop-local-api-e2e/`，只用于本机验收。

## 自动化证据

- Web TypeScript：通过。
- Web 本地/Tauri 适配器：2 files / 8 tests 通过。
- API TypeScript：通过。
- API desktop-local auth、SQLite、数据集成：3 files / 20 tests 通过。
- Tauri Rust：9 tests 通过，含服务器配置、Windows 用户级凭据加密、窗口策略、发布环境物化和 Three 尾包校验。
- sidecar clean rebuild/deploy：通过；执行后根 `tsc`、`vitest` 仍存在，未改 `pnpm-lock.yaml` 或依赖版本。
- Tauri release `build --no-bundle`：通过；最终主程序为 58,181,120 字节、SHA-256 `a945c573cb00f81cc0d84fc12c80c1076199edaaeb9d5680e81f07dd9be1ab1e`，`target/release/local-api/` 中存在随包 Node 与完整 API 资源。
- 为避免继续扩大宿主入口，sidecar 生命周期实现已从 `lib.rs` 抽到 300 行以内的 `local_api.rs`，命令与前端合同不变。

## 发布资源边界

本地 API 已与服务器 API 同构，Native/Android 页面不再因为 IndexedDB 子集而缺失。`prepare-local-api-runtime.mjs` 现在复用 API 发布资源生成器，把已验证的 Native 播放器、固定探针、Android 双 ABI 模板、build-tools 和最小 JRE 写入可搬迁清单；Tauri `local_api.rs` 在启动 sidecar 前物化 Dashboard 配置并注入路径。真实生产 sidecar smoke 已确认 Native 与 Dashboard/Android 路由注册成功。

Three WebView 安装版复用当前桌面 EXE 作为固定通用 launcher。API 校验同一 `.bimscene.zip` 的发布身份、展开大小、文件 SHA 与整体 content hash，写入只读负载后返回场景 EXE；不复制 Cargo/pnpm/完整源码，也不逐场景编译。Tauri 检测到尾包后进入独立 `scene-viewer` capability，只读取安装前端和冻结场景资源；普通桌面 EXE 没有尾包时仍进入完整编辑器。生产 smoke 已取得 Three 下载 200，并由下载后的独立 EXE inspector 验证只读标记与三层身份哈希。

最终桌面构建已从生产 sidecar 重新下载并验证：生成的场景 EXE 为 58,183,856 字节、SHA-256 `73fdccc67341ba91fd80f5c306a76823195825ab80b87627a31f87e59c0092bf`，package `522c6957e2f90d41`，payload SHA-256 `d3701cb97e85913080a613c2d0cc3d75bb516bd01474ebabace02a58253715eb`，独立 inspector 确认只读。真窗口无 fatal、canvas 1800×1125；深色系统标题栏亮度 32；工具坞经 CDP 点击后 `aria-expanded` 从 `true` 变为 `false`，宽度由 269.6 px 收为 44.6 px。证据在 `test-output/final-three-scene-viewer/`。
