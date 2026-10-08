# Studio 引擎 / cluster-LOD 接续（2026-10-07）

## 现状核查

1. 已检索 packages/apps 全源与 git status（含未跟踪）：Web cluster 槽是 position-only、恒白、不写深度的叠加管线；Native renderer/bench 多文件有其他会话在写，保护。
2. 已读 contracts/displayContract 与 renderPacketTypes：RenderInstance.lod 已有材质、实例、shadow 共用生产 draw 合同；ClusterLodSceneStaging 只有 DAG 与 xyz/index，没有 normal/UV/tangent 或 section owner。
3. 已读 deep-engine/package.json 与 web 依赖：既有 bake/selection/indirect/LOD/meshlet 功能完整，零新增依赖。
4. 消费方：作者候选 buildClusterLodAuthorStaging 合并全部几何丢材质；主 opaque pass 在普通 draw 后绘制白色槽。PacketDraw 已经支持多材质/贴图/LOD/meshlet。WASM 保留 handle，往返仍重新 compile/update；WebGPU 返回 WebGL 即释放资源，热切再建。
5. 已读槽位、桥候选、staging 单测与历史切换证据；已有 HDR 限额修复证据，仅涵盖成功/失败，不含平滑/效果。Native 真机生产测试文件当前 1146 行，visibilityEnabled=0、visibilitySlot=1。
6. 已读 13:36 交接、总续作规格、active ledger 关键词、cluster 规格与 parity 文档。加载 engineering-taste；不在未核对 Native owner 前改 Cargo/GPU 文件。

**已有（不重建）**：DAG bake、GPU 选层、间接指令、packet 材质 draw、LOD、meshlet、候选切换取消事务、编译 packet 缓存、已解码作者环境。

**真实缺口**：白色 diagnostic slot 误接作者路径；完整 cluster section vertex attributes 与实例/材质绘制 owner；热切重复环境转换和 WASM 相同包重建；同场景三引擎效果/首帧/输入 P95 证据。

## 实现边界

保留 diagnostic/harness 槽作为隔离验收能力。作者生产绘制保留材质、UV、法线、实例和阴影。切换复用有界 CPU 产物；另按用户后续授权，保留一套健康独立包 Deep 候选，最大 256 MiB、闲置 30 秒，实际作者变化、环境变化、设备丢失和桥释放时销毁。恢复前必须验证作者包及真实 GPU 首帧。

边界：取消/失败/版本变化/纹理 disposed/不同 budget/空场景/相同内容不同数组/连续切换/源变更期间转换/缓存生命周期。GPU 与性能采集等待其他 Native 测量完成，避免资源争用。

## 已实现

- 移除作者候选的合并白色 diagnostic 绘制，生产 cluster 以原 PBR 管线、材质和实例 ABI 替换普通 opaque draw，避免双绘制。阴影继续消费原始几何；变形、作者 LOD、MASK/BLEND、非均匀变换等回退原绘制。
- 逐 section 保留 source vertex 属性。常量法线、无贴图/顶点色表面支持保守粗层；UV、切线、颜色及丰富法线表面保留精确单层，避免跨 seam 简化。GPU owner 限 64 实例/32 MiB；热身及相机新选层读回未完成时保留原绘制，避免远景粗层在相机移近时继续显示。
- 作者 packet 上传单飞，修改贴图变换后刷新生产包；上传期间禁止相机 residency 事务竞争 owner。修复此前 UI 改为 U/V2 而 Deep 图像仍 8×8，以及编辑后自动失败返回 WebGL。
- 明确关闭未启用的体积雾，使用作者曝光；灰白背景已与 WebGL 同相机背景匹配。作者 flipY 由贴图任务修复。
- 渲染器切换先完成目标准备，再退休原引擎；失败保留实际当前引擎。CPU 环境和 WASM 包缓存保留一份；相同 WASM 字节不重建。
- 静态作者 packet key 排除抓取时间 updatedAt、相机和编辑器选中。逐编译消费方确认这些不进几何材质包，相机由最新 RenderView 独立供给。此前每次 capture 时间变化都会使缓存失效，导致不停编译/上传。停放候选对纯 requestRender 使用语义作者 key 验证，UI 引擎状态更新不再误销毁设备。
- 停放前有界等待作者同步、排空诊断读回并释放 timestamp query 池；预算要求资源字节全部可知。恢复候选复用既有 device/pipeline/packet，强制真实 GPU 编码、排空队列与错误作用域验证，之后发布。

## 真实 GPU / 浏览器证据

证据目录：`test-output/studio-engine-lod-switch-20261007/`。全部通过 CUA 在隔离 QA 场景验收；未修改原场景。

| 验收 | 结果 | 文件 |
| --- | --- | --- |
| 生产 PBR cluster 双 section、红/蓝真实材质，HDR direct 和 MRT/TAA 两模式 | 非空彩色像素 11944/11966；近景 changedPixels=0、最大通道差=0；热身原绘制，稳定后间接绘制替换，零 GPU 错误 | `cluster-pbr-gpu-result.json`、`cluster-pbr-probe.png` |
| 同场景远景 cluster | 1600→256 三角面，减少 84%；MRT 另有 1 个后处理三角面 | 同上 |
| 同相机棋盘覆盖 U/V2 | Deep 与 WebGL 都 16×16，同相位；背景三点最大通道差 1/0/1 | `deep-uv2-final.png`、`webgl-uv2-final.png`、`same-camera-color-samples.json` |
| 热返回 Deep 两轮 | switch-start→published=56.0/51.7 ms；复用后真实 GPU validate 约 5 ms，无新 device/pipeline/packet 上传；候选 197508503 bytes、unknownResources=0；控制台 warn/error 为空 | `switch-phase-warm-final.json`、`deep-uv2-warm-final.png` |
| 冷切 | 人工启用 2729.1 ms；刷新后自动恢复最终事务 4019.1 ms（包含多次加载期间取消）；旧证据 3673.7 ms，主 PBR 管线 1672 ms | `switch-phase-cold.json`、`switch-phase-warm-final.json` |

热返回测量是在同一作者包、同环境和未过期候选下取得，适配器 nvidia/lovelace。日志包含实际 encode、queue-drained、error-scope-cleared 和 published 阶段；并非把保留画布时间当成引擎已就绪。

## 验证与限制

最新 focused：Web 8 文件 63 测试（另补作者快照不可读退休断言）；Deep cluster/packet 8 文件 76 测试，最后相机 stale 回退补测 3 文件 19 测试；GPU timer/backend 3 文件 64 测试；单一能力合同 22 测试，全部通过。Web typecheck 和 Deep build 通过，lab typecheck 已通过。全仓测试由主会话统一执行。

当前仍有缺口：冷启动管线编译仍需数秒；贴图物体三个采样点最大通道差 5/20/14，直接光 BRDF/环境响应尚未证明逐像素一致；丰富顶点属性只有精确 cluster 层，尚未做保 seam 的粗层收益；Native cluster 不在本轮接线范围。WASM 缓存的正确性有单测，尚无与另两引擎同相机真实画质/切换时间验收。因此三引擎一致性和所有切换“不能卡”仍未达最终门槛。

Native MegaLights 后续真实硬件证据由 `studio-texture-delivery-20261007.md` 管理；本任务最初只读核对的 visibility 配置已由该任务替换，不再作为当前 Native 现状结论。

## 用户精确场景与辅助图形现状核查

用户反馈路由 `38ea81ba-3033-4d3e-86b5-648fd58d98f1/applications/78e21669-1225-4801-9c3e-d1fbef28ec94/scenes/78e21669-1225-4801-9c3e-d1fbef28ec94`。

1. 全源/未跟踪核查：静态包仍提前调用 deformation 工厂；默认 click 空 code 脚本使持续需求恒真；桥在无变化短路前 cancel 收敛。灯光代理已有作者 Mesh/LineDashedMaterial，但 Deep native 原语另造黄色实线。
2. 已读 OverlayClipPoint、AuthorGridView/DecodedTexture 合同：作者 overlay 已支持虚线距离、颜色、透明度与手柄完整网格，无须新增 schema。网格采样器因 nearest magnification 被降为 anisotropy=1。
3. Three r186.1 与既有 WebGPU 依赖已在用，无新增依赖。
4. 已核对 viewerEngineRuntime、StudioDeepWebGpuBridge、getDeepEditorOverlayRoots/Inputs、projectStudioEditorOverlay、AuthorGridResources 消费。Shader TAA 确实执行，保留16帧收敛。
5. 已读 interactionRenderActivity/bridge、grid lifecycle、overlay roots/dashed tests 与精确场景截图/阶段证据。
6. 已按本接续文档与质量续作总规格核对；Native/Rust/WGSL 正在最终构建，辅助图形修复只改 Web 作者与适配层。

已有（不重建）：有限收敛、静态需求、作者虚线投影、同源 Canvas 网格。真实缺口：空事件误判动态、无变化通知取消收敛、静态误编译49变形管线、灯光代理丢作者语义、Deep 缺网格斜视各向异性采样。

## 冷载入缩略图现状核查

1. 全仓源与未跟踪文件已查：`captureSceneThumbnail` 在保存、离开工作台与用户预制件消费；真实冷启动 profile 自动保存调用占主线程 422 ms。
2. 已读 ViewerEngine 合同，已有 `getRendererBackend` 与 `subscribePresentationFrames`；无需新增渲染器合同。SceneSnapshot.thumbnail 已是有界 JPEG data URL。
3. Canvas/createImageBitmap/toBlob 为现有浏览器能力，无新增依赖。
4. 已读 scenePersistenceController 保存代际守卫、carry 离页保存与 userPrefabActions；异步保存必须在恢复副本写入之前检查 scene apply generation。
5. 已读 sceneWorkspaceSave/applicationRuntimeController 测试与原场景两轮 CPU profile：首次 Canvas 网格 read 499 ms 已消除，当前最大任务是隐藏 Three renderer 的缩略图重绘。
6. 已读 assistant-verify-loop 旧同步抓取规格、当前接续与 handoff：旧抓取未覆盖真实 Deep presentation canvas，须补生产消费者。

已有（不重建）：呈现帧订阅、保存代际取消、480px/160KB 缩略图预算。真实缺口：自动保存强制重绘隐藏 Three 并同步 JPEG/读回，读到的也不是当前 Deep 画面。

## 作者 Three 首次着色器现状核查

全仓源/未跟踪、Viewer RendererInstance 合同、Three r186.1 依赖、scheduleRendererPipelineWarmup 全部消费、rendererPipelineWarmup 生命周期测试与上述规格已核对。已有签名去重与取消调度，不重建。真实缺口：WebGL 分支因旧 r185 竞态注释仍强制同步 compile，空闲调度晚于首次 RAF；r186.1 compileAsync 已有 disposed currentProgram===undefined 守卫。原场景最新 profile 仍有 Three onFirstUse 85/59/58ms，全部在 Deep backend 创建前。改为异步编译与保留上一帧直到就绪，不能先 render 强制驱动阻塞。

## 真实变形场景冷初始化现状核查

1. 全仓检索及未跟踪文件：`pbrPipelineSet`、`firstFramePipelineMainKeys`、`setPacketValidated` 均已有；不增加第二套管线缓存。
2. 契约：`PbrPipelineBootstrapOptions.firstFrameMainKeys/deferDeformation` 与 `PipelinesBuild.criticalReady/ready/releaseDeferredQueues` 已有，变形使用相同材质键和独立顶点布局。
3. 依赖：WebGPU/Three r186、既有异步管线缓存足够。
4. 消费：Backend 已从真实 packet/projection 推导首帧材质键；deferred deformation 却未传该键，并在 `setPacketValidated` 提前放行全部静态背景编译。
5. 证据：复杂场景 `776cf382` 成功加载 5 模型、12 变形对象；`complex-deep-final-trace.json` 显示 deformation main27 全量等待约 10.4 秒，静态 deferred27 同时竞争。
6. 规格：本任务、continuation 与 handoff 仍要求冷初始化保持输入响应。真实缺口是变形没有消费已存在的首帧子集合同。

方案：带首帧键的延迟变形在实际 packet 需要时立即开始，只等待关键子集；独立校验作用域关闭后，未用变体仍保留首帧验证后的 release 门。旧无子集 SDK 等待语义不变。

## 2026-10-07 17:05 冷启动复测

`78e21669` 用户精确场景，隔离页 `?renderer=webgpu`，实际可见画布 `deep-webgpu`，作者画布隐藏。最新统一 dist、无 Cargo/FFmpeg 重负载，CDP CPU 1ms 采样及 Long Tasks 同时采集：

- 编辑器可交互 1740.7ms，Deep 首帧已验证发布 4917ms；菜单真实点击展开。
- 长任务 97 / 69 / 67 / 107 / 50ms。107ms 区间的 76.8ms 属 React 开发版同步 render/commit，Three 首次 uniforms 约18ms；67ms 为首次作者纹理上传31.7ms及 uniforms17ms。旧 499ms Canvas读回、447ms 缩略图 GPU flush、226ms constructor 同步绘制、234ms Composer 首帧链接已消失。
- profile 与 NavigationStart 精确对齐，按每个 long-task 区间过滤 samples/timeDeltas；聚合函数总时长不当作单块卡顿。
- 证据：`user78e-cold-cpu-profile-composer-wired.json`、`user78e-cold-metrics-composer-wired.json`、`user78e-cold-trace-composer-wired.json`、`user78e-deep-cold-final.png`。

Three r186 原生 `compileAsync` 与既有 WarmupScheduler 共用；constructor 初始绘制安排至 RAF，微任务先开始编译。异步创建 Composer 后同样进入 warmup；缓存主场景签名及每个 Composer 实例签名，避免晚创建的 Composer 被主场景缓存误判为完成。链接结束后逐 program 初始化 uniforms，保留真实渲染首帧验证。

## WASM 几何与复杂模型

最新 Hi-Z 生产 WASM 在同 `78e21669` 画布已显示底座、圆柱、球三体，截图 `user78e-wasm-hiz-final.png` SHA256 `87c576d84d3c5ee70fe1c1f6326b9b05db7eb7c82633a3caa63fa542c910309b`。旧包只显示底座，原因为 Hi-Z 假遮挡，Native 负责修复与硬件验证。

复杂原场景 `776cf382` 最新 GLB 全部可读、5 模型成功 Deep 发布，`complex-deep-final.png` 及 trace 保存。26.47s 总准备含并行 CPU 构建/视频负载，仅作功能证据。真实12变形对象触发全27 main变体并阻塞约10.4s，现已按已有首帧键合同修复，77 focused tests 与 Deep typecheck 通过，硬件复测待新 dist。发布前旧作者画布继续呈现且菜单可点击。

WASM 小场景 runtime package canonical/SHA 504/328ms 仍是独立冷阻塞，父任务承接异步执行调查。不同引擎的彩色材质和远网格仍有差异；本次证据不等同全部像素一致或任意复杂场景均达默认引擎性能要求。

截图 SHA256：`user78e-deep-cold-final.png` = `2ef9be7d7b741fbb3ce5f548dd3fd8087ecbc983d9cab53f6a43dfab3f24e584`；`complex-deep-final.png` = `f6873ceb84665f72de6cb385932a119bb9b04fdb162e490f447a07cb9d90fbda`。

空历史 v2 草稿路由虽然 Deep 可呈现，但页面显示“未命名场景”及默认灯光；该截图仅证明通用空工作区呈现，不代替原 `v2回归草稿场景` 的恢复验收。`empty-deep-direct-final.png` SHA256 `a6d43046fdf0648e1f810e14b6c4138166a9116638c5801ceefc9235915f912a`；正式 noComposer 显示域验收由对应任务继续。

变形修复最终 CPU 检查：pipeline/build/backend77测、packet/epoch/firstFrameSubset44测、Bridge/Warmup/displaydomain41测全部通过。Deep/Web typecheck 与 Deep build 均通过；原 SDK 没有首帧子集键仍保留 release 后等待全量变体，生产作者包按实际键先验证真实首帧。

## WASM 作者编译主线程现状核查

已检索 apps/packages 与未跟踪项，RuntimePackage/SceneSnapshot/探针烘焙合同已有，Vite Worker 与 OffscreenCanvas 图像解码依赖已在使用；studioWasmRuntimePackage 是 bridge 的正式编译消费，底层仍使用唯一 compileSceneRuntimePackage→builder→hash→validation，已有编译、Draco/贴图、bridge取消测试。已读 current cold profile 与本规格。已有（不重建）：规范化、纹理/模型运输、严格SHA和运行包验证。真实缺口：编译器在主线程计算 canonical SHA 两段504/328ms。把当前完整编译转至一个可终止 module Worker，沿用原编译代码及全部验证；按实际scene模型传最小manifest，保留作者探针输入和同源运输。取消/完成/失败均释放 Worker，失败保留原画布，不悄悄退回主线程大计算。无 Worker 的测试/旧运行环境保留同步入口。

## GI 表面重复准备现状核查

已查全仓prepareRenderPacket/activateForPacket与未跟踪叶、PreparedPacket/ProbeSurfaceCachePacketInput/目标合同、包依赖、PbrRenderer→Backend→ProbeSession→Controller正式消费、surface/packet/device epoch测试及当前profile规格。已有（不重建）：GPU校验后原子commit拥有的PreparedPacket快照，最新preparedPacketFor只接受成功发布的同raw身份并在替换/实例变更/销毁失效。真实缺口：GI激活再次完整prepare（复杂场景653ms中大部）然后又从raw扫描几何。复用目标的已验证owned快照作为内部GI输入；公共未验证sync保留严格prepare和全失败守卫，world-space transform/dynamic ID/revision仍校验，不依赖WeakMap缓存可变外部对象。

## 复杂 packet CPU 现状核查

全源/未跟踪核查已确认没有 packet CPU worker；已有 ProbePlan MessageChannel yielding 可复用。契约 `PreparedPacket` 私有几何/纹理/变形快照、`prepareRenderPacket` 同步 SDK、公用皮肤 packer 都已存在；不改变材质、权重、像素或顶点数学。现有浏览器 Worker、WebGPU 与 typed arrays 足够，无新增依赖。

生产消费者 `PacketBuffers.setValidated` 在等待变形管线后同步重新 prepare；`stagePacketBuffers` 又调用 deformation.prepare 完整 snapshot+packer；作者 compileSceneRenderPacket 末尾 prepare 只用于校验。complex精确CPU profile显示 prepareRenderPacket 529ms、stage 942ms（deform573、geometry233）。测试已包含 epoch、并发取消/rollback、变形修订和大资源预算；同步 SDK 要继续全部通过。规格仍要求真实复杂场景主线程不卡。

真实缺口：重复验证与整批 CPU/GPU upload 不分片。新增 async 入口复用原 validator/packer 运行于 worker；发送前只读结构检查避免 structuredClone 抹掉非法 prototype/accessor。worker 返回独立 owned snapshot/精确 packed skin 结果，结果 buffer 转移。GPU staging 逐 pose/geometry/batch 让出事件循环，取消/换场景/epoch丢失回滚；同步入口保持原语义。

## 首帧后边界与姿态校验现状核查

全仓检索、RenderView/PreparedPacket/DeformationPoseValidator 合同、Three r186 依赖、bridge→view 与 PacketBuffers→pose update 消费、缓存/变形/回滚测试和上述规范已核对。已有 immutable packet extent 与 source-array WeakMap validator，不重建。真实 complex 冷 profile 每个 task 精栈：发布后443ms中 view 的 Box3 遍历238ms，pose 首次更新重新构建 validator约165ms；packetInstanceUpdate还重扫geometryCenter。原因是桥每个非相机帧无条件清掉已上传 packet extent，Worker换realm后原 validator cache未被承接。仅保留当前已发布 immutable packet 的bounds，作者修订时用新包替换；复用已准备的资源validator并使用缓存geometry center。另137ms task包含decode约60ms和Worker postMessage clone71ms，在post前yield分开，不改上传字节或作者数据所有权。

## 作者 Three 首次资源暖机现状核查

全仓源码与未跟踪项已核查 drawAuthorScene/SkinnedMesh/computeBoundingBox/initTexture、threeShaderWarmup、GLTF 变形消费；RenderPacket/SceneSnapshot、RuntimeGlbImportOptions 与图像/皮肤合同已有。Three 0.186.1 和 GLTFTransform 4.4.2 已使用，不新增依赖。ViewerCore 正式调度 warmThreeShaderPrograms，Composer 准备使用同暖机；现有生命周期/取消/共享程序测试和真实 complex-packet-worker-clean CPU/trace 已读，本任务规格仍要求主线程输入响应。

已有（不重建）：异步 shader/program 暖机、代际调度、严格变形与材质缓存。真实缺口：首次 Three 帧仍将全部 texture upload 和 SkinnedMesh 姿态包围盒计算聚合在单任务，真实 588ms 中纹理约286ms、skin bounds约175ms。沿用原 Three initTexture/computeBoundingBox/computeBoundingSphere，在现有首次显示门之前逐资源让出任务，保持相同贴图/边界数学；不以缩小纹理或改材质降低效果。GLTF 导入214ms由独立资产Worker切片继续，发布后的Deep bounds/pose443ms由引擎任务处理。

## 17:50 复杂原场景 Worker/上传硬件复验

统一 Deep dist；Cargo/LTO/FFmpeg 已停，Docker deploy进程处epoll等待，无压缩；隔离原 `776cf382` 页面首次请求 Deep，不改作者内容/相机。CDP从导航前1ms CPU采样，进入新文档后安装 buffered Long Tasks，NavigationStart与samples严格对齐。

- 实际 Deep 首帧通过并于12388.1ms发布，作者画布opacity0、Deep画布opacity1；12姿态绑定、0未配对。菜单在初始化阶段真实展开/收起。
- Critical deformation ready11588.3ms→packet uploaded11792.9ms：约204.6ms分片，区间没有≥50ms任务，旧同步stage970ms已移除。
- scene uploaded12298.9ms→published12388.1ms：89.2ms，原728ms发布等待/653msGI重复prepare已移除。图片decode949ms/halve295ms不再在主线程栈。
- 剩588ms为Three首次Composer render（texSubImage2D286ms、SkinnedMesh骨骼边界约175ms）；214ms为NodeIO/readBinary+GLTF decode及Three mesh签名；另137ms包含Worker clone71ms与decode连续执行。对应父任务/贴图任务继续修。
- 发布后443ms为bridge无条件清空packet extent后重算Three蒙皮边界238ms，及Worker跨realm后首次姿态校验缓存未承接；本任务已补private owned validator handoff、缓存geometry center及immutable packetextent保留，待下一轮统一dist硬件验证。

证据：`complex-packet-worker-clean-profile.json`、`complex-packet-worker-clean-metrics.json`、`complex-packet-worker-clean-trace.json`、`complex-packet-worker-clean-final.png`。先前并行构建/HMR的`complex-packet-worker-functional-cpu.json`只作功能证据。

当前CPU检查：Worker/packet/skin/deformation/cancel/cleanup 130 PASS、1 shader工具条件skip；View/bridge 37 PASS；作者compiler49 PASS；Deep/Web typecheck和前轮Deep build均EXIT0。Node/API实际生产compile已越过类型门。公共同步GpuSkinner仍全验证，私有prepacked第三参必须具有本candidate source/palette身份的内部WeakMap凭据，外部未注册packed结果拒绝。


GLTF Worker模块依赖核查：已读normalize函数、3正式消费与Draco/Worker编译测试，parseGlb/固定WebIO+Draco依赖和合同已有；真实缺口是Worker导入整套WASM compiler造成首次743ms模块图启动。只机械移原函数到单一叶模块，并保留旧入口re-export，不复制算法。

## 设置面板采集成本现状核查

已检索 apps/packages/contracts 的 frameCapture/SourceMap/readback 与未跟踪项，读取 PbrFrameCaptureOptions、FrameCaptureSession beginFrame(false) 合同、现有 React/Three/Deep 依赖、useRendererDiagnostics→candidate→renderer 正式消费、Studio capture 与 GPU capture 测试及 handoff/ledger。本面板打开会开启连续捕获、全分辨率颜色与深度读回；关闭时 beginFrame(false) 已有，不重建采集协议。真实 QA 从设置面板切换 Deep 成功约11.335秒，但面板内 Deep P95 145.8ms/GPU4.3ms，JS约1GB；用户同时报告通用30秒切换超时，不能将此一次成功视为解决。

真实缺口：Studio 诊断无总帧数停止门，candidate验证时也读取图像；底层部分资源分配/输出路径只看 capture 实例是否存在，忽略本帧是否启用。Studio保留有界历史和真实SourceMap，仅在候选正式发布后抓取两帧；再次打开面板开启新的两帧窗口。FPS/GPU/内存指标继续实时采样。底层只在本帧captureOpen时采用采集资源/输出路径，停采后恢复原分配计划，由引擎任务补实际回归证据。

## 最终完整回归现状核查

已检索全源和未跟踪项、PacketBuffers/PreparedPacket/DeviceSession 合同、既有 WebGPU 与 Worker 依赖、setValidated 与 gpuValidatedStage 消费、packetBuffersValidation/packetVertexStreaming 及完整 860 文件回归、本规格和交接文档。已有（不重建）：小包同步分配并立即建立 GPU 校验取消事务；大包 Worker 准备和逐资源异步分片。真实缺口：新候选入口无条件异步，使小包在微任务前取消未释放 vertex-stream 租约，且改变旧三作用域 SDK 时序，完整回归出现 12 项失败。恢复小包既有同步 gpuValidatedStage 分配路径，大包保持原分片；不放宽 GPU 错误、取消或所有权断言。另 runtime purity 扫描发现新增两个叶文件直接引用 DOMException，改为 Error 的 AbortError 名，保留 signal.reason。

## 18:20 净冷启动归因

`complex-final-clean-{profile,metrics,trace}.json` 使用同一 NavigationStart 对齐，每个采样区间与实际 longtask 区间相交后分别统计 self/inclusive。18 个 longtask，最大 108 ms。104 ms 位于 editor-interactive 前，React 开发版 performWorkOnRoot 占 102.3 ms（commit 62.6 ms）；108 ms 位于 Deep 发布后，React 同函数占 106.2 ms（render 89.3 ms）。二者不是纹理上传、packet 验证或首帧 GPU 编译阻塞；仍须生产包同场景复测，不将开发版归因当作生产验收。

Deep 发布 11273.6 ms，编辑器可交互 1614.5 ms；12 变形姿态、0 未配对。关键变形管线就绪 10490.0 ms→packet 上传完成 10703.4 ms，分片 213.4 ms；scene-uploaded→published 85.4 ms。完整逐 task 结果在 `complex-final-clean-long-task-analysis.json`。

小包生命周期修复后 focused 4 文件 30 项通过，包含原即时 dispose、sync supersede、GPU error scope 拒绝和 vertex-stream 原资源租约。最终完整回归继续执行。

runtime purity 同族检查：authorChunkStream/validatePbrFrame 的裸 performance 是 HEAD 既有实现，当前 mark 只是宿主性能时间线能力，Node 同样可用。已读 purity AST 规则和正式消费；用显式最小宿主 performance.mark 类型取代 DOM 全局声明依赖，保留调用接收者和 typeof 守卫，不改 validation error window 或 GPU 提交逻辑。

最终完整 CPU 回归：860 测试文件全部通过，6726 PASS / 55 条件 skip；随后 29 Node script 测试通过。runtime purity 覆盖 1135 core、841 Native 源文件和 382 Windows 依赖，通过；source-size 覆盖 3459 文件，0 failures。J5 默认 CPU/静态合同检查 EXIT 0，GPU legs 未在该命令执行。Deep core/lab/examples typecheck 与 dist build 均 EXIT 0。

dist 冻结标识（本轮 CPU 回归后）：packetBuffers.js `65594ead5f01a6c32e7bea8a385e49c3f448fbcecd791c128bf238e7f00af044`；validatePbrFrame.js `4292c499e93db3d33eae67416c2b5dceeecad8b6a581673b552d366d9bcf2980`。日志 `final-deep-regression-after-fix.log`、`final-deep-typecheck.log`、`final-deep-build.log`。

用户后续截图显示手动从 WebGL2 切 Deep 等待 30 秒失败。此前 URL 直接请求 Deep 的冷初始化证据不覆盖该问题，发布前须用正式渲染器菜单复现并按 marks 定位；当前未验收该手动切换缺陷。

## 关闭诊断后帧捕获开销现状核查

全源码/未跟踪项、PbrFrameCapture.begin 与 FrameCaptureSession/RenderTargets 合同、既有 WebGPU/瞬态池依赖、renderPreparedFrame→targets.beginFrame/output.present 消费、capture/readback/output/targets 测试及手动切换 profile/本规格已核对。已有（不重建）：begin(false) 拒绝当前捕获，readback/collect/record 已按 captureOpen 跳过；正常渲染资源按图分配复用。真实缺口：allocation 仍按捕获对象是否存在禁用 alias，present 仍按对象存在请求 source provenance；诊断关闭后这两条旁路继续运行。仅改为当前帧 captureOpen 决定两条路径，保持启用捕获时独立纹理和真实 provenance。

## 首帧变形并行与停放显存现状核查

已检索 packages/apps 源码、未跟踪项与 contracts，读取 PbrPipelineBootstrapOptions、RenderPacket instance.pose、TransientTexturePool/RenderTargets 合同，核对已有 WebGPU 依赖、Backend.create→pipelineSet→packet 与 prepareParking 消费、首帧键/管线/纹理池测试、本规格和交接记录。已有（不重建）：关键 main 子集、非延迟变形编译、首帧后背景放行、瞬态池 free/live 所有权及 256MiB 停放门。真实缺口：作者包用同一组键驱动 static/deformed，变形编译在 static bootstrap 后串行等待；已知全变形包仍编译未使用 static 材质关键集。将已知包按 pose 分组，并在一个原 bootstrap 校验作用域内并行创建两组必要管线；其余变体仍由首帧后放行。停放仅回收已提交且空闲的瞬态纹理，保留在途租约、跨帧历史和原预算，不通过扩大预算缓存 287MB。

默认正式消费路径已落地：Studio authorRenderPacket→DeepWebGpuBackend.create→packetFirstFrameRendererOptions。已知包含 pose 且 deformation:true 时，原 deferDeformation:true 自动改为 false，并分别提供 static/deformed 首帧键；两个 shader module 同时开始，bootstrap criticalReady 等待两组必要子集。firstFrameSubset:false 保留全量原时序；未知投影继续原延迟策略。PbrRenderer.releaseIdleResources 返回实际释放字节，仅清理 transientPool.free。宿主等待作者同步及 timer readback drain、检查 backend identity 后回收，再判断原预算。真实 287MB 能否降至预算内待生产读数。

本轮检查：capture gate/output/targets 4 文件 35 PASS；首帧并行/分组/停放/选项/默认后端等 focused 7 文件 45 PASS；新增实际 Backend.create 带 pose、defer:true 消费再跑 2 文件 6 PASS。完整 Deep 回归 862 文件 6731 PASS / 55 条件 skip，29 Node script PASS，test 命令 EXIT 0；runtime purity 1135 core / 841 Native / 382 Windows 依赖，source-size 3461 文件、0 failures。最后 core/lab/examples typecheck 与统一 dist build EXIT 0。

停放回收不需要新增 queue fence：pool.free 只含 queue.submit 后 commitFrame 已回池的目标，active/pending 租约不回收；WebGPU destroy 允许驱动在此前提交完成后实际释放。保留 80ms 停放上限；物理显存测量可另在 queue 完成后采样。[WebGPU 纹理销毁合同](https://www.w3.org/TR/webgpu/#dom-gputexture-destroy)。

最终本轮 dist：pbrPipelineSet.js `dae1f7c90530cd398a3a0fe9e93d17dc4df57a95629900aa5e8f8860c3ad6c1c`，pbrRendererFrames.js `8030cde62f914284f1ce08d1e183e0a59efb5ab7e28f3c112873f8d384560da6`，firstFramePipelineKeys.js `2a9f87219092590488866f49b8a1138aa2f9c4eb1c4b8cebad46d7ecba51a484`。日志 `final-deep-regression-bootstrap-trim.log`、`final-bootstrap-consumer-focused.log`、`final-bootstrap-trim-typecheck.log`、`final-deep-build-freeze.log`。

关闭设置面板的 55.644s CPU profile 统计：95.5% idle；animate inclusive 437.1ms，Deep bridge 406.6ms，React 316.5ms。这是静止场景样本，不用于推算交互 FPS。默认 DeviceSession 未请求 shader-f16，PBR static/deformed 没有 f16 路径；RT f16 缺省关闭、显式请求缺能力时拒绝。6 文件 63 项合同回归通过，实际驱动时延仍由正式浏览器验收。

GPU 待验收：原 complex、QA 673K、用户 78e 的正式渲染器菜单 WebGL2→Deep 切换；稳定相机与真实输入 P95；当前 source 重新打包的 RT 1920×1080 每 leg 30 samples。旧 RT result 缺当前 Renderer/Frames 身份，最终分析器校验失败，不能沿用为本轮完成证据。

## 连续输入 GPU 提交上限现状核查

已检索 apps/packages 源与未跟踪项、读 RenderView/RuntimeSession/GPUQueue 及 bridge options 合同、现有 Three/WebGPU/TemporalFrameSettler 依赖，核对作者呈现→camera/sync→renderCommittedFrame→queue.submit 消费、bridge悬挂 queue/settle/lifecycle 测试、规格和交接。已有（不重建）：最新视角单槽、有限 TAA settle、队列完成 fence、后端 identity 与取消。真实缺口：camera 提交后立刻释放计数，limit 满时继续强制 submit；普通首绘绕过 settle fence，故 camera/动画/settle 没有共享 GPU 上限。先恢复最多原 2 个真实 GPU completion ticket、单槽替换过期输入、完成后补最新一帧；旧后端回调/取消/失败不能重放。保留质量与原预算，由真实拖动 P95 决定性能，不用扩大计数制造指标。

GI 接口联动核查：已读新 PbrFrameUniformView.globalIlluminationIntensity 合同（SDK 缺省1）、同包与正式 Studio 消费、原 shader/binding7 依赖、Backend.prepareView 缓存与创建测试及 GI 规格。已有首帧视图内容比较；缺口为新增 GI 增益未入 sameRenderView，补按缺省1归一后的比较，改变 GI 强度时重新校验。

19:23 共享提交上限相关 15 文件 179 项通过，Web 类型检查 EXIT 0；真实停车 trim 后占用 228558513 bytes，已在原 256MiB 门内。GI 增益后的全量 CPU 回归 852/862 文件通过、28 项失败：8 个 C8 观测文件仍 pin 旧 shade 哈希，2 个核心断言仍要求旧无增益表达式；当前不能沿用前轮完整 PASS。该回归已结束，后续完整回归限制 maxWorkers 2。

## GI 观测兼容与后台编译现状核查

已检索源码/未跟踪文件、读取 PbrFrameUniformView 与 PipelinesBuild/PipelineWarmupQueue 合同、核对既有 Vitest/WebGPU 依赖、GI shader→C8 isolated observer 与 renderer.release→deferred queues 正式消费、28 项失败和 pipelines/subset/warmup 测试、本规格及交接。已有（不重建）：64B binding7 预留通道传递 GI 增益、原 shade 全体源码 pin 和关键子集编译、并发2预热队列。真实缺口：观测 pin 未随已审计 GI 唯一表达式变更更新；GI 断言未检验 probe-only 增益。后台 main 虽有限流，但 release 后 mask/authored shadow 和 virtual page 直接并发创建，绕过该队列。更新精确 pin 与增益断言，不放宽源码漂移门；后台各类统一经过队列，保留 ready 和错误传播。

## 真实场景玻璃透射现状核查

已检索 packages/apps 源及未跟踪材质修复、读取 ExtendedMaterialParameters/PreparedMaterialTextures、Pipelines/RenderView 与 frame ABI 合同、核对现有 WebGPU/Three 依赖、author packet→material uniform→advanced shader 和 opaqueEffects→weighted OIT 正式消费、advanced/binding/draw/transparency/颜色域测试、引擎和作者视觉规格及交接。已有（不重建）：传输比例、IOR、volume thickness、Beer 衰减、GGX 反射、OIT 前 opaqueEffects.color、已有 sampler 和 64B/384B ABI。真实缺口：advanced transmission 只采环境 cube，IBL=0 时无法透出实体。advanced 变体追加 frame binding15 指向当前 opaque source，透明阶段投影折射并用有界四点过滤处理 roughness；复用已有源与透明 pass，不增加全场景渲染、不降低 alpha。OPAQUE 透射内部路由透明 pass，作者 alphaMode/alpha/IOR 不变；非 advanced 路径保持原合同。Composer 使用线性 HDR 样本，authorDirectDisplay 使用已显示编码样本的显示域贡献，避免第二次 ACES/曝光；两条颜色域差异须以实际 GPU/Three 同相机验收。

## 连续拖动卡死与画面偏移现状核查

已检索 apps/packages/contracts 源码与未跟踪文件，读取 RenderView target/viewport 合同、Three OrbitControls 及 WebGPU queue 依赖，核对 renderDeepFrame→renderLatestCameraFrame→renderViewDirect 的消费、手势缓存和桥生命周期测试、本规格与用户卡死反馈。已有（不重建）：实时 eye/up/FOV、场景字段缓存、最新相机单槽、GPU completion API、错误回退。真实缺口：缓存把 pan 的 target 和视口尺寸固化，实时 eye 配旧 target 导致 Deep 视图漂移；所谓在飞计数提交即释放且达到限制仍提交，不能限制慢 GPU 队列。分别只缓存场景派生字段、实时更新 target/尺寸/DPR，并恢复真实 GPU 完成背压和有界最新视角合并。完整回归前暂停发布。停放 trim 已接正式宿主，36 项 Studio focused 回归通过；最终 GPU 仍待复测。

## 生产 GI 无效重规划现状核查（19:50）

1. 已检索 packages/apps 源码及未跟踪 probe 文件。现有 clipmap controller/runtime/scheduler 和协作让步不重建。
2. 已读 contracts DisplayGiMode、ProbeClipmapPbrControllerOptions、ProbeSceneRadianceProducer、DeepWebGpuProbeClipmapDiagnostics 和捕获类型。已有 producer.sceneUnavailableReason，但 controller 尚无计划前可用性检查。
3. 已核对 Deep package 的 WebGPU/Vitest 依赖；本修复无需新增依赖。
4. 正式消费是 PbrRenderer 工厂 → Backend probe session → controller.beginFrame → runtime.scheduler → producer.encodeSourceRadiance。工厂 soft sync 记录变形拒绝原因，直到计划全部展开后才编码失败。session.captureTick 会停止，beginFrame 和 queuedView 路径仍逐帧重试。
5. 已读 factory/producer/session/captureTick/runtime/scheduler 测试和最新真实生产 CPU profile：28.535 s 内 planner fr inclusive 2.923 s、scheduler finish inclusive 3.067 s；两个压缩 chunk 名不是运行函数名。拖动复测也持续出现相同热点。最新完整 Deep 回归 864 文件、6742 PASS、55 skip，maxWorkers 2。
6. 已校准本规格、交接和任务恢复记录，用户卡死仍是发布阻断。真实缺口：不可捕获的场景仍执行无效果的全 clipmap/dynamic bounds 规划。先给真实 producer 加即时可用性查询并在 controller/session 计划前守卫；可用场景/灯光恢复后照常捕获，不降低作者灯光、采样质量或修改材质。

19:55 GI admission 5 文件42 PASS/2 skip，相关 scheduler/surface/backend8文件57 PASS，投影首次透明关键键3文件71 PASS。Deep typecheck（core/lab/examples）与build EXIT0；source-size3470文件、258 warnings、0 failures。不可捕获检查先于surface.beginFrame/runtime.beginFrame，100次控制器调用无规划/GPU submit；1000次视角输入无捕获，恢复可用照明后重新捕获；正在捕获期间失去源取消旧信号并丢 queued view。新 dist 可供生产复测，尚未拿新 profile 声称 CPU 数值改善。5198 fixture已校准 IOR 与 RenderView 正式 roughness>0 合同；真实 GPU对拍仍待重试。

19:59 真实透射 GPU 对拍通过：`test-output/scene-transmission-20261007/result.json` 的8份source身份与当前文件逐一匹配。160×96、MSAA4、OPAQUE/alpha1、IOR1.45、IBL0，Composer 与 direct-display 两个颜色域均保留玻璃后的红/绿实体背景，通道差不超过5/255；透射0遮挡背景；粗糙度0.65的边界对比从316→126和311→156。真实weighted-OIT启用，GPU diagnostics为空，捕获颜色有限。规格中的算法/绑定与正式生产SMT可透视内部的截图一致；此证据不包含整场景Three画面一致性或拖动残影，后两项仍由生产复测检查。材质specular新增后须重跑同GPU对拍。

## SDK warmup drain 现状核查（20:02）

已复查全源/未跟踪、PipelineWarmupQueue 合同与依赖、所有 drainInFlight 消费、队列测试及规格：drainInFlight 没有生产消费方，因此不属于当前用户卡死的已证原因。真实 SDK 缺口是等待 GPU 异步编译时 Promise.resolve 微任务忙等会饿死宿主 task 回调。仅把等待改为真实队列结算通知；不改编译优先级/并发2/首帧放行，测试涵盖定时器驱动完成与编译拒绝，后续统一 SDK 构建纳入。

## 运行失败提示保留现状核查（20:15）

已检索全部 runtime hooks/Bridge failure/未跟踪文件，读取 AppRuntimeEffectsContext Setter/DeepBridgeRefs 与切换结果契约；React19与Vitest已有，不增依赖。正式消费是 Deep/WASM bridge.onRuntimeFailure→backend React状态更新→matchingactualActive分支。已读 rendererSwitch、rendererRecovery 和视觉诊断状态测试以及本规格。已有（不重建）：请求Symbol owner、candidate取消、真实bridge-active核对、failed文案。真实缺口：runtimeFailure没有撤销未结算owner，matching分支会清掉failed；旧成功Promise也只检查effect cleanup，可能在React提交前覆盖新失败。将同owner ref传给两个bridge回调，失败撤销owner，结果处理核对owner；真实callback+自动batch测试两backend，并保留主动取消/成功恢复行为。

运行失败保留3文件19 PASS，Web typecheck EXIT0；SDK warmup drain实际为3文件23 PASS。GI失去源后恢复重新捕获与设备epoch守卫15 PASS。

## 剩余逐帧CPU成本现状核查（20:30）

1. 已检索 packages/apps 全源及 git 未跟踪文件，定位正式 production GI-fixed steady/drag 的实际 minified 函数体；剩余热点是 StudioDeepEditorOverlaySession.read、authorSkinPose通用姿态复制、performanceTelemetry.snapshot，而非按chunk文件名猜测。
2. 已读 EditorOverlaySnapshot、OverlayClipPoint、SkinningPalette、EngineTimingQuantiles、RenderView及合同层：投影overlay为clip三角形且revision驱动GPU上传，不能忽略相机/viewport变化；骨骼浮点有限与affine校验必须保留。
3. Three/Vitest均已有依赖，不加库。
4. 正式消费者为 StudioDeepRenderView.renderViewDirect、StudioDeformationPoseSync.apply、resolutionScaler及sampleAdaptiveQuality。已有（不重建）：原始投影、透明/虚线/镜像裁剪、identity-bind姿态复用、计时nearest-rank统计、BASE_URL路由能力。
5. 已读 overlay/authorRoot/settle/skinPose/performanceTelemetry tests及两份真实CPU profile。GI-fixed稳态24.22s idle46.98%，overlay.read占2.395s/9.89%；115次ACK输入Deep3.410s、Three2.2635s，但输入后Orbit damping相机位置不同，不能作为GPU FPS或最终视觉对拍。
6. 已读本规格、handoff及recovery ledger。真实缺口：overlay每次先完整投影后才比较结果；通用bind骨骼不变仍复制；两项自适应统计读取全阶段快照。拟按实际作者输入内容缓存overlay（含相机、树/可见/材质/数组原地变化），保持所有验证；统计只求所需stage。Pages另有WASM模块根绝对URL漏用已有BASE_URL，窄改沿用现有加载合同。

CPU缓存focused：Web4文件47 PASS、Web typecheck EXIT0；palette/telemetry/adaptive5文件46 PASS、Deep core/lab/examples typecheck EXIT0；GI admission/frame相关4文件22 PASS。GI新测试按准入职责拆到独立leaf，source-size3476文件0 failures。生产性能需新包复测。

## 作者包指纹拖动热点现状核查（20:36）

已全源检索作者包key/refresh与未跟踪实现；读取SceneSnapshot.thumbnail及canonicalJson/FNV合同、现有package依赖、正式hook两处key消费与compileSceneRenderPacket、key/packet-sync回归和本规格。已有（不重建）：容量1编译packet缓存、排除camera/selection/capture-time、同canonical JSON跨端64位指纹。真实缺口：缓存命中前再次逐字节BigInt hash，生产drag父栈refresh→compileAuthorScene→key耗225.54ms；保存JPEG thumbnail不参与几何编译却仍进key。只排除thumbnail并以已有canonicalJson做容量1内容比较缓存，变化/非法输入继续原64位合同，原地作者修改仍检测；不根据camera变化跳过未知场景变更。

作者key/packet-sync/runtime切换相关4文件22 PASS，Web typecheck EXIT0。后续用户要求停止生成缩略图由主会话落实，历史thumbnail字段仍保留但不进入渲染包指纹。

生产CPU对比见 `test-output/studio-engine-lod-switch-20261007/final-cpu-improvement-summary.json`，按实际采样窗口占比归类：旧20.055s窗口GI规划/调度9.827s（49.00%）、idle0.31%；新GI修复稳态24.222s idle46.98%、overlay读9.89%。新115次输入3.333s profile中overlay占18.24%、作者指纹6.77%、thumbnail2.63%；这些尚未包含本轮CPU缓存与停止thumbnail生成。主会话记录GI修复后600帧74FPS/P95 14ms、GPU2.4ms/0长任务；视口1368×1028、pixelRatio1，不能写成1920×1080性能。

同起始相机 [14,11,16]→target[0,3.6,0] 的115次顺序ACK输入，Deep墙时3.410s、Three2.264s；各profile采样3.333s/2.217s。Deep两个长任务88/138ms，Three一个117ms；终相机分别[16.9692,9.80977,13.4255]和[16.3106,10.2388,14.0232]，实际时间差使Orbit damping推进量不同，所以这些仅是同输入数量吞吐与CPU证据，RAF数量与间隔不作为GPU呈现FPS或终画面一致性。

新cold阶段标记 switch→published5.1725s；作者包约2.11s，关键static2/deformation3已重叠约1.52s，上传0.918s、验证0.315s。热切停放消费已核对：同一packet引用校验与forceValidate prepareView，不再prepareGPU或重传；既有30秒/256MiB/设备与作者环境有效门保持。具体热切耗时仍需主会话同场景生产操作验收。

## 最终Core回归与视觉只读归因（20:58）

最新TS源码包含20:51的HDR环境specular cube COPY_SRC修复；20:54:05–20:57:50以maxWorkers2跑完整src/lab，867文件、6794 PASS、55 skipped，224.56s（`final-frozen-core-regression.log`）。Node脚本测试29 PASS，runtime purity通过1142 browser/core、841 native文件。source-size检查唯一新增失败为Native `contract/validate_texture.rs`303行，已交该文件owner处理。此轮没有重新运行真实GPU，不替代生产切换或画质验收。

对拍 `deep-production-specular-gi-fixed-after-drag.png` 与 `three-production-specular-gi-fixed-same-camera.png`：Deep远网格颗粒更明显，设备板件、馈料器边缘更粗；左后监控下与右后白色柜壁存在多道灰色条纹。此时作者投影配置temporalAA=false，但尚未验证候选真实features，后续21:40核查发现该false被候选配置覆盖丢失，不能据此排除实际TAA。玻璃scene-color来自本帧opaqueEffects，在TAA前取样，也没有读取历史图。

已有（不重建）：主HDR opaque pass颜色以4x MSAA硬件resolve，呈现UV覆盖完整源尺寸；实际pixelRatio来自作者Three renderer，未发现输出UV偏移或额外缩小。真实待验证缺口：OIT与网格是MSAA resolve后的1x pass，OIT以less测试sample0解析深度；sample0不是中心样本，源码注释不准确。此链可能使partial-coverage边缘整像素盖住或漏出，但不能单凭源码认定为远处多道灰线根因。当前grid四次¼像素textureSampleGrad过滤纹理，不能恢复多采样几何/深度coverage。灰线更接近阴影或材质细节错误，下一实景对照通过主方向光“投射阴影”正式UI开关使sceneRevision失效；直接改作者light.visible而不触发修订可能命中手势灯光缓存，不能单凭该操作排除阴影。

已核author shadow矩阵WebGL→WebGPU z转换、normalBias/bias/radius打包、5tap IGN/Vogel PCF与当前Three r186公式、deformed shadow读取currentPose与front-cull/zero-bias变体，未发现累计旧姿态的代码路径。后续需实景单项开关或像素pass捕获定位，保持Core冻结，不盲改AA或提升渲染分辨率掩盖。

## 光照编辑时整包更新被姿态抢占现状核查（21:04）

1. 检索packages/apps与未跟踪项，精确定位用户“Packet update cancelled or superseded.”来自PacketBuffers.cancelPendingPacketStage，非GPU validation错误。
2. 已读RenderPacket/DeformationPose/InstanceUpdate/RenderView及author sync合同：旧成功包可继续绘制，整包GPU候选未确认前不能被旧实例更新覆盖。
3. 沿用Three/Vitest，不增加依赖。
4. 真实链为Studio作者帧→deformationSync.apply→Backend.updateDeformationPoses→runtime.updateInstances→PacketBuffers.beginMutation，后者会取消异步setPacketValidated；Bridge refresh.catch再把该取消作为runtimeFailure切回Three。
5. 已读AuthorPacketSync取消/失败测试、Bridge真实动画集成、Backend packetReplacement/camera事务测试及主会话实景开关阴影失败证据。已有（不重建）：单次整包refresh、尾随最新revision、旧成功frame、backend identity取消隔离、成功后poseSync重绑。
6. 已核本规格/hand-off/恢复账本。真实缺口是refresh期间作者动画与outline继续写旧包。最小修复在同一Bridge事务期间暂缓这两类实例修改，保留作者动画推进和相机绘制；成功重绑后以最新作者姿态追平。真实上传/设备错误仍报告失败，不把所有AbortError一律吞掉。

整包替换/作者姿态4文件51 PASS，Web typecheck EXIT0。实景关闭阴影、重新进入Deep后灰线仍在；再关闭GTAO并重新进入后仍在，因此这两项不是当前灰线根因。新增显式 `?deep-capture-opaque=1` 诊断开关，只在现有两帧捕获窗追加已有opaque-hdr读回，不增加渲染pass或默认读回成本；相关3文件14 PASS，实景opaque与present对照待捕获。

## Deep帧率采样顺序现状核查（21:10）

1. 已检索packages/apps中StudioDeepPerformance、recordPresentationFeedback与未跟踪文件，没有第二套采样器可替代。
2. 已读PresentationPerformanceSource、FramePerformanceSnapshot与StudioDeepSampleWindow合同：rAF是提交后的帧回调反馈，不是GPU scan-out；同一回调区间多次提交只能记一帧，无提交不能生成帧。
3. 使用已有Vitest与浏览器rAF，不增加依赖。
4. 正式消费为Bridge.renderCommittedFrame成功提交后performance.record，以及Studio面板/共享A03 sampleWindow。作者循环先预约下一rAF，才触发Deep record。
5. 已读采样器10项回归、SampleWindow三项回归及生产74对Three143记录。现有测试均在外部调用record后才tick，未覆盖作者下一帧回调已排在统计反馈回调之前的顺序。
6. 已核本规格与handoff。已有（不重建）：提交CPU原始样本、GPU timestamp独立统计、同显示区间合并、pause/dispose取消。真实缺口：反馈回调只在record时单次预约，作者回调先执行时pendingFrame仍占用；每隔一帧才重新预约，可能把144次真实连续提交记成72反馈FPS。先用真实同族rAF顺序回归证明，再改为单槽连续反馈：仅发现新提交序号时计帧，末次无新提交立即停止，保留idle与取消语义。真实提交计数与GPU完成时间仍须生产profile对照。

新增作者自排rAF回归在旧源码精确复现144提交→72FPS；修复后6文件32 PASS，Web typecheck EXIT0。生产真实draws与queue完成profile仍待主会话复测，不直接把旧74FPS翻倍作为实测。

## 首帧后无消费主材质管线现状核查（21:17）

1. 已全源检索firstFrameMainKeys/deferredMainReady/prepareDeformation及未跟踪项。pipelines.ts发布后仍enqueue所有剩余main；生产静态与变形各27，最新main-ready在publish后13.2s/22.6s。
2. 已读Pipelines/PipelinesBuild、PreparedBatch、RenderPacket/InstanceUpdate和ResidentPacketProjection合同，首帧之后合法材质/raster/透明变化必须准备新key；同步SDK全量路径不能被改成缺管线。
3. 既有PipelineWarmupQueue、PipelineCompileCache和Vitest可复用，无新依赖。
4. 正式消费为PbrRenderer→PacketBuffers.setValidated/stageResidentProjectionValidated→packetDraw/mainPipeline，deformed的真实selected集合由PacketDeformationState持有。已有（不重建）：首帧实际key推导、static/deform bootstrap重叠、device max2队列、GPU验证/取消事务、shared texture-array fallback。
5. 已读pipelines/backgroundBudget/pbrPipelineSet与packetValidated取消/失败测试及主会话实景启动marks。真实缺口为没有按后续prepared batch准入新main key，故现有后台全编译不能直接删除。
6. 已核本规格、handoff与恢复账本。拟只在已有subset模式移除无消费main编译，为Pipelines新增内部按key准备；validated packet staging前使用同packetDraw键算法等待静态/变形实际key，复用max2并发/编译错误传播/取消。无subset独立SDK保留全量，阴影等现有绘制集合不减少；本轮不改shader、光照、AA或材质效果。

按需主管线与OIT composite捕获相关13文件103 PASS，Core/lab/examples typecheck EXIT0。真实缺管线driver拒绝测试额外暴露track的旁路then未处置拒绝，仅为该旁路添加拒绝处理，原请求仍报同一driver错误。实际后续key跨static/deform并发最大2、同key只编译一次、无消费main保持零后台编译；validated取消/失败保留上次geometry。主会话新sampler生产600样本144FPS/P95 7.1ms/GPU2.3ms，为当前静止无输入窗口。

## 活动姿态后整包重编译修订号现状核查（21:25）

已完成全源关键词/未跟踪、DeformationPose/source/子调色板修订合同、现有Three/Vitest依赖、StudioPoseSync→refresh→PacketBuffers stage正式消费、revision与GPU staging测试、本规格/handoff六项核查。已有（不重建）：strict单调修订校验、当前allPoses与Three作者动态读取、单candidate取消隔离、raw包引用去重。实景第二次光照更新在GPU staging报Stale deformation revision：packetBufferStaging在发布前对candidate与已活动snapshot逐source/pose校验，而重新glTF编译的pose修订重置0，活动pose已到N。仅在Studio作者候选边界沿已有pose同id/source提高修订并重新读当前Three姿态，然后进入原strictGPU门；不能清除旧snapshot或放松单调校验。需包含多个独立pose及palette/morph子修订的回归。

21:32源码安全点：Web7文件78 PASS，含实际Three三SkinnedMesh与strict staging同校验、5轮骨骼更新→reset0旧候选精确拒绝→新候选pose/palette单调、三morph连续两次替换；raw包引用去重在候选变换前，热切停车保留live PoseSync避免从旧绑定修订重启。Web typecheck EXIT0。Core13文件103 PASS、core/lab/examples typecheck和统一dist构建EXIT0（含Native specular writer），source-size9029全源≤800；身份清单 `final-on-demand-freeze.json`。此时新生产两次阴影编辑与composite捕获仍待主会话实测。

21:18同frame3隔离产物已复制为 `deep-pass-opaque-hdr-frame3.png`（SHA2351bd8c…）与 `deep-pass-present-color-frame3.png`（SHAcec7e7f9…），1368×1028。opaque内监控支架/右后栏杆/柜壁正常，present-color才出现重复条带且玻璃变黑；主会话确认SSR作者开关为off。材质实际roughness0时scene transmission只走单tap，因此不能将此图归因于四tap粗糙采样。新显式诊断追加composited-hdr固定白名单并沿现有readback预算/2帧窗复制真实temporalInput，后续三附件用于排开OIT/透射与Final链。普通URL不增加附件请求或渲染pass。

## Final后处理与瞬态计数现状核查（21:40）

1. 已检索packages/apps中temporalAa、ScenePostProcessingState、candidate实际配置、encodeFinal与瞬态统计，含限定未跟踪文件。
2. 已读ScenePostProcessingState（没有TAA字段）、PbrRendererFeatureOptions/default、RenderView.postProcess与PbrTransientTexturePoolStats：Studio既有projectStudioDeepEnvironment明确temporalAa:false，SDK默认true独立保留；acquireCount是累计调用，非驻留数量。
3. 继续现有Three/Vitest/WebGPU资源，不增加依赖。
4. 正式消费为SwitchCandidate→DeepWebGpuBackend.create→Bootstrap.resolveFeatures→encodeFinal。candidate重新组装features时没有携带Studio temporalAa:false，因此Core defaulttrue生效；MSAA4只禁用spatialAa，encodeFinal仍执行TAA。真实面板瞬态纹理却显示累计acquireCount，16/frame增长不表示live泄漏。
5. 已读环境投影、candidate生命周期、MSAA4与诊断面板测试及同frame2 opaque/composited/present三附件。opaque和composited均正常，present才有灰色重复条带/玻璃黑；present-color是Final链HDR读回，并非显示swapchain，排除后续ACES/spatial输出。最新实景两次castShadow编辑约80秒后仍Deep、logs[]、600反馈144FPS/P957.1；当前画质仍未通过。
6. 已核本规格、handoff与恢复账本。已有（不重建）：Studio不自动启用TAA的投影合同、完整Core TAA能力、实际free/inFlight/pendingReturn数量。真实缺口是candidate丢映射与面板使用累计数。仅恢复Studio候选temporalAa:false并钉实际创建配置；面板显示三类当前纹理数之和，residentBytes仍原合同。真实画质由主会话新生产同三附件验证，不把代码测试当视觉验收。

21:41真实候选TAA/诊断回归4文件71 PASS；瞬态面板以累计252080次获取但实际驻留4张的fixture证明显示4，而非累计数。三frame2附件已复制为deep-pass-{opaque-hdr,composited-hdr,present-color}-frame2.png，前两张SHA均608ddc6dee29cfe9de8e70a7f37b25ec01ec569115bd68c89df9a9c9b4122e19，present SHA d69240738a57894e3bc72a595b4958b4202e60c5dbacd9bf0a6ee4fc3099f75a；Final后处理之前逐字节一致。

主会话新正式生产标记switch-start44147→published50979，冷切6.833s，静态/变形main-ready51621/51648只比发布晚0.642/0.668s，已消除旧22秒无消费变体编译。真实快速两次castShadow更新后约80秒仍Deep、errors[]，无Stale/PacketCancelled；新steady profile采样25.187825s、idle13.8787s（55.1%），面板打开600反馈144FPS/P957.1、GPU2.3ms。JS heap在修改后增长仍需强制GC趋势核查，不能由累计纹理获取量认定live泄漏。以上均是在本轮Studio TAA合同恢复之前测得；新画质待生产对拍。
21:42 Web typecheck EXIT0。本轮Core源码/dist未变；实际TAA候选与实时纹理数修复仅Web四文件，主会话可直接构建Web并复验同帧附件。

## 作者无接触阴影与实际回执现状核查（21:46）

已完成packages/apps全源/未跟踪、ScenePostProcessingState与feature/default和FrameReceipt合同、现有依赖、正式candidate→PbrRenderer.contactShadows→Frames622/ContactShadowResources.encode/CONTACT_APPLY_WGSL消费、contact/捕获测试及本规格/handoff六项核查。已有（不重建）：SDK真实contact-shadow/contact-apply两pass及默认true能力、作者GTAO/主方向光阴影/SMAA/Bloom、authorDirectDisplay跳过额外屏空间效果。真实缺口：Studio没有contact作者字段/Three无对应pass，candidate却省略该字段继承SDK默认；现pass在OIT/Final之后把整幅颜色乘mask，玻璃也被不透明深度遮黑。实际执行回执函数完全漏记contact-shadow/contact-apply，故面板notExecuted不足以排除这两个真实pass。

主会话新生产TAA:false仍同灰带/黑玻璃，因此TAA合同修复有效但未解决该视觉根因。正式UI关闭后处理总开后，同场景Deep保持启用且灰带消失/玻璃蓝灰恢复；随后恢复作者后处理，不能以整体关效果交付。最小补缺口为Studio candidate显式contactShadows:false，保留所有作者效果；SDK默认不改。Core执行回执在与真正编码同条件host.contactShadows存在且非authorDirectDisplay时记录两真实pass，directClear早返回仍保持；无资源时不得虚报执行。

21:48接触阴影真实执行回执Core4文件41 PASS（有真实资源两个pass记录、无资源不虚报、两direct门保持）；Studio候选/诊断4文件71 PASS；统一Core build EXIT0、Web typecheck EXIT0。冻结身份见final-contact-freeze.json，作者post总开/GTAO/阴影/SMAA/Bloom保留的新生产视觉待验。
本轮最终source-size gate3486文件、0 failures，限定git diff --check通过。JS heap仅检查正常GC趋势；当前CUA CDP不支持HeapProfiler.collectGarbage，未执行强制GC，也无相关通过结论。

21:53主会话新正式生产contact合同通过：后处理总开保持开启，GTAO/SMAA保留，同frame2 present灰色条带与黑玻璃消失，编辑器ACES产线正常。证据deep-contact-contract-fixed-present-frame2.png、deep-contact-contract-fixed-editor.png均在test-output/studio-engine-lod-switch-20261007；面板600反馈144FPS/P957.1、GPU1.9ms、12pass、实际live16张。此单场景通过不替代五模型冷/热切与真实拖动、Three同相机对拍；主会话继续验证，最终Core全量maxWorkers2等待GPU窗口结束后运行。
新视觉证据SHA：deep-contact-contract-fixed-present-frame2.png为1d6b746e741ff030d6207b642ebad0f6e70f7554429caf029c7fb8a1fd45ac7c；deep-contact-contract-fixed-editor.png为93fda1e7ce7b2ddf8fad8601d012a8b6a2ffa7348a20a9c9f7b507a24be70d67。子任务已逐图查看，前者是HDR近似Reinhard诊断导出，后者是编辑器实际ACES呈现；两颜色域不可直接按亮度像素比较。灰带/黑玻璃修复依据各自同域前后及真实编辑器，远网格颗粒与Three同相机AA仍待后续对拍。

## 五模型热切保留预算现状核查（21:58）

1. 已全源检索inactive/retain/budget及未跟踪实现，定位StudioDeepInactiveCandidate和Bridge两处256MiB独立常量。
2. 已读内部候选、DeviceSession.resourceMemory、RenderPacket身份与真实PoseSync保留合同；没有增加多候选或绕过unknownResources的方法。
3. 复用既有单槽缓存/Vitest，不增加依赖。
4. 正式消费为prepareInactiveParking等待author/timer drain并回收free瞬态→publishWebGl读取真实estimatedBytes→retain→下次GPU frame admission重用；现真实五模型trim后312,465,992字节被256MiB拒绝。
5. 已读单槽30秒/scene变化/device loss/不可读状态与Bridge停车等待测试、Root五模型生产marks：Deep冷切10.2904s成功UI响应，作者包3.14s；重复GLB编译仅11.8ms但新GPUcreate仍1.8835s。已有（不重建）：严格单槽、30秒、实际显存/unknown0判据、scene/packet/环境身份、最新pose基线、超过预算释放。
6. 已核本规格/handoff与生产证据deep-five-model-contact-startup.json。Root授权按真实模型需要把有限单owner预算统一为384MiB，两处共享同一常量；仍仅30秒，超过384/unknown非零/pending更新不保留。此调整依据实际trim后312MiB需求，不取消显存上限或延长缓存寿命。先完成当前20秒拖动窗口再动源码。
用户再报当前入口切换卡死后，主会话取消尚未开始的20秒拖动采样，转查5173dev/5180prod真实身份与同入口；授权立即落实384MiB有限停车。聚焦4文件60 PASS（312,465,992/384MiB边界真正Bridge复用，只create一次；>384或unknown仍释放重建），旧单槽替换/30秒、pose/queue及取消路径保留。该修复针对已证312MiB停车拒绝，不作为新用户Freeze根因结论。

22:04 RuntimePackage大纹理Base64叶由交付子任务完成安全点：6×2048真实96MiB像素build→serialize→strictparse→materialize哈希相同，4文件70 PASS；旧黄金58 PASS；直接生成已校验artifact避免重复验签/重水化的相关4文件62 PASS，Core源typecheck EXIT0。该叶尚待引擎验证子任务统一dist构建与最终全量，GPU shader/AA/主管线未改。CPU大纹理验签测试耗约50秒，正式实景性能采样与全量回归错开。

### 诊断读回 CPU 保留与 owner 交接：现状核查

1. 已检索 packages/apps 源码、未跟踪项及 readback/captureRequested/publishedSession；Studio 全局读回历史上限8项已存在，不新增采集机制。
2. 已读 PbrFrameReadbackResult、FrameCaptureSession 与 StudioFrameReadbackEntry 合同；图像 bytes 为真实 Uint8Array，渲染资源生命周期由 Core 管理。
3. 已核对 Web package 的既有 Deep/Vitest 依赖，无新库。
4. 唯一回调创建方是 SwitchCandidate，面板与编辑诊断读取同一有界历史；候选创建时未发布，正式发布后才开启两帧窗。
5. 已读 captureDiagnostics 现有窗口/关闭/owner测试、Core readback 合同与生产内存证据；普通附件约17MB/帧，隔离四附件更大，8项上限仍会跨关闭保留 CPU bytes。
6. 已核对本规格、handoff和恢复 ledger；既有两帧重采窗口不重建。真实缺口是关闭或释放当前 owner 未清读回数组，旧 backend 晚到回调没有 owner 校验。只清当前读回引用并绑定创建 session；旧 owner release 不清新 owner 数据，关闭后重新打开继续采新两帧。此处是 CPU 引用保留，不能据此认定无限 GPU 泄漏。

诊断读回关闭/owner交接与桥回归2文件48 PASS，Web typecheck EXIT0。统一 Core Base64 dist build EXIT0；51文件 source/dist/web身份写入 final-base64-readback-freeze.json，aggregate d4fef42ec93332c3cf5206207e7fd9d9b88ce8e64173c39fa3b6936ed9939ec3。5173旧 dev transformed cache 与已存在 bridge 必须重启/全量重新载入再验收，当前用户切换卡死仍由主会话实测，不将生产静态600帧144FPS推断为切换通过。

### 5173 真源 CPU：动态 palette 验证与 Overlay 编码现状核查

1. 全源及未跟踪检索已定位 packJointPalette、PoseValidator、EditorOverlayPass/Types、Studio overlay缓存；已有上传双缓冲、姿态/源revision及投影缓存不重建。
2. 已读 SkinningPalette、DeformationPose、EditorOverlaySnapshot、RenderView 合同；输入 typed arrays 可原地修改，不能仅凭对象/revision 跳过内容验证，来源与 palette 成员保持严格。
3. 沿用 Core TypeScript/WebGPU/Vitest，既有依赖不增加。
4. 真 dev profile 父栈表明一次 pose 更新会在 validateUpdate、prepareInstanceUpdate、资源更新三处 PoseValidator 中调用 packJointPalette 并丢弃 packed数组，实际 GPU 上传再打包一次。Overlay encode 对已有 Studio 投影缓存仍每帧先全量复制/验证再 .every 比较。
5. 已读 poseValidation、gpuSkinning、editorOverlayPass 既有 malformed/成员/原地变更/revision/upload failure 测试，以及 355.828s dev profile（300001 samples）；packJointPalette12.21% self，Overlay copy+encode重复扫描占明显成本。该窗口含开发 HMR和动画，不能当冷切阶段或生产 FPS。
6. 已读本规格既有 CPU缓存、handoff及恢复ledger。真实缺口只补 allocation-free palette validate（保留布局、finite、缺省 inverse-transpose有效性）和 unchanged overlay owned快照复用；变更仍旧 snapshot验证并上传，编辑/相机/动画不关闭。停车单槽 take 是移交非 clone，dispose断开 currentPacket/WeakMap，无证据支持无限同scene clone积累。

### 停车 device.lost 回调引用：现状核查

已全源/未跟踪检索停车与device.lost，读取 DeviceSession loss/Bridge单槽合同、现有WebGPU依赖、retain→take/clear→unsubscribe消费，停车/lossfocused测试与本规格/恢复文档。已有30秒单槽、fatal loss可撤销订阅与identity保护不重建。真实缺口：每次park的 device.lost Promise不能取消注册，then直接保留 invalidate闭包及本次candidate value，到device失效前仍可达。unsubscribe清可变callback引用，只留下空回调壳；当前parking真实loss仍触发回收。没有强制GC证据，修复范围是可达引用链，不据此声称系统全部内存稳定。

动态CPU focused5文件62 PASS/1既有skip，姿态资源后继4文件28 PASS/1既有skip；统一Core dist build EXIT0。device.lost停车引用后继3文件55 PASS；同device3次warm移交后最后停车loss只回收一次，新backend不误清。最终59文件身份82b4f8e3f92902152df1b19a8605e849e66c312e573a8f6098d41f6ee889225f。主会话 fresh5173 --force实际单次停车eligible300365384B，热切217052.6→217405.4约353ms、未重建GPUbackend；反复切换/拖拽内存与最新CPU采样仍待真实窗口。保留全部动画、selection/gizmo/测量overlay，未以关闭效果减少开销。

同族继续核查诊断 React 消费：useRendererDiagnostics 在面板关闭后停止500ms更新，但其 frameReadbacks useState 仍保留旧数组。全局清理不足以释放 hook 所有引用；在已有关闭 effect 同步读已清空历史，无新订阅/渲染采集。现有 hooks 使用可重渲染 React effect harness，沿用此方式核实际关闭状态释放。

### Generic bone snapshot 直写 typed arrays：现状核查

已全源/未跟踪检索 captureAuthorSkinPose/Palette、SkinningPalette/AuthorSkinPose与64joint引用合同、既有Three/Vitest依赖、Studio.apply及GPU消费、authorSkinPose/pose replacement测试和规格/恢复文档。已有Generic输入内容与owned输出防篡改缓存不重建。实际8.307s真源profile只见一条captureGeneric→apply父栈，pack仅剩GPU上传23.65ms；未证同frame重复同mesh捕获。真实缺口是changed generic已校验所有输入后再次captureAuthorSkinPose，重复遍历并先分配冻结普通array再copyPalette转typed。共享同一joint数学写入器，公开AuthorSkinPose继续immutable普通数组/copyPalette独立复制；内部generic直接写新的ownedtyped数组，保持cached输入/输出防篡改、inverse顺序、float32范围/affine校验和动画变化检测。

### 私有 transient 准入正常路径避免抛异常：现状核查

已检索全源/未跟踪 isPbrTransientPoolEligible 与目录查询，读 PbrFrameResourceContract.historyRole/瞬态池合同、既有Core依赖、beginFrame/acquire消费、history/private scratch/预算测试与规格/恢复文档。已有显式history排除与目录historyRole兜底不重建。真实8s profile约1.54%落在目录异常创建/捕获；私有MSAA目标本来允许却每次借 fail-closed目录查询抛Error再catch。仅改直接读已有PBR_FRAME_RESOURCE_CONTRACTS；公共目录查询的缺项抛错保持，所有history仍拒绝，合法合同外私有目标仍允许。

最后CPU族：Generic direct typed/严格变形3文件53 PASS；Generic+瞬态准入3文件33 PASS；公开snapshot与动态typed共享math，64joint/changed动画对Independent Three矩阵一致。最后统一Core build EXIT0。私有transient不再正常Error/catch，公共缺项仍抛错、全history目录仍排除；当前源码停止编辑等待真实paired与三切。关闭React hook的图像holder也清理，2文件8 PASS。

真实六次 warm marks已逐次校准：最后6次Deep进入分别346.4/270.6/315.8/287.3/323.4/261.6ms，全部inactive-reused、0 backend-create；并非cold混入。含中间Three停车/UI全循环5.152s另口径，日志[]。分析文件 dev-repeat-switch-6-cycles-analysis.json。最新Core轻门purity1144/848/382 PASS、source-size3492 files0failures；当前最后源身份 c585783749f835817446cb362b1f6d601e59d8ac5c7da5c9f333bda5ed0a0d6c。Fullsuite与最终RT两反弹真GPU窗口待主会话分配，不把focused+静态steady等同所有场景验收。

Web整体typecheck后继已由Worker owner收口：session55984 EXIT0，先前59550的原生Worker onmessageerror签名错误已修。6 Worker files39 unique PASS为该owner范围；本任务hook/parking/Core源继续冻结。RT5197和scene transmission5198已CPU重bundle到当前Core，尚未点击Run，旧result不算新验收。

### 单次切换被 autosave 无限重启：现状核查

1. 全源/未跟踪检索 RuntimeEffects/DeepBridges/rendererPreference/switchTo；原symbol owner、候选取消、错误回退和场景编译容量1均已有，不重建渲染协调器。
2. 已读 AppRuntimeEffectsContext/RendererRecoveryContext、RendererBackend及SceneSnapshot/revision、Bridge switched/failed/cancelled 合同；全局revision是编辑/自动保存通知，不是新的引擎切换请求。
3. React19/Vitest及Worker终止边界已有，无新依赖。
4. 正式请求来自 changeRendererBackend→rendererBackend；switch effect却依赖revision/showError，在每5s autosave cleanup取消两座桥又以同desired创建。bridge setup也将showError身份作为寿命；WASM refresh按revision无内容去重。
5. 已读真实effect harness的取消/迟到/自动batch/失败偏好测试与冻结无HMR的 dev-smt-wasm-worker-startup.json：一点击42140开始，随后47248、52250持续重新start直到137478。真实OOM不能再归HMR；CoreCPU/GPU已冻结。
6. 已核规格、handoff和恢复ledger。真实缺口仅补引擎意图/owner生命周期：revision/进度/新callback不得重启candidate，最新通知从ref读取；prepare rejection也必须settle desired/active并failed，不留后续自动retry。WASM refresh按现有author语义key跳过同scene autosave，语义变化仍刷新。Core/RuntimePackage/Draco数学不改。

两桥正式 beforePublish 交接增加 project.id + 既有 author scene/assets key 守卫；模型新增/删除、材质、GI灯光和切scene准备途中变更均拒绝旧候选，旧画布继续、failed可见，需显式重试；时间戳/camera/selection变化不重启也不阻止接管。WASM实际 compilePackage 回调记录成功编译的key，350ms刷新消费测试覆盖连续8次同内容保存0refresh、实际模型删除1refresh、下一次保存不重复。两文件26 tests PASS；整体Web tsc EXIT0；三叶身份 final-single-request-lifecycle-identity.json。Core保持 c585冻结；无HMR的一点击实际WASM冷链及30秒autosave窗口由主会话随后复测，尚不据focused宣称OOM已验收。

主会话冻结源码实际一点击WASM成功：switch-start100415.7→module100460.9→packageCompiled133242.0→renderer-ready144335.6→published144340.9，总43.9252s；持续自动保存没有重复start/OOM。生命周期根因已实景复验，启动性能未达标，worker32.7811s与native准备11.0936s由交付owner继续优化。运行中refresh失败同族只读核查：Bridge.refresh catch先publishWebGl并调用onRuntimeFailure，正式setup回调撤销switch owner、settle desired/active并写failed/detail；hook随后同值set不清错误。未证正式链隐藏失败，无需修冻结source。最终Core全量src/lab maxWorkers2已开始，开始前c585冻结49个Core src/dist叶全部哈希一致；fullsuite结果随后填写。

### Native高光合同既有测试校准：现状核查

已全源/未跟踪检索specular四字段、Native runtime semantic与material parser；读RenderPacket/Native tuple及严格factor/color/texture合同；Vitest/glTF已有依赖不新增；真实消费为Native/WASM writer→Rust materialize→shared WGSL，已有Native GPU8断言。已读decodeTexturedGltf.specular与runtimePackage NativeSpecular测试、交付证据及本规格/恢复ledger。已有双端spec4字段/两semantic实现不重建；真实缺口仅旧glTF测试仍断言Native不支持。测试only改同源包Native validate成功且重新materialize factor/slot/bytes相等，并保留越界factor与真实unknownsemantic拒绝。Root允许该测试only收口，生产源继续冻结。

WASM实景后继发现published后空图/0draw，交付owner正在查camera/instances/upload。先前43.925秒单次published及autosave无重启只验收生命周期，WASM场景画面尚未通过。

最终Core全量已完成：src/lab maxWorkers2，875 files/6831 tests PASS，55既有skip，0fail，251.20s，EXIT0。旧Native合同负例test-only校准后15 focused PASS，越界specularFactor和unknownsemantic仍拒绝、正式Native materialize factor/slot/pixels一致。末次2294个src/lab code文件全部哈希未变，生产冻结49个Core src/dist叶仍全部匹配c585；完整code身份142b3ac48bd73ef13335117525482e24ef604b6ea8eda16fef4468cc4b415463。日志final-complete-core-regression.log及身份final-complete-core-regression-identity.json；上一轮6830PASS+1旧合同失败另存round1，不计作最终通过。RT5197/Transmission5198真实GPU尚未Run，WASM空画面待交付owner修复，不扩张CPU全量结论。

### 当前蒙皮姿态取景：现状核查

1. 全源/未跟踪检索fitAll/fitSelection/focusModel/visibleObjectBox/bindMatrix，Three与Deep/WASM相机同步、visible对象过滤、聚焦已存在不重建。
2. 已读ViewerEngineContract fitAll/focusModel/focusBox与CameraState/CameraConstraints，Three r186 SkinnedMesh/Box3正式合同：getVertexPosition包含morph与bind/skin/bindInverse；object.boundingBox非自动动画刷新。
3. Three0.186.1与BVH/现有Vitest已用，无新依赖；加载design-taste-digitaltwin规则，保持原相机ease与令牌。
4. fitAll→frameScene→sceneContentBox→visibleObjectBox仅原geometry bbox；focusModel→focusObject及inspected standardView使用非precise Box3，命中预热时一次skin bbox可能陈旧。visibleObjectBox同时被GI/碰撞/阴影每帧消费，禁止全局顶点扫描。
5. 已读sceneObjectUtils/cameraFramingIntegration/threeShaderWarmup测试、真实SMT target=(-51.2715,4.9244,-.6308)空图与非空packet证据。
6. 已核规格/交接/恢复ledger。真实缺口仅相机取景缺当前pose：增visibleObjectBox显式poseAware选项默认false，命令fitAll/focusModel/standardView使用true；Three.computeBoundingBox/getVertexPosition复用，按geometry attribute版本、骨骼world/inverse/bind矩阵和morph权重缓存local bbox，世界变换单独现读；过滤hidden/layerDeleted/effectHelper保留，instanced使用实例bbox。Root已结束拍摄窗口并授权三叶窄修，Core不由本任务改/build，与delivery唯一build协调。

当前姿态取景三生产叶安全点：sceneObjectUtils poseAware默认false、NavigationTools fitAll/standardView及ObjectState focusModel命令启用；当前bone world/inverse、bind矩阵、morph权重、geometry/instance attribute版本缓存，不增加每帧遍历。独立skin/instance boundingSphere以本次AABB保守包络同步，防止旧sphere把正确新镜头剔空，不做第二次顶点扫描。4files27tests PASS，Web整体tsc EXIT0，source-size9051files PASS，scoped diffcheck PASS；原POSITION中心-50/骨骼+50的Three fixture fitAll target0，再+60 selection10、+70 standardView20；同pose重复访问只compute一次，默认fast路径0compute。生产Core没有改/build，Delivery独占初始静态skin/morph bake。真实SMT framing视觉尚待主会话重载验证，身份final-current-pose-framing-identity.json。

### 最终场景透射 GPU 复验（2026-10-07 23:28）

当前冻结shader与正式PbrRenderer在160×96 / 4x MSAA标准fixture运行，Composer和direct两条输出均通过。alpha1、stock IOR1.45、零IBL仍可透出既有不透明场景色；透射0保持阻断，opaque遮挡正确，粗糙度增大后对比度316→126 / 311→156，diagnostics=[]。没有借alpha降低替代物理透射，也没有新增场景渲染。8个shader/frame/draw与fixture来源叶SHA全部匹配，acceptance=true。

证据：[原始GPU色差结果](../../test-output/scene-transmission-20261007/result.json)、[8叶身份和输出腿汇总](../../test-output/scene-transmission-20261007/final-summary.json)。这是透射控制fixture，SMT视觉与三引擎同相机对比仍以主会话实景截图为准。RT完整帧30样本定标已记入 [studio-react-rt-quality](studio-react-rt-quality-20261007.md#最终生产-1080p-rt-二反弹定标2026-10-07-2328)，3-instance标准场景GPU P95 SSR1.310720ms / SSR+二跳2.424832ms，不外推到2.4M三角形产品场景。

Delivery统一Core初始pose后继已冻结：identity80fba64a5aeae380d21a79a3d9b7132b082649a063e9ac957ce6407117eee4e2，独立Three真实SMT134470triangle oracle bounds最大误差5.50e-7，GLTF31files291PASS，Core/lab/examples tsc0。其变化仅decodeDeformablePacketGlb与bakeInitialGltfPose；此前6831全量是变更前源码，不冒充最新全量。变更后相关runtime/Native/materialize/deformation/camera5files63PASS与Web正式编译/Native frozen payload/Worker/Bridge/hooks8files122PASS；runtimepurity1146/848/382PASS、SourceSize9052PASS。未二次重建覆盖唯一dist；RT10/透射8shader叶仍全部匹配实际GPU结果。当前所有相关CPU进程结束，生产SMT framing/WASM像素由主会话随后真实页面验收。
