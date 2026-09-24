# 全局集成门禁（2026-09-24）

本报告验证 API、contracts、Web 通用层、Tauri 本地完整 API、项目迁移、发布路由和 Three.js / Deep WebGPU / Deep WASM 切换周期，并用真实 Tauri GUI 与发布 EXE 补齐底层能力到上层入口的证据。

## 现状核查

### 已有（不重建）

- 契约层已有项目、场景、二维应用、数据连接/数据集/管道、Native 发布冻结依赖与运行包合同；本轮不新增平行合同。
- SQLite 与 PostgreSQL 复用 `MetadataStore` / `JsonStore` 业务实现；本地与 SaaS 的页面和 `ServerClient` 请求路径一致，差异仅为 API origin、认证和持久化适配。
- Tauri 已有 `start_local_api`，以动态回环端口启动包内完整 API，使用 SQLite 与本地文件对象库；旧 IndexedDB API 只保留兼容测试，不作为产品主路径。
- `.bimproject` 已有清单、SHA-256、路径/大小约束、ID 重映射、断点续导、资源/脚本依赖/数据源迁移和凭据剔除；本轮不另建项目包格式。
- Three WebView、Deep Native、Dashboard Native/Android 的候选、发布与下载均已有 API/Web 消费方和专项测试；本阶段验证现有链路，不复制编译器或打包器。
- 已有专项报告：`tauri-local-api-integration-2026-09-24.md`、`local-saas-transfer-publish-parity-2026-09-24.md`、`native-publication-integration-2026-09-24.md`、`android-publication-integration-2026-09-24.md`。

### 真实缺口与本阶段边界

1. 需要在当前并行工作树上重跑 contracts、API、Web、Tauri 与仓库门禁，确认底层合同到上层入口没有类型、路由或状态漂移。
2. 需要核对本地 API 的鉴权、SQLite 重启恢复、项目迁移和发布能力声明；发布资源未闭合时必须明确 404/503，不能把源码存在写成用户可用。
3. Tauri 安装资源门禁要覆盖本地 API、WASM、Draco 与无远程运行依赖；正式发布资源闭包仍以实际 bundle 验证为准。
4. 工作树包含多个并行任务的未提交改动；本报告记录真实失败并区分产品回归、环境竞争和既有治理问题，不通过重置或清理绕过。
5. Three.js / Deep WebGPU / Deep WASM 的真实切换、画面和性能由并行引擎任务完成后续测，不在第一阶段抢占其构建目录。

### 客户端首帧白闪六步核查

1. **全仓检索**：检索 `backgroundColor`、`WebviewWindowBuilder`、`bootstrap-status`、`first frame` 和既有启动取证；主窗口配置没有原生背景色，脚本编辑器使用 `about:blank` 独立 WebView。
2. **令牌与合同**：Web 唯一设计令牌 `apps/web/src/styles/base.css` 已定义 `--bg-0: #0b1114`；不新增第二套颜色合同，把该值投影到 WebView 创建前的宿主层。
3. **依赖**：Tauri 2.11 已提供 `backgroundColor` / `WebviewWindowBuilder::background_color`，无需引入新库。
4. **消费方**：`lib.rs` 的主窗口与场景查看器都从 `tauri.conf.json` 主窗口配置创建；脚本编辑器另走 builder，因此三者都需要覆盖。
5. **测试与证据**：已有暗色 `bootstrap-status`，但它只能在 HTML 解析后生效；Wry 默认 WebView 背景为白色，解释了窗口创建到文档首帧之间的白闪。
6. **规格与交接**：复核本报告、Tauri 本地 API 报告、Native 发布报告和 2026-09-24 handoff；没有另建启动框架。

已有能力不重建：加载状态、主题令牌和窗口创建链均复用。真实缺口是 **原生 WebView 创建前** 与 **HTML 外部 CSS 加载前** 没有同一暗色底。修复为主窗口配置 `[11,17,20,255]`、`index.html` 的 `html/body/#root` 内联 `#0b1114`，并给独立脚本编辑器 builder 设置相同背景。`verify-bundle.mjs` 对两层配置做精确门禁。

设计基准采用 Unity / Siemens 工程客户端的克制暗色启动：首帧只承载一个明确的加载状态，不引入渐变、装饰动画或新品牌色。主色仍来自现有令牌；原生层只投影底色，避免主题尚未加载时出现视觉断层。

## 验收矩阵

| 层级 | 本阶段条件 | 状态 |
|---|---|---|
| Contracts | TypeScript 类型检查通过 | 通过 |
| API | 类型检查、完整测试及本地/发布聚焦回归 | 通过 |
| Web 通用层 | 类型检查、完整测试（暂避开引擎专项 E2E） | 通过 |
| Tauri | Rust check/test、资源验证、真实 GUI | Rust 10/10；sidecar 与真实 GUI 通过；安装包最终重打中 |
| 本地 / SaaS | 同合同迁移、SQLite 恢复、本地令牌边界 | 通过 |
| 发布路由 | Three、Native、Dashboard/Android 能力声明与下载回归 | 通过；Three 安装版明确 503 |
| 仓库 | `git diff --check`、repository gate | 通过 |
| 三引擎切换 | Three.js / Deep WebGPU / Deep WASM 保存、回退、恢复、移动端视口与 5xx | 通过；性能结论见引擎专项报告 |

## 真实命令与结果

### 通过项

| 命令 | 结果 |
|---|---|
| `pnpm --filter @bim-studio/contracts typecheck` | 通过 |
| `pnpm --filter @bim-studio/contracts test` | 36 files / 342 tests 通过 |
| `pnpm --filter @bim-studio/api typecheck` | 通过 |
| `pnpm --filter @bim-studio/web typecheck` | 通过 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | 最终 7/7 通过，含发布资源路径拒绝与运行环境物化 |
| API 本地鉴权、SQLite、数据集成、Native/Android/Three 发布 10 文件聚焦测试 | 126 通过 / 1 按设计跳过 |
| Web Tauri、项目迁移、发布入口 7 文件聚焦测试 | 56/56 通过 |
| `node apps/desktop/scripts/smoke-local-publication-runtime.mjs` | 通过：本地令牌 200、Native/Dashboard 路由 400 参数拒绝、Three 503 精确诊断 |
| `git diff --check` | 退出 0；仅现有 CRLF→LF 提示，无空白错误 |

本地 sidecar 的 400 不是能力失败：请求已命中已注册的 Native / Dashboard 路由，只因烟测故意发送空业务载荷而被参数层拒绝。Three 返回 `THREE_WEBVIEW_WORKSPACE_BUILDER_UNAVAILABLE`，与资源清单 `installedBundleAvailable=false` 一致，没有把仓库构建能力伪装成安装版能力。

### 包级全量与隔离复跑

- API 全量首轮：232 files 通过、1 skipped、7 files 失败；1547 tests 通过、13 skipped、11 tests 失败。并发运行同时占用工业 worker、PowerShell、Git、sharp 和临时目录，失败主要表现为 5–20 秒超时及随后 `ENOTEMPTY`。
- 对 `industrialFormatWaitingAcceptance`、`industrialJobHost`、`modelConversionDurability`、`jtInspectionAcceptance`、`nativeSceneCandidateCompiler`、`scriptGitService` 逐文件按原超时隔离复跑，分别 9/9、11/11、13/13、4/4、10/10、4/4 全部通过；因此归类为并发资源竞争，不是确定性产品回归。
- `dashboardPortableZip.test.ts` 隔离复跑确认旧断言与真实合同不一致，而且 portable ZIP 只携带引用限制条款的 `LICENSE`，没有把被引用的 `LICENSE-RESTRICTIONS.md` 一同交付。现已让生产归档携带 `LICENSE`、`LICENSE-RESTRICTIONS.md` 与 `THIRD_PARTY_NOTICES.md`，三者都进入 manifest 哈希；测试按当前 MIT 标题、限制条款引用和限制正文断言，5/5 通过。
- 为排除其余失败，使用 `pnpm exec vitest run --exclude src/dashboardPortableZip.test.ts --maxWorkers=4` 控制并发重跑 API：238 files 通过、1 skipped；1553 tests 通过、13 skipped。除上述旧许可证断言外，API 包级回归全绿。
- 修复后执行 `pnpm exec vitest run --maxWorkers=4`：239 files 通过、1 skipped；1558 tests 通过、13 skipped；API 包级全量恢复全绿，TypeScript 类型检查同步通过。
- Web 全量首轮：729 files 通过、3 skipped、3 files 失败；4348 tests 通过、3 skipped、4 tests 失败。`architecture.test.ts` 6/6 与 `layerDragPerformance.test.ts` 3/3 隔离复跑通过，属于并发负载超时。
- `StudioDeepWasmBridge.test.ts` 首轮及隔离复跑确认 Node 无 `requestAnimationFrame` 时失败。并行 WASM 任务修复调度降级后，本门禁复跑 3/3 通过。该结果只证明桥单测恢复，三引擎完整 E2E 仍等待引擎任务最终产物。
- 修复后使用 `pnpm exec vitest run --maxWorkers=4` 控制并发重跑 Web 包级全量：732 files 通过、3 skipped；4352 tests 通过、3 skipped。Web 类型检查与包级全量均已恢复全绿。

### 真实 Tauri 页面与底层连接

- 本地工作台以动态回环端口启动包内完整 API；Windows 扩展路径 `\\?\D:\...` 在交给 Node 前转换为普通绝对路径，修复 `EISDIR: lstat 'D:'`。Rust 路径测试覆盖盘符路径、UNC 保留及目录穿越拒绝。
- 二维数据 socket 不再错误连接 `tauri.localhost`，而是复用当前运行配置的 API origin。真实握手为 `ws://127.0.0.1:30180/api/projects/default/data/ws`、HTTP 101，页面显示“数据在线”。证据：`test-output/global-integration-gate-20260924/tauri-ws-final-2d-direct.json`。
- 真实页面依次进入二维、资源、三维和发布；发布请求返回 201，整段导航没有 HTTP 5xx。证据：`tauri-final-resources.json`、`tauri-final-3d.json`、`tauri-final-publish.json`。
- 二维顶栏“二维 AI 助手”打开通用 `AiAssistantPanel`：可见会话、新会话、10/10 来源、建议、模型和思考配置，没有旧 `DashboardAiDraft` 并行入口。证据：`tauri-final-2d-ai-open.json`。
- 顶栏复用现有优化品牌图 `apps/web/public/brand/logo-titlebar.png`（48 px 源文件、约 5.4 KB），没有新建另一套 Logo。聚焦组件测试 2/2；真实客户端截图 `tauri-local-workspace-final.png` 可见 20 px 猴子图标，不再是黄色占位方块。

`net::ERR_ABORTED` 只发生于页面切换时被主动取消的长轮询；相邻请求继续返回 200/204，不是 502。所有证据均来自真实 `bim-studio-desktop.exe` + WebView2，不以 sidecar HTTP 烟测替代 GUI。

### 三引擎与发布播放器

- 三引擎最终周期通过：Three.js / Deep WebGPU / Deep WASM 三画布均为 728×748；保存、回退、恢复、移动视口与 0 HTTP 5xx/运行错误通过。
- WASM 去除隐藏 Three 矩阵/LOD 重复遍历后，frame p95 从 13.7 ms 降到 7.1 ms，React commit 16 降到 12；WebGPU 去除重复 scene traversal 后 queue-clear 从 26.0 ms 降到 20.1 ms。WebGPU frame p95 13.7 ms，仍未超过 WebGL 的 7.1 ms，因此不写成性能领先。
- Three 发布包经生产 sidecar 生成独立 EXE：58,183,856 bytes，SHA-256 `73fdccc67341ba91fd80f5c306a76823195825ab80b87627a31f87e59c0092bf`，package `522c6957e2f90d41`，payload `d3701cb9…715eb`。真窗 canvas 1800×1125、fatal=null、标题栏亮度 32；CDP 实点工具坞后 `aria-expanded` 从 true 变 false、宽度 269.6 px 变 44.6 px，截图差异 8,547 个采样像素。证据：`test-output/final-three-scene-viewer/`。

### 当前阻断

1. `pnpm --filter @bim-studio/desktop verify:bundle`：本地 API、发布资源、Web 离线资源与主程序未报告缺失，但 `src-tauri/target/release/bundle/nsis`、`msi` 目录不存在；当前尚未生成可验收安装包。
README 恢复为纯增量后复跑 `pnpm gate:repository`，门禁测试 5/5 且内容检查通过；前述 README 两项失败已关闭。

最终复核再次执行 Web TypeScript、repository gate 与 `git diff --check`，三项均退出 0；diff check 仅报告现有 CRLF→LF 提示。

## 阶段结论

底层 SQLite / 本地文件存储、desktop-local 回环令牌、统一 API 路由、Web 消费方、项目迁移与 Native/Dashboard/Android 条件发布链在本阶段的类型与聚焦测试中已贯通。当前不能宣称完整发布通过：桌面 NSIS/MSI 尚未生成，Three WebView 安装版构建资源明确未随包交付，仓库许可证文案与旧测试断言也未统一。
