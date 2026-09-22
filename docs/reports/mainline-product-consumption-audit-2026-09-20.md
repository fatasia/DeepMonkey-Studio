# 主线底层能力到产品消费审计（2026-09-20）

审计对象是 `mainline-closeout-2026-09-20.md` 本轮新增的 R10 / R12 / R1 / R4 / R9 / G3 / C3 / E02 / E04 / E05 / R11 / P5 / P7。结论只按当前代码可到达路径计算；单元测试里的独立构造、仅导出的 helper 和底层 shader 存在，均不等于产品已经接入。

## 判定口径

- **已闭环**：用户可操作入口或明确的产品默认策略，状态可恢复，正式编译/投影链消费，并有 Web 或 Native 运行宿主与测试。
- **部分闭环**：至少进入一个真实产品宿主，但仍缺持久化、正式发布编译或另一端消费。
- **内核就绪**：实现与 focused 测试存在，但从产品入口不可达，不能计为已交付能力。
- **不适用**：诊断或透明运行优化本就不应进入场景作者协议；仍必须证明产品宿主实际调用。

## 总表

| 能力 | Author UI / 产品策略 | 保存恢复 | 正式编译 / 投影 | Web 消费 | Native 消费 | 结论 |
|---|---|---|---|---|---|---|
| R10 Physics | `ScenePhysicsPanel` 已挂到 Studio，可编辑刚体、双端 revolute、Impulse/Multibody、限位和马达 | `SceneSnapshot.physics` 与对象 `physics` 经场景编辑命令保存 | `compileScenePhysicsRuntime` 进入 dynamic-runtime v3 | `PhysicsWorldHost` / Rapier Viewer 真步进 | `player_content` 创建 `NativePhysicsHost` 并回写 RenderPacket pose | **已闭环**；真实 torque cap 仍未支持 |
| R12 捕获 / Source Map | Renderer Diagnostics 中挂载 `FrameCaptureSourceMapPanel`，显式开启才采集 | 不适用；诊断开关不应污染场景 | PBR actual-pass / WGSL provenance 直接来自运行编译计划 | `StudioDeepWebGpuBridge` 创建有界 capture session，PBR render loop 记录 | 不适用 | **部分闭环**；通用资源快照/读回未完成 |
| R1 Surface Cache / DDGI | 无作者参数；可视为透明效果运行策略 | 不适用 | RenderPacket→surface cache 编译器存在 | Probe capture/filter/PBR binding 模块已完成，但 `ProbeClipmapPbrController` 当前只在测试中实例化 | 无 | **内核就绪**，尚未进入正式 PBR renderer 产品宿主 |
| R4 Hi-Z / clustered / indirect | Studio Deep 投影固定启用 occlusion，Bridge 打开 meshlets；无场景语义 | 不适用 | RenderPacket/feature plan | `PbrRenderer` 真实生成上一帧 Hi-Z、cluster compute、indirect draw 与 metrics | Native 有独立 GPU culling/Hi-Z/LOD 运行链 | **已闭环（透明优化）**；万灯整帧收益和设备降级证据仍需终验 |
| R9 virtual geometry | Studio Deep Bridge 以产品策略启用 meshlets | 不保存开关 | bake/residency/author LOD 可携带 meshlet ranges | meshlet GPU cull→stable compact→indirect draw，消费上一帧 Hi-Z | Native 有 mesh/LOD/indirect 路径，但不是同一 virtual-geometry 分页 ABI | **部分闭环**；不是 visibility-buffer/分页虚拟几何 |
| G3 HLOD | 无 UI 或产品默认策略 | 无 | `boundsHlod` 可生成分区 AABB far proxy；正式 prewarm 支持该选项 | 非测试调用方没有传入 `boundsHlod` | 无 | **内核就绪**；当前产品包不会生成 HLOD |
| C3 revision / Deep2D 增量 | 不适用；作者继续编辑原材质、纹理、LOD 和 2D 内容 | 原 Scene/RenderPacket revision | Packet staging 按 revision/identity 编译 | PacketBuffers、texture resources、LOD uniform 与 Deep2D batch 真正减少上传/分配 | Native scene cache / Deep2D 有独立 revision cache | **已闭环（透明优化）**；效果账本只证明上传后的 GPU 身份，不替代视觉对拍 |
| E02 IES | 聚光灯编辑器可导入 LM-63、选择 profile、编辑旋转/倍率 | `SceneLightState.ies` 与 `GlobalLightingState.lightProfiles` 随场景保存 | `compileSceneLighting` 严格输出引用闭合的量化 profile，并进入正式 `scene.environment` 运行包 | Studio 将正式作者状态投影到 Deep 环境；cluster compute/WGSL 真消费 IES buffer | Native runtime 严格解析同一环境载荷，renderer 真上传并绑定 IES buffer | **Web/Native 已闭环**；旧场景省略字段保持兼容，非法类型/引用/预算 fail-closed |
| E04 SSR 二期 | 后处理面板可启用 SSR，并编辑步数、命中厚度与追踪距离 | `ScenePostProcessingState` 保存有界质量参数，旧场景缺省关闭 | Studio Deep 将作者参数编译为 `screenSpaceReflectionProfile`；Three WebView/Deep Native 明确阻断，不冒充对等 | Deep Bridge 分配 SSR 能力，逐帧开关/profile 进入真实 trace+composite，保持 TAA 前顺序 | 未支持；Native 发布检查返回精确缺失的深度/法线/HDR 合成原因 | **Studio Deep WebGPU 已闭环 / Three、Native 明确不支持** |
| E05 PCSS / 多灯阴影 | 聚光灯编辑器在投射阴影时提供 0–1 柔化参数 | `SceneLightState.shadowSoftness` 随灯光保存，旧场景缺省 0 | Studio 将作者灯 ID/柔化值投影成稳定 atlas key 与 `LocalLightShadow.softness`；Three/Native 精确阻断非对等交付 | local spot atlas 真消费作者 softness，0 保持 PCF，正值进入有界 12-tap PCSS | Native 尚无对等 PCSS 参数链 | **Studio Deep WebGPU PCSS 已闭环**；点光阴影、Three/Native 对等仍未完成 |
| R11 动画状态机 | 导演台 `SceneAnimationStateMachineEditor` 可创建、切换、编辑条件参数 | `SceneAnimationState.stateMachine` 随场景保存 | **本次补齐**：正式 `compileSceneRuntimePackage` 合并状态机为 dynamic-runtime v2/v3 | 正式 Scene Viewer 从冻结发布快照构建同 ABI runtime package，实例化 `DynamicAnimationControllerPlayer`，启动活动片段、应用持久参数首条转场并在卸载时停止 | Native 严格解析并生成确定性 command，但产品播放器未调用 `animation_controller_command` | **Web 已闭环 / Native 部分** |
| P5 空间校验 | `查看与分析 → 工程分析与导出` 可设置净空/限高并运行 | 规则参数仅组件本地 state，重开丢失 | 直接读取当前可见 Viewer 对象，无运行包 | 真计算并导出 JSON/CSV | 无 | **部分闭环**；入口和导出可用，规则不可保存/发布 |
| P7 QTO | 与 P5 共用产品面板，按当前模型分类/楼层聚合 | 无可保存口径或映射规则 | 直接读取 Viewer 对象，无运行包 | 真计算并导出 CSV，含公式注入防护 | 无 | **部分闭环**；真实项目分类口径、保存恢复与定位回跳仍待 |

## 可追溯代码与测试

### R10

- UI / 保存：`apps/web/src/components/ScenePhysicsPanel.tsx` → `apps/web/src/controllers/sceneAppearanceCommands.ts` → `packages/contracts/src/scene.ts`。
- 编译：`apps/web/src/delivery/compileScenePhysicsRuntime.ts` → `apps/web/src/delivery/compileSceneRuntimePackage.ts`。
- Web / Native：`apps/web/src/viewer/physicsWorldHost.ts`、`apps/web/src/viewer/rapierPhysicsJoint.ts`、`packages/deep-engine-native/src/player_content.rs`、`packages/deep-engine-native/src/native_physics.rs`。
- 关键测试：`ScenePhysicsPanel.test.tsx`、`physicsWorldHost.test.ts`、`rapierPhysicsJoint.test.ts`、`compileScenePhysicsRuntime.test.ts`、Native `native_physics` tests。

### R12

- UI / 宿主：`apps/web/src/components/RendererDiagnosticsPanel.tsx`、`FrameCaptureSourceMapPanel.tsx`、`viewer/studioFrameCaptureDiagnostics.ts`、`viewer/StudioDeepWebGpuBridge.ts`。
- 运行捕获：`packages/deep-engine/src/webgpu/pbrFrameCapture.ts`、`pbrRenderer.ts`、`src/r12/frameCapture.ts`、`src/r12/shaderSourceMap.ts`。
- 关键测试：`FrameCaptureSourceMapPanel.test.tsx`、`studioFrameCaptureDiagnostics.test.ts`、`StudioDeepWebGpuBridge.test.ts`、`pbrFrameCapture.test.ts`。真 WebGPU 四场景证据仍以 `test-output/r12-frame-capture-1789911884763/evidence.json` 为准。

### R1 / R4 / R9 / G3 / C3

- R1：`lighting/probeSurfaceCachePacket.ts` → `webgpu/probeClipmapPbrController.ts` → `webgpu/probeClipmapRuntime.ts` / `webgpuProbeCaptureAdapter.ts`。全仓非测试引用没有创建 `ProbeClipmapPbrController`，因此不能写成产品 PBR 已接入。
- R4：`apps/web/src/viewer/studioDeepEnvironment.ts` / `StudioDeepWebGpuBridge.ts` → `webgpu/pbrRenderer.ts` → `hiZPyramid.ts` / `clusterCompute.ts` / packet indirect draw；Native 对应 `renderer/hi_z_pyramid.rs`、`gpu_culling.rs`、`gpu_scene_draw.rs`。
- R9：`assetBakePlan.ts` / `assetBakeResidency.ts`、`runtimePackage/prewarmPlan.ts`、`webgpu/meshletIndirectExecutor.ts`；产品 Bridge 明确传入 `meshlets: true`。
- G3：`packetBoundsHlod.ts` → `assetBakeResidency.ts`。除测试外没有调用方配置 `boundsHlod`，这是当前断点。
- C3：`webgpu/packetBuffers.ts`、`textureResources.ts`、`authorGridResources.ts`、`webgpu/deep2d/frame.ts`、`materialEffectLedger.ts`；Native 对应 `gpu_scene_cache_refresh.rs` 与 Deep2D cache tests。

### E02 / E04 / E05

- E02 作者/保存：`SceneIesEditor.tsx` 从产品灯光面板导入 LM-63，`sceneIesAuthoring.ts` 解析、量化并以内容哈希生成稳定 profileId；`SceneLightState.ies` 与 `GlobalLightingState.lightProfiles` 由现有场景保存控制器持久化。合同层限制聚光灯、引用闭合、64 profile / 1048576 采样总预算。
- E02 编译/消费：`compileSceneLighting.ts` 把 profile 与引用写入正式 `scene.environment`；`studioIesAuthorCarriers.ts` 把保存状态投影给 `studioDeepEnvironmentLights.ts`，后者进入 `lighting/clusterCompute.ts`、`clusterLightingPbrWgsl.ts`。Native 同载荷经 `scene_lighting.rs`、`ies_shading.rs`、`renderer/init/resources.rs` 与 `native_mesh_v1.wgsl` 真消费。
- E04 作者/运行：`ScenePostProcessingEditor.tsx`、`sceneValidation.ts`、`studioDeepColorEffects.ts`、`StudioDeepWebGpuBridge.ts`、`pbrPostProcessOverrides.ts`、`pbrPostProcessChain.ts`。作者质量参数被严格验证并进入真实 GPU pass；`sceneClientPackage.ts` 与 `scenePublicationCompatibility.ts` 分别给 Three/Native 精确阻断原因。
- E05 作者/运行：`SceneSpotShadowEditor.tsx`、`SceneLightState.shadowSoftness`、`viewerEngineEnvironment.ts`、`studioDeepEnvironmentLights.ts` → `localSpotShadowRuntime.ts` / `localSpotShadowShader.ts`。稳定作者灯 ID 用作 atlas key；softness=0 保留 PCF，正值进入有界 PCSS。Three/Native 交付不静默降级。

### R11 / P5 / P7

- R11 UI / 保存：`SceneAnimationStateMachineEditor.tsx`、`SceneTimelinePanel.tsx`、`packages/contracts/src/scene.ts`。
- R11 正式编译 / Web consumer：`compileSceneAnimationController.ts`、`compileSceneRuntimePackage.ts`、`dynamicAnimationControllerPlayback.ts`、`sceneViewerDynamicPlayback.ts`、`SceneViewerRoot.tsx`。正式 Viewer 现在实例化 player，映射到 `controlAnimation` / `transitionAnimationClip`，同步 loop policy，且停止函数幂等清理活动模型。
- R11 Native：`packages/deep-engine-native/src/runtime_package/dynamic_scene.rs` 只在本模块测试调用 `animation_controller_command()`；主播放器尚未调用，故不计 Native 产品消费。
- P5/P7：`SceneToolDock.tsx` → `SceneEngineeringAnalysisPanel.tsx` → `viewer/spatialValidation.ts` / `viewer/qtoTakeoff.ts` → `browserDownload.ts`。面板的净空/限高为 React 本地 state，关闭后不恢复。

## 本次落地与后续顺序

1. 已补 R11 正式发布编译断点：状态机和既有 timeline / physics 共用 `scene.dynamic`，无 physics 时使用 v2，有 physics 时使用 v3；禁用状态机不产生 channel，非法引用继续由 runtime validator fail-closed。
2. R11 Web Viewer 已完成；Native 仍需消费 command 并接其动画宿主，避免 ABI 停在 helper。
3. E02 作者合同、资源导入/保存、正式编译与双端运行消费已补齐。
4. 下一优先级是把 R1 controller 创建和 RenderPacket sync 接入正式 PBR renderer；这是“底层完成但产品不可达”中影响最大的效果断点。
5. E04/E05 需要先扩作者协议和 Studio 投影，再谈默认质量档；G3 则需让正式 runtime prewarm/asset bake 策略传入有预算的 `boundsHlod`。

## 本次验证

- Web 产品链 focused（R10/R11/R12/P5/P7）：9 files / 46 tests passed。
- Deep 能力链 focused（R1/R4/R9/G3/C3/E02/E04/E05/R12）：11 files / 84 passed / 4 environment skips。
- R11 正式 Viewer 增量 focused：4 files / 29 tests passed。
- E02 正式作者协议与运行包 focused：Contracts 1 file / 2 tests，Web 5 files / 45 tests passed。
- E04 正式作者链 focused：Contracts 1 test，Web 3 files / 36 tests，Deep 1 file / 16 tests passed。
- E05 聚光灯 PCSS 作者链 focused：Contracts 1 test，Web 3 files / 32 tests passed。
- `pnpm --filter @bim-studio/contracts typecheck`：passed。
- `pnpm --filter @bim-studio/web typecheck`：passed。
