# 三引擎切换与交互集成报告（2026-09-24）

## 结论

Three.js WebGL → Deep WebGPU → Deep WASM → WebGL 的真实浏览器全周期在最终候选版本通过：偏好提交/恢复、作者画布输入所有权、显式场景保存、失败回退、移动端弹窗、0 HTTP 5xx、0 非预期控制台错误、0 黑帧。三后端 CSS 与 backing surface 均为 `728×748`，不再用旧的 `960×640` WASM 结果参与比较。最终证据为 `test-output/engine-switch-integration/report.json`，SHA-256 `e008935b6ab4a3db58d20659edcba3f6d58ea2407b0e7ba2abbc7e9657487509`。

功能门禁通过，用户要求的“同画质下 Deep WebGPU/WASM 全面超过 WebGL”性能门禁仍未通过。现有顺序烟测每个后端各执行 121 次 orbit 输入，但没有在后端之间恢复同一相机：rAF 帧间隔 p95 为 WebGL `7.1ms`、Deep WebGPU `13.7ms`、Deep WASM `7.1ms`，只能用于发现交互热路径，不能作为等质配对排名。WASM 已从 `13.7ms` 降到这轮 WebGL 的帧节奏，但尚未证明超过；本报告不把功能通过写成性能完成。

本轮确认并修复三类“编辑器操作很卡”的热路径：相机信息每帧写入顶层 React 状态；方向魔方每个相机事件提交 React；Deep WebGPU 在纯相机帧重复投影/上传场景并反复启动 TAA 收敛。方向魔方现在每帧只更新 compositor transform，80ms 静止后才用 React 更新活动面与可访问状态；相同 121 次输入下，React commits 收敛为 WebGL `7`、WebGPU `10`、WASM `12`。剩余主要瓶颈已转到 Deep GPU 提交与 WASM `set_view`/redraw 链。

## 现状核查

### 已有（不重建）

1. 全仓关键词与未跟踪文件：检索 `packages/*/src`、`apps/*/src` 及 `git status --short` 后，确认已有 `StudioDeepWebGpuBridge`、`StudioDeepWasmBridge`、`DeepWebGpuBackend`、`ThreeProjectionBridge`、渲染设置 UI、偏好提交/恢复、WASM 产品接入 E2E；未新建第二套切换器、场景 store 或编译器。当前相关桥接与报告含未跟踪文件，均作为既有并行工作保留，未覆盖其他任务修改。
2. 契约层：核对 `packages/contracts/src`、`packages/deep-engine/src` 与 Web viewer 类型后，沿用 `RendererBackend`、场景 `CameraState`、Deep `RenderView` / `RenderPacket`、`SceneTransformGraph` / `SceneChangeset` 和发布运行包契约；未新增平行合同。`ApplicationDocument` / `SceneSnapshot` 继续是可迁移的编辑权威。
3. 依赖：核对根目录、`apps/web/package.json`、WASM/Native `Cargo.toml` 后，确认 Playwright、Sharp、Vitest、Three.js、wgpu/winit 与 wasm-bindgen 已在用；未新增运行依赖。WASM bench 只改用已有 Cargo feature 隔离，产品能力不裁剪。
4. 消费方：调用点显示切换由 `useAppRuntimeEffects` 编排，视口由 `AppStudioViewport` 消费；`compileSceneRuntimePackage` 已能从 `SceneSnapshot` 编译 runtime package，`PbrRenderer.setPacketValidated` 已能消费 `RenderPacket`，不应重复实现编译链。当前 WebGPU 仍通过 `ThreeProjectionBridge/projectionRoot`，WASM/Deep 输入仍通过 `ViewerEngine`，这是实际待迁移边界。
5. 测试与证据：复用并扩展 `StudioDeepWebGpuBridge.test.ts`、`StudioDeepWasmBridge.test.ts`、`cameraFramingIntegration.test.ts`、现有产品 E2E、Native Rust 测试和 `test-output`；检查既有三引擎报告、WASM 产品报告与 Native 首帧证据。小型 `/dev/wasm-bench.html` 只用于开发诊断，没有冒充完整 Studio 场景或等质性能证据。
6. 规格与交接：核对 `docs/specs/deep-web-parity-contract-2026-09-21.md`、`docs/handoffs/gpt-handoff-2026-09-24.md`、`docs/handoffs/engine-capability-expansion-plan-2026-09-22.md`、`docs/active-task-recovery-ledger.md`、WASM 产品接入报告和现有 `docs/reports`。已有 SceneSnapshot 编译、SceneTransformGraph/TLAS、PbrRenderer 和发布包链全部复用；真实缺口是隐藏 Three 作者/输入权威、WebGPU 的 Three 投影桥、编译链内残留 Three 数学/几何，以及尚未通过的同画质性能门槛。

### 真实缺口

- WebGPU 地面网格纹理原为 2000²，不符合 Deep 2 的幂尺寸合同；改为 2048²并加断言。
- 无后处理路径缺少 sRGB 天空显示域合成；补齐 display-space 背景管线，并修复固定 MRT 与帧图裁剪不一致。
- WebGPU 作者帧无条件 `sync(root)`，相机拖动时重复遍历/资源 diff；纯相机帧现在只更新 `RenderView` 并绘制，停止后执行一次尾部完整 sync，保证同帧场景/材质编辑不丢。
- 相机拖动每帧反复启动 16 帧 TAA 收敛；交互帧只绘制最新视图，停止后再收敛。
- WASM 相机每个作者帧无条件发事件；改为 epsilon 去重、每 RAF 最多一次、只消费最新相机。
- WASM 场景 revision 刷新时主动隐藏已成功画布，造成背景/黑闪；刷新期间保留最后成功帧，失败才原子回 WebGL。
- WASM 浏览器窗口沿用了桌面默认 `960×640`，同轮 WebGL/WebGPU 实际为 `728×748`，旧帧时序与像素对比不等质。wasm32 窗口现在读取已挂载 Studio canvas 的实时逻辑尺寸，再由 winit 按设备比例配置 backing surface；E2E 对三后端 CSS 与 backing 尺寸逐项断言。
- `setCameraInfo` 每个相机帧写顶层 App 状态，导致大块 Studio React 重渲染。方向立方体现直接订阅引擎相机事件，只重绘自身；顶层 `cameraInfo` 仅在 Inspector 信息层打开时以 250ms 合并并用 transition 提交，实际引擎相机、保存快照和渲染不节流。
- 方向魔方的局部订阅最初仍在每帧 `setState`；现改为直接更新 `.cube-inner` compositor transform，静止 80ms 后才提交一次 React 以更新活动面/可访问状态。Deep WebGPU listener 也不再重复执行 `presentViewerFrame` 已完成的强制矩阵遍历；WASM 相机呈现不再更新完全不可见、且运行包不消费的 Three world matrices/author LOD。
- E2E 曾因读取不存在的失败状态元素隐式等待 45 秒，把真实 2–3 秒切换误报成 49/48 秒；改为无等待存在性检查。

## 实现与正确性

### WebGPU

- 相机变化帧：重新读取当前位置/目标/fov/near/far 与环境视图，跳过场景投影和 GPU 资源同步；每个作者帧只提交最新视图。
- 相机停止 80ms：执行一次完整场景同步，再启动有限 TAA 收敛。单测覆盖“相机帧不 sync、只 render；同帧 scene edit 在尾部 sync 被提交”。
- 候选准备使用已发布 packet 的 `prepareView` 验证最新相机，避免第二次完整场景投影。
- 切换后作者 canvas 始终保留 `pointer-events:auto`，Deep canvas 只呈现。

### WASM

- `WasmCamera → Renderer::set_view` 不重建 renderer；重建只由 `WasmScenePackage` 触发。JS 桥现在先合并相机事件，再进入 Rust 的 CSM/culling/LOD/cluster 更新。
- 16 张连续拖动合成帧检测为 0 黑帧；相机输入前后截图哈希不同，证明 Deep 呈现跟随作者输入。
- scene revision 更新不再先把 WASM canvas 置透明，避免主动制造闪烁。

### 相机与视觉一致性

- Three 作者相机继续是唯一权威。最终保存证据包含 position `[-6.261565, 57.247493, 4.066120]`、target `[0,1,0]`、orbit；WebGPU 直接读取同一相机，WASM 单测逐项断言传入 position/target/focal/near/far。
- WebGPU 无后处理天空改为 display-space sRGB，背景不再重复 tone map。三后端仍会因渲染器材质/IBL 实现存在可见亮度差异，本轮没有宣称像素完全一致。

## Deep 编辑路径对 Three 的依赖矩阵

“不依赖 Three”指 Deep WebGPU/WASM 的编辑状态、输入、拾取和命令执行不再把 Three 场景当权威；WebGL 对照引擎本身仍可保留。当前只完成呈现后端，编辑路径尚未达到该门槛。

| 链路 | Deep WebGPU 当前依赖 | Deep WASM 当前依赖 | 可复用的已有权威/合同 | 状态 |
|---|---|---|---|---|
| 场景内容 | `ThreeProjectionBridge` 从 `projectionRoot()` 遍历 Three 对象并生成 `RenderPacket` | `SceneSnapshot` 直接编译 runtime package，不依赖 Three 几何遍历 | `SceneSnapshot` / `ApplicationDocument`、`RenderPacket`、runtime package | WASM 编译已独立；WebGPU 未独立 |
| 编辑命令/撤销 | `ViewerSceneCommandPort` 和 `EditorSceneWriteDriver` 读写 `ViewerEngine`/Three 对象 | 同一条 Viewer 命令链，revision 后重编 package | `SceneCommandTransaction`、`SceneChangeset` / `SceneTransformGraph` 已存在，不重建 | 未独立 |
| 相机与输入 | 隐藏的作者 WebGL canvas 持有 OrbitControls；桥读取 Three camera/orbit | 隐藏的作者 canvas 持有输入；桥原先直接读取 Three camera | `CameraState`；本轮新增 engine-neutral camera projection 标量端口 | 局部去耦，输入权威未迁移 |
| 拾取/选择/变换 gizmo | Three raycaster、TransformControls、对象索引 | 仍由同一 ViewerEngine 执行 | Scene SDK 对象引用与命令端口 | 未独立 |
| 环境/灯光/覆盖层 | 从 Three scene、author postprocess、grid/overlay 读取并转换 | package 编译消费 SceneSnapshot；运行相机单独推送 | 场景环境/灯光/后处理合同、Deep 2D/3D runtime package | WebGPU 未独立，WASM 静态内容已独立 |
| 呈现 | Deep WebGPU 独立 canvas/device/renderer | Rust/WASM wgpu 独立 canvas/device/renderer | `RenderView`、runtime package、renderer backend contract | 已独立 |

最小迁移不新增第二套场景 store：以现有 `ApplicationDocument` + `SceneTransformGraph`/`SceneChangeset` 作为编辑唯一权威，`EditorSceneWriteDriver` 改为面向 engine-neutral `SceneCommandPort`；WebGPU 直接消费 authoritative `RenderPacket` 增量，WASM 消费同一 changeset/资源差量；最后把相机控制、拾取与 gizmo 接到 Deep 的 ID/深度结果。完成前保留 Three 只作为 WebGL 对照执行器，不再作为 Deep 输入或场景同步源。

本轮已落地的安全切面：`StudioDeepWasmBridge` 不再导入 Three，也不读取 `PerspectiveCamera`，只消费 `CameraState` 与 `{verticalFovDegrees, near, far}` 宿主端口；相机方向魔方通过 Viewer 事件局部订阅。`@bim-studio/deep-engine/scene` 复用现有纯 scene 入口导出 `localTransformMatrix` / `multiplySceneMatrices`；新增无 Three 的 XYZ Euler→矩阵值函数。`compileSceneRenderPacket.ts` 的 root/GLB instance 与 `sceneSnapshotRenderPacket` 的普通基础体直接消费纯值矩阵，无生产消费者的 legacy `sceneModelMatrix.ts` wrapper 已删除；预制体几何编译边界仍适配 Three `Matrix4`。128 组随机矩阵 parity 与异常输入、44 个关联测试和 Web/Deep 类型检查通过。随后复核场景颜色路径：静态场景、模型与材质覆盖原先为每项颜色创建 Three `Color`，现统一由纯 `sceneHexToLinearRgb` 转换；逐 8-bit 通道的 768 个值与当前 Three 转换精确对拍，44 个场景编译测试及 Web 类型检查通过。通用 CSS 精确公式与当前 Three 近似式存在 1e-11 量级差异，故保持现行 3D 材质合同的数值兼容。这些只是依赖边界收窄，几何和预制体编译中的 Three、作者输入/拾取和 WebGPU 投影桥仍在，不能称 Deep 编辑权威迁移完成。

## 性能证据

测试环境：Chrome + WebGPU，1280×800，完整 Studio 场景；每后端 121 次 pointer move、连续 orbit 轨迹、16 张合成帧黑帧检查。机器仍有无关 Node/typecheck 进程，数据只用于同机回归和瓶颈定位。

现有 `gate-render-engine-comparison.mjs` 比较的是 Three WebGL / Three WebGPU，不是 Deep，不能作为“Deep 超过 WebGL”的证据。本节数据来自真实 Studio 三后端，但当前 `measureInteraction` 顺序执行三个后端，没有在每轮前恢复相同 `CameraState`；末帧中位亮度分别为 WebGL `40.62`、WebGPU `93.98`、WASM `39.74`，截图角度/缩放也不同。因此它是功能与延迟烟测，不是冻结质量合同下的配对 runner。用户要求的同场景、同相机、同画质、同输入轨迹、像素/SSIM 守卫与正确 input→present P50/P95/P99 门禁仍未通过，以下数据只保留为瓶颈基线。

| 指标（最终同尺寸、非同相机顺序烟测） | WebGL | Deep WebGPU | Deep WASM |
|---|---:|---:|---:|
| rAF frame p50 / p95 / p99 | 6.9 / 7.1 / 14.0ms | 7.0 / 13.7 / 14.0ms | 6.9 / 7.1 / 20.9ms |
| pointer → author callback p95 | 2.1ms | 4.3ms | 0.5ms |
| pointer → backend submit p95 | 1.5ms | 8.0ms | 23.4ms |
| pointer → queue clear p95 | N/A | 20.1ms | 28.1ms |
| React commits / actual duration | 7 / 83.0ms | 10 / 169.9ms | 12 / 215.5ms |
| 黑帧 | 0 | 0 | 0 |

旧的负 `pointer → author frame` 口径已删除；最终脚本用回调观察时钟，不再混用 rAF 帧起始 timestamp。`pointer → queue clear` 来自 `onSubmittedWorkDone()`，包含此前排队工作，只是队列清空上界，不是单帧 GPU 时间。浏览器仍没有为普通 WebGPU canvas 暴露逐帧 compositor present timestamp，因此 rAF 间隔只作为画面节奏代理；正确的 input→present P95/P99 仍需 CDP compositor trace 后才能作为硬门禁。

WebGPU p95 仍高于 WebGL，WASM 帧节奏已追平但 input→submit 仍慢。提交前的 React 热点已明显收敛，剩余主要在完整 PBR 帧与 GPU 队列阶段；本轮没有通过降低材质、阴影、雾、SSR、AO 或 TAA 功能伪造“快”。WebGPU 相机队列已做受限 A/B：单 in-flight 的 pointer→submit p95 `12.6ms`、queue-clear p95 `31.8ms`，均劣于双 in-flight 最终值 `8.0ms` / `20.1ms`，所以产品保留双 in-flight + latest-view 合并，不用串行 fence 阻塞吞吐。

静态帧图显示，默认场景虽不执行作者关闭的 SSR、体积雾和 Bloom，但 1280 宽视口仍包含约 11 个完整 Hi-Z mip pass、GTAO 的 3 个半分辨率 pass 与 1 个全分辨率合成、TAA、display output 和 spatial AA，外加几何、LOD/culling 与按需阴影。本轮将可选 `GpuTimer` 扩为 4 个 timestamp，额外提供阴影+opaque、中间后处理、output 三段粗计时；22 个聚焦测试、Deep build 和 Web 类型检查通过。真实 GPU 分段样本与逐 pass 计时尚未采集，frame-graph receipt 对逐 pass 时间仍标为 unavailable。

静态场景空工作优化：现有 `PacketBuffers.drawProfile().hasDeformation` 可直接判定是否存在 GPU 变形。原路径每帧都为 `deform` 与 `cluster-lights` 各生成独立 preparation command buffer；无变形时前者为空。当前无变形帧将 Forward+ 准备编码到主 command buffer，并跳过空变形编码，提交 buffer 数理论上由 3 降为 1；有变形帧仍保留原并行组。Deep 类型检查、6 文件 36 个聚焦测试及构建通过；真实 GPU submit 计数、像素和延迟 A/B 尚待采样，不能把理论减少计为性能提升结论。

后续零画质损失优化按证据顺序推进：

1. 已完成 1/2 帧 in-flight 同轨迹 A/B，并保留更快的 2 帧上限与 latest-view 合并。下一步补 `frame-encode`、`queue-submit`、`present-acquire`、逐帧 GPU p50/p95/p99、实际 in-flight 深度和旧视图丢弃数，再与无上限策略对照；不能把 `onSubmittedWorkDone()` 的队列清空时间当成单帧 GPU 时间。
2. 按 `hasDeformation` 与 clustered-light 数量消除空 preparation command buffer；按 occlusion eligible batch 数量跳过无消费者的完整 Hi-Z/occlusion 链。两者都必须保持可见集合与输出像素一致。
3. 诊断模式扩展逐 pass timestamp，至少拆出 opaque/shadow、Hi-Z、AO、TAA、present；同时记录 `hiZMipLevels`、`occlusionBatches`、`shadowUpdated`、`postProcessPasses`，再决定是否做质量不变的 pass 合并或缓存。

真实切换阶段（修复 E2E 45 秒误等后）：

- WebGPU：外部 3.140s；module 52ms，环境 230ms，完整 scene upload 2.584s，frame validate 2.615s，publish 2.632s。
- WASM：外部 1.566s；module 55ms，运行包编译 575ms，renderer ready/publish 1.154s。
- 回 WebGL：95ms。

## WASM 首包体积

正式完整引擎保留，未以 bench/5000 cube 冒充产品：

| 产物 | s + Oz | z + Oz | 改善 |
|---|---:|---:|---:|
| WASM raw | 5,924,421 B | 5,187,736 B | -12.4% |
| WASM gzip-9 | 2,268,918 B | 2,009,743 B | -11.4% |
| WASM brotli-11 | 1,612,965 B | 1,452,694 B | -9.9% |

`bench::Viewer` 已放入默认关闭的 `bench-viewer` Cargo feature；开发 bench 显式开启，Studio 正式包不再携带重复 viewer/WGSL。体积证据：`test-output/engine-switch-integration/optimized-bundle-sizes.json`、`test-output/engine-switch-integration/gated-s-bundle-sizes.json`。

## Native 首帧

v4 发布 EXE 实测：163ms 创建窗口并显示“正在打开”，2.108s 选择 GPU，2.523s 完成 first present。用户 13:55:54 截图与该 2.36s 未绘制窗口区间一致，不是旧包假象。

修复将正式 Native 播放器窗口作为候选：首个真实 `RenderOutcome::Presented` 前隐藏，呈现后显示；GPU 初始化失败主动显示带错误标题的窗口。首帧 `RenderOutcome::Failed` 对 smoke/verification 仍 fail-fast，普通产品窗口则显示“first frame failed”并保留 `R` 重建能力，不再隐藏后静默退出。

隐藏窗口在 Windows 实测不会可靠派发首次 `RedrawRequested`，因此 renderer ready 后立即投递用户事件，从事件循环对隐藏 surface 执行同一 redraw 事务，仍只在 `Presented` 后显示；2 秒仍未呈现则写入失败状态并显示“first frame stalled”，拒绝无限隐藏等待。事件携带 renderer id，旧重建代次的迟到事件不会影响当前 renderer。WASM canvas 与 offscreen smoke 窗口不走该路径。

新 release standalone 已用同一 v4 场景包真实运行：进程 29ms 建立隐藏窗口句柄，523ms 完成 GPU ready，1849ms 首次可见，1891ms 记录 first-present checkpoint；首次可见标题已是正常的 `Deep Monkey Studio | F11 全屏`，且与 present 相差 42ms，没有暴露白色客户区或“正在打开”窗口。最终截图是完整 1200×800 蓝色立方体首帧。证据：`test-output/native-first-frame-hidden-20260924/startup-timing.json`、`native-first-frame-final.png`、`window-final.json`、`artifact.json`。

隐藏首帧随后暴露发布验证专用回归：本地 API 以 `--verify-package ... --frames 1` 生成设备指纹时，隐藏验证窗口收不到首次 redraw，进程等满 60 秒且不产报告。验证模式现保持 compositor-backed 可见小窗并复用 10 秒 fail-fast；对正式 probe 的最终 release 实测 2.010 秒退出码 0，生成 `verification-report-final.json`，设备指纹 `32b36c31…dfa5b4`。对应基础 EXE SHA-256 为 `08f2e519b1d69a40f82da5ca638cfcd2c8f196e553621d5ae0fa3f840942b5a2`。

真实发布链继续揭示了 standalone 终态截图看不到的 DWM 过渡：旧发布 EXE 从隐藏状态显示时，首个 compositor 帧会把已渲染窗口与背后的白色/黑色桌面淡入混合，正好复现用户所见“中间白、下面黑”。正式 Windows 播放器现在禁用首次显示淡入，并在屏幕外完成一次 DWM 合成后才移动到目标位置；它不改变 scene、画质、surface 尺寸或正常后续帧。默认和品牌自定义两种真实追加包均以 10ms 窗口轮询录制，且只把与虚拟屏幕相交的窗口计为用户可见：首个屏幕可见帧已经包含完整立方体和深色背景，0 个白/黑分裂帧、0 个纯背景帧。最终基础 EXE 为 `packages/deep-engine-native/target/release/deep-engine-native.exe`，20,681,216 bytes，SHA-256 `acbb870dd676d4248802621aff522fc17e3978185e146e547d0833fc8f37c1d5`。证据在 `test-output/native-publication-first-frame-dwm-stage-final-20260924/transition-custom-onscreen/` 与 `transition-default-onscreen/`。

## 验证

- 真实浏览器全周期：passed；最终报告 SHA-256 `e008935b6ab4a3db58d20659edcba3f6d58ea2407b0e7ba2abbc7e9657487509`；0 HTTP 5xx、0 非预期 console errors、0 黑帧，故障注入稳定回 WebGL。
- 聚焦 Web：4 files / 48 tests passed（单呈现器/跳过隐藏 Three 遍历、方向魔方、WebGPU camera-only/trailing sync/队列背压、WASM 刷新/相机去重）；最终 Web TypeScript 类型检查通过。
- Deep runtime purity policy 16 tests passed；完整 gate 通过（747 browser/core sources、661 native sources、371 resolved Windows packages），没有添加依赖或文件 allowlist。
- 先前 Deep WebGPU 帧图/环境聚焦：95 tests passed。
- wasm32 全引擎 `cargo check --locked --target wasm32-unknown-unknown` 通过；仅保留仓内既有 warning。
- Native 首帧看门狗的纯决策测试覆盖当前/过期 renderer、首次重试与二次失败；聚焦测试 1 passed / 367 filtered，相关 Rust 文件通过独立 `rustfmt --check` 与 `git diff --check`。
- `cargo build --release --locked --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native` 通过；最终 base SHA-256 `acbb870d…c1d5`。真实默认/品牌发布包完成 10ms 首屏录帧，首个屏幕可见帧即为完整场景。

## 视觉验收

本轮没有新增 UI 组件，沿用唯一设计令牌。真实截图覆盖 1280 主视口、480 恢复弹窗和切换失败状态；切换期间作者画布保持可用，移动端弹窗未裁剪。按 Kimi-95 十维检查：层级 9.2、对齐 9.2、密度 9.0、字体 9.0、色彩 9.1、状态 9.3、响应式 9.2、交互反馈 9.1、3D 氛围 9.0、一致性 9.0；平均 9.11/10。
