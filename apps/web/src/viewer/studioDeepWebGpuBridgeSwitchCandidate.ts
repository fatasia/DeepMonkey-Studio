import { DEFAULT_DISPLAY_CONTRACT } from "@bim-studio/contracts";
import type { DeepWebGpuBackend, ThreeObjectSource, ThreeProjectionBridge } from "@bim-studio/deep-engine/three-bridge";
import type { AuthoredQualityProfile, ClusterLodSceneStaging, HdrDisplayRequest } from "@bim-studio/deep-engine/webgpu";
import type { FrameCaptureSession, RenderPacket } from "@bim-studio/deep-engine";
import { buildClusterLodAuthorStaging, clusterLodAuthorBakeFromModule } from "../delivery/buildClusterLodAuthorStaging";
import { observeRecoveryCandidate } from "./studioRecoveryCandidate";
import { studioDeepShadowAllocation, studioDeepShadowMapSize, studioDeepShadowTier } from "./studioDeepShadowAllocation";
import { prepareStudioDeepEnvironmentSource, isStudioDeepEnvironmentSourceCurrent,
  type PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";
import { readStudioDeepEnvironmentView } from "./studioDeepEnvironmentView";
import type { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import type { StudioDeepShadowSession } from "./StudioDeepShadowSession";
import type { StudioDeepPerformance } from "./StudioDeepPerformance";
import type { StudioDeformationPoseSync } from "./studioDeformationPoseSync";
import type { StudioDeepOutlineSync } from "./studioDeepOutlineSync";
import { updateAuthorProjectionState } from "./authorLodSelection";
import { nextFrame, resolveAuthorWorldTransform, threePrototypeHooks,
  type BridgeModuleLoader } from "./studioDeepWebGpuBridgeSceneHelpers";
import { markSwitchPhase, t11PipelineBootstrap, t07DynamicResolutionPolicy, b4HlodClusterEnabled, g1ClusterLodEnabled,
  t25GpuPassTimingEnabled, f4TemporalUpscaleEnabled, f3VirtualTexturesEnabled, debugFullRenderEnabled, sdfGiEnabled,
  megaLightsEnabled, rayTracedShadowsEnabled, rayTracedReflectionsEnabled, ssgiEnabled, projectedTexturesEnabled } from "./studioDeepWebGpuBridgeFeatureToggles";
import { resolveAlphaToCoverageCreateModes, packetUsesDeepAdvancedMaterials,
  sceneUsesDeepAdvancedMaterials } from "./studioDeepAdvancedMaterials";
import { createRequestedStudioFrameCaptureSession, createStudioFrameReadbackListener } from "./studioFrameCaptureDiagnostics";
import type { StudioDeepRenderView } from "./StudioDeepRenderView";
import type { ViewerEngine } from "./ViewerEngine";
import { prepareStudioRendererCandidate, type StudioRendererPreparation } from "./prepareStudioRendererCandidate";
import type { StudioDeepWebGpuBridgeOptions } from "./studioDeepWebGpuBridgeOptions";

/**
 * StudioDeepWebGpuBridge 候选切换域的内部状态视图。仅类型层映射(调用点以
 * `this as unknown as StudioDeepBridgeSwitchHost` 传入桥实例),运行时零包装、
 * 字段读写语义与桥内完全一致;switchTo 的 create/prepare 候选回调实现整体迁入本模块。
 */
export interface StudioDeepBridgeSwitchHost {
  readonly viewer: ViewerEngine;
  readonly options: StudioDeepWebGpuBridgeOptions;
  readonly loadModule: BridgeModuleLoader;
  readonly viewReader: StudioDeepRenderView;
  /** I-C21:构造期冻结的 HDR 请求快照(见桥字段注释)。 */
  readonly hdrDisplayRequest: HdrDisplayRequest | undefined;
  /** prepare catch 分支对照的当前代际(与 switchTo 捕获的 generation 比较)。 */
  readonly generation: number;
  qualityProfile: AuthoredQualityProfile | null;
  independentPacketPath: boolean;
  pendingDeformationPacket: RenderPacket | undefined;
  projectionBridge: ThreeProjectionBridge | undefined;
  advancedMaterialsRequested: boolean;
  advancedMaterialsActive: boolean;
  alphaToCoverageRequested: boolean;
  alphaToCoverageActive: boolean;
  a2cMaskFallbackRequested: boolean;
  a2cMaskFallbackActive: boolean;
  recoveryCandidateFailure: { readonly generation: number; readonly attempts: number } | undefined;
  projectionRoot(): ThreeObjectSource;
}

/**
 * 单次 switch 事务内的可变局部量:原为 switchTo 闭包里的 let 局部,create 回调
 * 写入、switchTo 尾部与 finally 读回;语义与原闭包变量一致,仅换成显式状态对象。
 */
export interface StudioDeepSwitchCandidateFrame {
  environment: PreparedStudioDeepEnvironment | undefined;
  shadowMapSize: number;
  frameCaptureSession: FrameCaptureSession | undefined;
  candidateObserver: ReturnType<typeof observeRecoveryCandidate> | undefined;
}

/**
 * switchTo 的候选事务:模块加载 → create(作者包编译/GPU 环境/后端创建)→
 * prepare(当前 view 重投影+首帧验证)。实现自 StudioDeepWebGpuBridge.switchTo
 * 原文机械迁出,语句与求值顺序逐一保留。
 */
export async function prepareStudioDeepSwitchCandidate(host: StudioDeepBridgeSwitchHost,
  canvas: HTMLCanvasElement, signal: AbortSignal, generation: number,
  replacementBudget: number | undefined, timeoutMs: number,
  frame: StudioDeepSwitchCandidateFrame): Promise<StudioRendererPreparation<DeepWebGpuBackend>> {
  return prepareStudioRendererCandidate({
    signal,
    timeoutMs,
    loadModule: async () => {
      const module = await host.loadModule();
      markSwitchPhase("deep-webgpu:module-ready");
      return module;
    },
    create: async (module, signal) => {
      signal.throwIfAborted();
      // 作者包编译与 GPU 环境准备互不依赖，重叠执行以压缩切换前段；
      // 两者都只读作者场景，顺序 await 之外的并发不引入新的写入竞争。
      const packetTask = host.options.authorRenderPacket?.(signal);
      frame.environment = await prepareStudioDeepEnvironmentSource(host.viewer.scene, signal);
      markSwitchPhase("deep-webgpu:environment-ready");
      const postProcessing = host.viewer.getPostProcessing();
      host.qualityProfile = postProcessing.qualityProfile ?? null;
      // Z1 P1：阴影分配档跟随作者质量档（引擎既有 PROFILES 表映射，零契约漂移）。
      const shadowTier = studioDeepShadowTier(host.qualityProfile);
      const shadowTierAllocation = studioDeepShadowAllocation(shadowTier);
      const authorRenderPacket = (await packetTask) ?? undefined;
      // 刀 C 首帧归因:作者包编译与 environment 并行的真实完成点(此前只有
      // environment-ready,包编译耗时长短无从归因)。
      if (authorRenderPacket) markSwitchPhase("deep-webgpu:packet-compiled");
      const pipelineBootstrap = t11PipelineBootstrap(authorRenderPacket !== undefined);
      host.independentPacketPath = authorRenderPacket !== undefined;
      host.pendingDeformationPacket = authorRenderPacket?.deformation ? authorRenderPacket : undefined;
      host.viewer.setAuthorPacketIndependent(host.independentPacketPath);
      if (!authorRenderPacket) updateAuthorProjectionState(host.viewer.scene, host.viewer.camera, signal);
      else host.viewReader.setIndependentPacketBounds(authorRenderPacket);
      // B4 簇级 HLOD(opt-in):仅独立作者包路径消费;默认关闭不改变现网行为。
      const authorHlodClusters = b4HlodClusterEnabled() && authorRenderPacket
        ? (await host.options.authorHlodClusters?.(signal)) ?? undefined : undefined;
      // G1 簇级微多边形槽位(opt-in,`g1-cluster-lod=1`):作者包合并静态几何 → bake →
      // staging 随 create 请求下发,backend 在静态包发布成功后恰注入一次渲染器槽位。
      // bake 能力经 module.DeepWebGpuBackend 公共入口透传(rayTracing 合同层一字未动);
      // 每种结果都落 performance.mark,开关关闭时零构建、零行为变化。
      let clusterLodStaging: ClusterLodSceneStaging | undefined;
      const clusterLodEnabled = g1ClusterLodEnabled();
      if (clusterLodEnabled && authorRenderPacket) {
        const outcome = buildClusterLodAuthorStaging(authorRenderPacket,
          { bake: clusterLodAuthorBakeFromModule(module) });
        if (outcome === undefined) markSwitchPhase("deep-webgpu:g1-cluster-lod-empty-scene");
        else if (!outcome.ok) markSwitchPhase(`deep-webgpu:g1-cluster-lod-blocked-${outcome.failure.reason}`);
        else { clusterLodStaging = outcome.value.staging; markSwitchPhase("deep-webgpu:g1-cluster-lod-staged"); }
      }
      // 刀 C 首帧:独立包路径 create 与 prepare 用同一 view 构造器。此前
      // create 走 threeRenderView(不携带 editorOverlay),prepare 走
      // renderViewDirect(恒收集 Deep 原生辅助图形顶点),两条路径构造的
      // view 语义不同 → prepareView 的视图复用判定永不通过,每次切换都
      // 白付一次完整首帧验证(实测 ~270ms)。同源后,视口未变时 prepare
      // 直接复用 create 已验证的帧。
      const view = authorRenderPacket ? host.viewReader.renderViewDirect(canvas)
        : host.viewReader.renderView(module, canvas);
      frame.shadowMapSize = view.lights?.directional?.[0]?.shadow?.mapSize
        ?? studioDeepShadowMapSize(host.viewer.scene, host.viewer.camera.layers.mask, shadowTierAllocation.shadowMapSize);
      frame.frameCaptureSession = createRequestedStudioFrameCaptureSession();
      // A compiled SceneSnapshot packet is a complete Deep input. Keep the
      // Three projection bridge out of this path so geometry, materials,
      // hierarchy and transforms are never read from the author scene.
      // 仅当场景含激活的 clearcoat/sheen/iridescence/transmission lobe 时才启用 advancedMaterials 着色变体(按需编译,零开销默认)。
      const advancedMaterials = host.advancedMaterialsRequested || (authorRenderPacket
        ? packetUsesDeepAdvancedMaterials(authorRenderPacket) : sceneUsesDeepAdvancedMaterials(host.viewer.scene));
      // a2c 双模式判定与合同注释见 studioDeepAdvancedMaterials.resolveAlphaToCoverageCreateModes。
      const { alphaToCoverage, a2cMaskFallback } = resolveAlphaToCoverageCreateModes({
        requested: host.alphaToCoverageRequested, authorRenderPacket,
        scene: host.viewer.scene, maskFallbackActive: host.a2cMaskFallbackRequested });
      host.projectionBridge = authorRenderPacket ? undefined : new module.ThreeProjectionBridge({ hooks: threePrototypeHooks(),
        capabilities: { authorDeformation: true, authorLod: true, ...(advancedMaterials ? { advancedMaterials: true } : {}),
          ...(alphaToCoverage ? { alphaToCoverage: true } : {}),
          ...(a2cMaskFallback ? { alphaToCoverageMaskFallback: true } : {}) },
        authorTransformResolver: source => resolveAuthorWorldTransform(host.viewer, source),
      });
      // T07 动态分辨率与 T25 逐 pass 计时均为 opt-in；缺省字段不进快照。
      const resolutionScalePolicy = t07DynamicResolutionPolicy();
      const gpuPassTiming = t25GpuPassTimingEnabled();
      // F4 超分需动态分辨率同开(scale<1 才激活);F3 虚拟纹理独立开关。
      const temporalUpscale = resolutionScalePolicy !== undefined && f4TemporalUpscaleEnabled();
      const virtualTextures = f3VirtualTexturesEnabled();
      const debugFullRender = debugFullRenderEnabled();
      const megaLights = megaLightsEnabled();
      const rayTracedShadows = rayTracedShadowsEnabled();
      const rayTracedReflections = rayTracedReflectionsEnabled();
      const backend = await module.DeepWebGpuBackend.create({
        canvas, gpu: navigator.gpu,
        ...(host.projectionBridge ? { projection: host.projectionBridge, root: host.projectionRoot() } : {}),
        view, authorChunks: true,
        ...(authorRenderPacket ? { renderPacket: authorRenderPacket } : {}),
        ...(authorHlodClusters?.length ? { hlodClusters: authorHlodClusters } : {}),
        ...(clusterLodStaging ? { clusterLodStaging } : {}),
        renderer: { environment: frame.environment.source, deformation: true, meshlets: true,
          ...(advancedMaterials ? { advancedMaterials: true } : {}),
          ...(alphaToCoverage ? { msaaSampleCount: 4 } : {}),
          // F8 自动曝光零配置默认开（Z3.5 授权）：缺省参数由引擎 DEFAULT_PBR_AUTO_EXPOSURE 提供，
          // 无可靠亮度时 fail-closed 回退固定启发式并经 FrameMetrics.autoExposure 披露。
          autoExposure: {},
          ...(clusterLodEnabled ? { clusterLod: true } : {}),
          ...(resolutionScalePolicy ? { resolutionScalePolicy } : {}),
          ...(gpuPassTiming ? { gpuPassTiming: true } : {}),
          ...(virtualTextures ? { virtualTextures: { enabled: true } } : {}),
          ...(host.options.recovery && replacementBudget !== 0 ? { recovery: {
            ...host.options.recovery, ...(replacementBudget === undefined ? {} : { maxAttempts: replacementBudget }),
          } } : {}),
          ...(host.hdrDisplayRequest === undefined ? {} : { hdrDisplay: host.hdrDisplayRequest }),
          ...(pipelineBootstrap ? { pipelines: pipelineBootstrap } : {}),
          adaptiveQuality: {
            enabled: true,
            collectHotspots: false,
            ...(postProcessing.qualityProfile ? { profile: postProcessing.qualityProfile } : {}),
          },
          // Z1 P1：级联数受引擎硬合同约束——view 携带 authored shadow 时分配必须
          // 为 1 层且 mapSize 精确匹配（cascadedShadowResources.prepare 的 authored
          // 约束），且 StudioDeepShadowSession 会把分配收敛回作者值；带作者阴影的
          // 场景升多级联属引擎侧能力（主线事项，见 docs/reports）。当前档位词汇
          //（studioDeepShadowTier）驱动无作者阴影时的兜底分配尺寸。
          shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: frame.shadowMapSize } },
          // features 只此一处：此前 F4 的条件 spread 与本字面量同名，后写覆盖前写，
          // temporalUpscale 从未真正进入渲染器；合并后 opt-in 才真正生效。
          // sdf-gi=1（Brief-GI M2/M3，opt-in 默认关）：开启后引擎构建 SDF GI 运行时，
          // 按包场景 revision 变化自动烘焙；关闭时不带该字段，帧逐位零变化。
          features: { ...(temporalUpscale ? { temporalUpscale: true } : {}),
            ...(debugFullRender ? { debugForceFullRender: true } : {}),
            ...(megaLights ? { megaLights: true } : {}),
            ...(rayTracedShadows ? { rayTracedShadows: true } : {}),
            // B3 RT 反射 closest-hit 帧通道（`ray-traced-reflections=1`，opt-in 默认关）：
            // 关闭 = 通道零 dispatch、SSR 屏外填充不发生，帧逐位零变化；场景未
            // staging/管线构造失败时引擎 fail-closed 降级并经 FrameMetrics.rtReflections
            // 如实披露（00871f4c 生产帧挂载，本行为 URL 开关→features 的接线）。
            ...(rayTracedReflections ? { rayTracedReflections: true } : {}),
            ...(sdfGiEnabled() ? { sdfGi: true } : {}),
            // P2 SSGI:opt-in 默认不带该字段(帧逐位零变化);与 sdf-gi 叠加合法。
            ...(ssgiEnabled() ? { ssgi: true } : {}),
            // P2 投影纹理光(three r186 ProjectorLight gobo 纹理半部):opt-in 默认不带;
            // 开启且场景未供给投影器时同样零 dispatch(帧逐位零变化)。
            ...(projectedTexturesEnabled() ? { projectedTextures: true } : {}),
            environment: true, groundPlane: false,
            groundGrid: false, screenSpaceReflection: true, volumetricFog: true,
            toneMapping: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator },
          ...(frame.frameCaptureSession ? { frameCapture: { session: frame.frameCaptureSession,
            readbacks: { requests: [{ resourceId: "present-color" as const }, { resourceId: "linear-depth" as const }] },
            onReadbackResults: createStudioFrameReadbackListener() } } : {}) },
        cameraLayerMask: host.viewer.camera.layers.mask, signal,
      });
      markSwitchPhase("deep-webgpu:scene-uploaded");
      host.advancedMaterialsActive = advancedMaterials;
      host.alphaToCoverageActive = alphaToCoverage;
      host.a2cMaskFallbackActive = a2cMaskFallback;
      if (replacementBudget !== undefined && !signal.aborted) frame.candidateObserver = observeRecoveryCandidate(backend, signal);
      return backend;
    },
    prepare: async (backend, signal) => {
      try {
        await nextFrame(signal);
        if (!host.independentPacketPath) updateAuthorProjectionState(host.viewer.scene, host.viewer.camera, signal);
        // create 期间作者仍可编辑；重新投影并验证当前相机，而非发布创建时的快照。
        // 这不是 revision 锁：验证期间的连续动画仍由发布后的作者帧订阅追平。
        const latestView = host.viewReader.renderViewDirect(canvas);
        if (typeof backend.prepareView === "function") await backend.prepareView(latestView, signal);
        else await backend.prepareScene(host.projectionRoot(), latestView, host.viewer.camera.layers.mask, signal);
        readStudioDeepEnvironmentView(host.viewer.scene, host.viewer.usesAuthorPostProcessing());
        const environment = frame.environment;
        if (!environment || !isStudioDeepEnvironmentSourceCurrent(host.viewer.scene, environment)) {
          throw new Error("作者环境在候选准备期间已改变。");
        }
        markSwitchPhase("deep-webgpu:frame-validated");
      } catch (error) {
        const attempts = await frame.candidateObserver?.retryAfter(error);
        if (attempts !== undefined && !signal.aborted && generation === host.generation) {
          host.recoveryCandidateFailure = { generation, attempts };
        }
        throw error;
      } finally { frame.candidateObserver?.dispose(); }
    },
    dispose: (backend) => backend.dispose(),
    removeCanvas: () => canvas.remove(),
  });
}
