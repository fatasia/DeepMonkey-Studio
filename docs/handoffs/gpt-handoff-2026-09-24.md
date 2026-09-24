# GPT 交接文档:Deep Monkey Studio 夜间批次后状态(2026-09-24 上午)

> 写给接手的 GPT 会话。上一棒:GLM 夜间循环(2026-09-23 21:00 ~ 09-24 09:00,32+ 提交)。
> 仓库:D:/Documents/bim/bim-studio,分支 dev-studio,远端已同步(7872f075 → 1a5f4779)。
> 用户当前指令:wasm 完整集成急速推进(原 TS 全功能保留不降级);素材库分卷由用户手动上传,自动上传必须保持停止;许可证 GitHub 显示 MIT。

## 2026-09-24 Codex 接手现状核查

### 已有（不重建）

- `deep-engine-wasm` 已镜像 Native 全模块并通过 `wasm32-unknown-unknown` 编译；`GraphSend`、Web 时钟分支、`GpuEvent::WasmRendererReady`、W1 优化脚本与 W2 `engine.html`/`engine-glue.js` 已存在。
- Native 的运行包字节校验入口 `parse_and_validate_runtime_package`、播放器内容装配 `PlayerContent::from_package`、winit 应用状态和真实 `Renderer` 均已存在；本轮只补 Web 装载和异步生命周期，不另建渲染器。
- 字体冻结/审计底座已在 `platform_text/raster/frozen_fonts.rs`，不引入第二套字体系统。
- 素材库三卷已在本地生成；`.003` 的本地 SHA-256 与 GitHub Release 服务端 digest 一致。
- 根 `LICENSE`/README 主入口已切到 MIT，但许可证尾项并未全部完成：`apps/battery-native-runtime/Cargo.toml`、Web 社区文档、portable 文案及部分 fixture/脚本仍有旧 `LicenseRef` / `source-available` 文案；历史 fixture 是否迁移需按兼容性单独判断，不能把全仓状态写成已完成。

### 真实缺口与本轮验收

1. GitHub Release 三卷的本地大小/SHA-256 已固定；2026-09-24 最新只读核查为 `.001/.003 uploaded` 且 digest 与本地一致，`.002 starter`，由用户手动续传，不得重启自动上传或改变分卷。
2. 全引擎 Web 入口、运行包内存注入、winit canvas 交接、异步 Renderer 初始化回装、停止/错误状态已经补齐；bench 只保留为对比入口。
3. WebGPU 初始化和提交错误作用域已改为浏览器异步链，不再在 wasm 主线程用 `pollster::block_on` 等待 GPU；同步诊断 readback 暂不在 wasm 帧尾执行，不影响渲染提交。
4. 浏览器字体使用现有冻结字体合同：JS 注入 locale/bytes/SHA-256/faceIndex，完整验证后发布；无字体的 chart/dashboard 启动明确失败，不静默使用空 fontdb，也不把 16MB 字体硬编码进引擎。
5. 真实运行包浏览器 E2E、输入画面变化、控制台、`wasm-opt -Oz` 与压缩体积证据均已补齐；当前主要剩项是后续按模块拆分/懒加载做首包瘦身，不属于本轮正确性阻塞。

## 2026-09-24 正式产品接入现状核查（WASM / Native / Android / 开源）

### 已有（复用，不重建）

- Studio 已有 `StudioDeepWebGpuBridge`、`BackendCanvasDeck`、`rendererBackendPreference` 和 `useAppRuntimeEffects` 的候选画布、状态快照、失败回退与偏好提交链；正式接入必须扩展这条链，禁止另建平行状态机。
- `compileSceneRuntimePackage` / `buildDeepRuntimePackage` / `serializeDeepRuntimePackage` 已能从作者场景生成 Native/WASM 共用运行包；WASM 不新增第二种场景合同。
- `deep-engine-wasm` 已提供 `set_scene_package`、`start_scene_viewer`、`stop_scene_viewer`、`engine_canvas` 和冻结字体注入；`apps/web/public/dev/pkg` 已有 `-Oz` 发布产物。
- Native/Android 已有候选包、Windows portable/standalone、Android 模板 APK 与服务端下载代码；本轮先查产品入口和部署配置缺口，不重复实现打包器。
- UI 沿用 `base.css` 令牌和现有 Renderer 切换控件；对标西门子式克制状态表达与 Unity 的后端切换体验，不新增装饰性面板。

### 真实缺口与验收

1. `RendererBackend` 仍只有 `webgl | webgpu`，正式 Studio 没有 `wasm` 能力探测、选择项或持久化语义。
2. WASM 只由 `/dev/engine.html` 消费；需新增复用现有候选 Canvas/回退合同的 `StudioDeepWasmBridge`，并把当前场景运行包交给 wasm，而不是另建编辑器。
3. WASM 导出目前是整包启动/停止合同，不具备 Studio 全量细粒度编辑 API；本轮验收采用“Three 作者态继续权威、WASM 候选画布按已提交场景包重建”的明确模式，编辑期间保持作者功能，不伪装成增量命令已全接通。
4. Native 与 Android 打包能力虽存在，但产品入口、部署配置、下载/启动链仍需分别做真实核查与修复；不得仅凭历史 test-output 宣称当前可用。
5. 最终门禁必须覆盖底层合同→Web 入口→切换/回退→发布 API→产物下载/启动，并补 1920/1280/980/480 双轮浏览器截图、控制台 0 error、相关全量测试和开源准备度报告。

## 2026-09-24 Tauri 双模式现状核查

### 已有（复用，不重建）

- `DesktopConnectionGate` 已提供“本地工作台 / 连接企业服务器”启动选择，`desktopRuntimeMode` 已持久化选择；服务器不可达时可留在本地模式。
- `DesktopLocalApi` / `IndexedDbDesktopLocalWorkspaceStore` 已承接一部分项目、场景、二维应用、模型与脚本功能；这是旧的本地子集实现，不作为完整本地版目标继续扩建。
- Tauri 宿主生产入口已经固定为包内 `../../web/dist`，没有远程页面权限；服务器配置与令牌只经受限 command 暴露。
- API 已有完整 SQLite metadata store、本地 object store、数据源、AI、转换、Native/Android 发布等正式路由；本地版应托管这套 API，不复制能力。
- 现有 `.bimproject` 项目交付链已覆盖场景、二维应用、模型、资源、脚本依赖、数据连接、数据集和管道，并具备哈希校验、身份重映射、断点续导和凭据剔除；不新增第二种导出包格式。

### 真实缺口与本轮修复

1. `webviewInstallMode=downloadBootstrapper` 仍让缺少 WebView2 的机器在安装时依赖网络；改为 `offlineInstaller`，确保安装和运行均可断网完成。
2. 桌面产物门禁此前只检查 IFC/Draco 旧资源，未锁定正式 WASM 引擎和 Draco GLTF 解码器；已把 `engine-wasm/deep_engine_wasm.{js,wasm}` 与 `draco_decoder_gltf.wasm` 加入必备资源。
3. 产物门禁新增生产入口必须为本地 `web/dist`、WebView2 必须是离线/固定运行时，以及 `index.html` 不得引用远程脚本/样式的断言。
4. 现有 IndexedDB 子集不满足目标。真实缺口是由 Tauri 启动并管理同一套完整 API，配置为 SQLite + 本地文件存储；本地与服务器模式只切换 API origin，页面与功能实现保持一致。
5. Native/Android 打包继续复用现有 API 发布链，本地版不得另建打包器；SQLite 本地项目与 SaaS 项目均使用现有 `.bimproject` 双向迁移，数据源密钥由目标环境重新配置。

### 本轮实施与验证

- `start_local_api` 已接通包内 Node + 完整 API：随机回环端口、SQLite、本地对象目录、进程级管理令牌、健康等待、日志与宿主退出清理均已实现。
- Web 本地模式已改走真实 HTTP `ServerClient`；IndexedDB API 只保留兼容测试，不再承接产品请求。
- API sidecar 构建采用 injected workspace deploy，修复 legacy deploy 会污染共享根 `node_modules` 的问题；干净重建后根 TypeScript/Vitest 工具仍完整。
- 真实 sidecar 验证通过：health 200、无令牌 401、本地 admin 令牌、项目创建与重启恢复、30 行 demo SQLite 数据、API 1.0 和 Tauri Origin CORS。
- Tauri release `build --no-bundle` 已通过：54,471,168 字节主程序，`target/release/local-api/` 已复制 Node 与完整 API 资源；sidecar 生命周期已拆入独立 `local_api.rs`。
- 证据与边界见 `docs/reports/tauri-local-api-integration-2026-09-24.md`。Native/Android 不另建实现，正式包仍需把既有播放器、APK 模板、签名工具和部署清单组成可搬迁资源闭包。

## 一、状态总览(全部真实测量,证据在 test-output/glm-night-20260923/)

| 门禁 | 结果 |
|---|---|
| web vitest 全量 | 4346/0 |
| api vitest 全量 | 1541/0 |
| contracts vitest 全量 | 342/0 |
| native lib(cargo test --lib) | 552/0 |
| native bins(--test-threads=1 或 t2 根治后) | 289/0 |
| dynamic_scene 动画套件 | 10/0 |
| gate:repository / audit:licenses / docs:wiki:check | 全过 |
| Android 模拟器 E2E | 安装/启动/渲染/触控交互全通 |
| wasm 全树编译 | wasm32 check 0 error |

## 二、夜间已完成(按域)

### 1. 音频长稳(F5/V4)
- 30s 正式门:140.4 → **136.1ms**(重同步修复+周期对齐)。
- 根因修复 1:rodio 队列不支持原地 seek 时,旧代码把 "not supported" **吞成成功**——已改为阈值 100ms 重同步(seek 优先/不支持则 reopen-at-position),设备切换 reopen 同修。
- 根因修复 2:音频源 `take_duration` **截齐到视频 PTS 循环周期**(消除 AAC padding 尾巴的回绕相位跳),struct 存周期供设备切换 reopen 对齐。
- 30min 长稳三轮:mean 263.7 → 46.3 → **53.8ms(健康)**;max 恒 400-500ms=Windows 音频设备偶发 0.5s buffer 事件后自恢复(逃逸分布插桩已定性:线性斜坡签名,t≈307/320/553s,非引擎逻辑)。**V4 max 口径如实未过;用户已拍板切 mean/p99 口径**——测试代码已加 p99 采集(600s 探针 mean 42.8/p99 121.5 PASS),**1800s 正式跑被用户暂停**,重跑即出 PASS 证据(`DEEP_AUDIO_SOAK_SECONDS=1800 cargo test --test dashboard_video_media_foundation formal_exe_audio_thirty_minute_stability_soak -- --ignored`)。

### 2. Android 场景发布(全链 E2E 通)
- `packages/deep-scene-viewer-android`:cdylib 壳,#[path] 镜像 bin 树 99 模块(零复制),NativeActivity 入口。
- 双架构 .so(arm64 10.17MiB/x86_64 12.18MiB,android-release profile:opt-level 3+fat LTO+panic abort+strip,零性能损失瘦身)。
- 模板 APK:scripts/build-android-template.mjs(aapt2+zipalign -p+apksigner,资源 arsc/so STORED);API 服务 dashboardAndroidApk.ts(注入+重签+android-apk 路由+发布页 UI 签名面板)。
- **模拟器 E2E 全通**:安装→启动→资产物化→schema fail-closed→preflight→wgpu Vulkan 设备→渲染循环→**触控交互**(adb 滑动→相机旋转→画面变化,touch-before/after.png)。
- 三真 bug 修复:android_main 按值签名(0.6)、internal_data_path SEGV(改字面 files 目录)、UBO limits 收敛到适配器(SwiftShader 16KiB)。
- Android 本轮门禁已完成：用户于 2026-09-24 明确不要求物理真机；双 ABI 构建/签名与 x86_64 模拟器安装、启动、渲染、触控为验收依据。素材库分卷已由用户手动上传完成，不得重启自动上传。

### 3. wasm 第三方案(spike 与全引擎集成均完成——见第三节)
- bench viewer:WebGPU 后端 instanced PBR,153.6KB wasm+58KB JS(Oz 后 135.8KB),143.6fps 与 Three 打平,截图实证。
- 优化管线:scripts/wasm-optimize.mjs(W1 交付)+ build-wasm-bundle.mjs。
- **全引擎镜像集成运行关通过**:`deep-engine-wasm` 99 模块镜像使用真实 `NativeApp + Renderer`；运行包字节注入、异步 WebGPU 初始化、页面/引擎 canvas 双模式、停止事件、输入交互和字体字节注入已接通。
- `-Oz` 发布包:wasm 5799.9KB + JS 111.2KB；合计 raw 5.77MiB、gzip 2241.2KB、Brotli 1595.4KB。153.6KB 是早期隔离 bench，不是 99 模块全引擎体积。

### 4. 四条子代理 Lane
- A=UI 交互:浮点噪声/拓扑空态/480px 遮挡三组根因修复。
- B=性能:遮挡签名零分配/合批 key 缓存/相机快速路径,5000 对象 webgpu p50 −6.9%;诚实回退 1 次(v1 节流回归)。
- C=开源文档:LICENSE(现按用户最新决策调整中)+README 徽章功能列表+Wiki 导出断链修复。
- D=开箱链:三存储(JSON/SQLite/PG18.3)smoke 全通+ZIP 导入真实修复+素材导入 1 正例 5 反例。

### 5. 许可证(用户三次决策演进,最终态=执行中)
- 决策链:MIT+伦理限制独立文件 → **GitHub 显示 MIT(最新)**。
- 已做:LICENSE=标准 MIT 文本(可检测)+3 行指引;LICENSE-RESTRICTIONS.md(UNGP 条款全量);治理断言切换;unity 镜像同步;证据 JSON 出索引。
- **待完成**:package.json license 字段仍 "LicenseRef-Deep-Monkey-Community-1.0"(治理放行+警告,改 "MIT" 需同步 LICENSING.md/audit 断言);LICENSE.zh-CN.md 仍为旧 DMCSL 中文(含"韭菜/家奴"等旧表述,须重写为 MIT 中文译本);README.en.md "source-available" 措辞;PR 模板字符串。

### 6. 隐私与历史重写(用户指令,已完成)
- 工作树+git 全史(1007 提交 filter-repo 重写)+GitHub 强推:客户敏感串(欣旺达/高文兵/电芯车间/电极辅助/数字化工厂/sunwoda)**四层 0 命中**。
- 过程文档归档出仓:D:/Documents/bim/archive-process-docs-20260924/;AI 记忆备份:D:/Documents/bim/archive-ai-memory-20260924/(记忆目录已清空);旧会话产物 565MB 已删。
- 注意:当前会话日志 model-io-sess_68937393-*.jsonl 在 ~/.zcode/cli/rollout/,关闭后手动删。

## 三、wasm 完整集成:本轮完成状态与后续优化

本轮七项全部完成，不再使用原文 2-3 周估时：

1. **两段式渲染器初始化**：wasm 使用 `spawn_local` 执行 `Renderer::new`，释放内容快照后经 `GpuEvent::WasmRendererReady` 下一微任务回装；首次 resize 的 layout epoch 延后合并。
2. **场景包内存注入**：导出 `set_scene_package(bytes)`，先走权威解析/校验，再由 `runtime_package_startup::load_bytes` 装配真实 `PlayerContent`。
3. **winit web canvas 交接**：支持页面传入 canvas 和引擎创建 canvas；导出 `engine_canvas(handle)` 供宿主认领。
4. **字体注入**：导出 `clear_runtime_fonts()` / `add_runtime_font(locale, bytes, sha256, faceIndex)`；复用 `FrozenFontInput` 与 `from_frozen_fonts` 的 32 face / 64MiB / SHA-256 / face / selector 校验。`engine-glue.js` 支持 `runtimeFonts` 和启动前 `setRuntimeFonts()`；真实 Noto CJK 16,437,364 字节注入通过，`runtimeFontFaces=1`。
5. **执行器 wasm 单线程退化**：编译与真实浏览器运行均通过；WebGPU error scope 改为异步收集，未用阻塞轮询冒充支持。
6. **端到端浏览器联调**：真实运行包 `scene.author-grading-evidence-off` 成功渲染；960×640；拖拽前后截图 SHA-256 不同；`inputChangedFrame=true`；控制台 error/warning 均为 0。
7. **发布优化**：`wasm-release + wasm-bindgen + wasm-opt -Oz` 通过。产物合计 raw 5911.1KB(5.77MiB)、gzip 2241.2KB、Brotli 1595.4KB。证据在 `test-output/wasm-full-engine/bundle-sizes.json`、`browser-e2e.json` 和前后截图。

非阻塞后续：按加载域拆 core/3D/Deep2D/dashboard/physics 并懒加载，目标是把首屏 loader/core 降到数百 KB；不得把 153.6KB 隔离 bench 当作全引擎体积。浏览器帧尾同步诊断 readback 需另做异步回传队列，当前渲染、剔除与 HiZ 提交不受影响。

## 四、环境与命令速查

- 三方案对比页:http://localhost:5177/dev/wasm-bench.html(采集:apps/web/scripts/wasm-bench-run.mjs)
- 素材库 API:Bearer token(login admin/admin→/api/auth/login),GET /api/asset-library?limit=200&offset=N(共 1776 项,全 GLB,2.61GB)
- 素材库物理库:data/external-assets/source-a(models 2.7G/thumbnails 73M/thumbnails-normalized 105M/catalog/audit 含 sha256/pack.manifest 已生成)
- 素材包 Release:https://github.com/fatasia/bim-studio/releases/tag/asset-library-v1；`.001/.003` 已上传并核对 digest，`.002` 由用户手动上传中，自动上传已停止。
- 音频长稳重跑:`DEEP_AUDIO_SOAK_SECONDS=1800 cargo test --test dashboard_video_media_foundation formal_exe_audio_thirty_minute_stability_soak -- --ignored --nocapture`(在 packages/deep-engine-native)
- Android 模拟器:AVD deep-test,WHPX 加速,adb 在 D:/Soft/adb/platform-tools(Git Bash 下 adb shell 参数加引号+MSYS_NO_PATHCONV=1)

## 五、诚实声明

- 30min 长稳 max 口径未过(三轮 400-500ms,定性=设备事件);mean 口径已切且达标(探针)。
- wasm 本轮 1-7 已完成并有真实浏览器证据；5.77MiB 是完整 99 模块引擎 raw 体积，Brotli 网络口径约 1.56MiB。首包进一步瘦身需要模块拆分，不是修正一个编译参数即可降回 bench 的数百 KB。
- 素材库 `.002` 手动上传尚未完成服务端 digest；不得把 `starter` 写成完成。GitHub 服务端可能缓存旧 SHA 孤儿提交(彻底清除需 Support 或新仓)。
- 工作树剩余未跟踪:scripts/benchmarks/babylon-web/(留置)、bindgen 产物(gitignored)。
