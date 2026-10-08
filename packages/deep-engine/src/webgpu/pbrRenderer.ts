import { DeviceSession } from "./deviceSession.js";
import { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";
import { uploadBuffer } from "./meshBuffers.js";
import { renderPreparedFrame, validateFrame, type PbrRendererFrameHost } from "./pbrRendererFrames.js";
import { authoredShadowPipelines, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { openPbrRenderer } from "./pbrRendererBootstrap.js";
import { snapshotPipelineCompileRecords } from "./pipelineCompileSnapshot.js";
import { validatePbrFrame } from "./validatePbrFrame.js";
import { RenderTargets } from "./renderTargets.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { PacketBuffers } from "./packetBuffers.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { pickScene, pickingUnavailable, type PickOptions, type PickResult } from "./picking.js";
import { spherePacket } from "./spherePacket.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import { PbrTransparencyPass } from "./pbrTransparencyPass.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import { pbrVisibilityInput } from "./pbrVisibilityInput.js";
import { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import { transformWorldLightsToView } from "../lighting/worldLights.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { scalePbrEnvironmentRadiance } from "./pbrEnvironmentIntensity.js";
import { PreviousHiZVisibility, type PreviousHiZFramePlan } from "./previousHiZVisibility.js";
import { PbrShadowState } from "./pbrShadowState.js";
import { RtShadowFrameController } from "./rtShadowFrame.js";
import type { TlasPackedScene } from "../rayTracing/tlasLayout.js";
import { VirtualShadowResources } from "./virtualShadowResources.js";
import { VirtualShadowPageTable, VIRTUAL_SHADOW_PHYSICAL_PAGES } from "../shadows/virtualShadowPages.js";
import { ContactShadowResources, describeContactShadowPass, describeContactApplyPass } from "../shadows/contactShadowResources.js";
import { SdfGiProductionRuntime } from "../gi/sdfGiProductionRuntime.js";
import { hasClusteredLights, resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import { resolveDeepGiProducerDirectionCount } from "../lighting/probeRadianceDirectionGate.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
import { abortableGpu } from "./gpuAbort.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPbrEnvironment, type PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import { PbrEnvironmentState, type EnvironmentStageResult } from "./pbrEnvironmentState.js";
import { PbrMainBindings } from "./pbrMainBindings.js";
import { PbrLodWork } from "./pbrLodWork.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { PbrOutputBindings, type PbrPresentReceipt } from "./pbrOutputBindings.js";
import { PbrRendererDiagnostics } from "./pbrRendererDiagnostics.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { currentRendererRebuildOrdinal, recordRendererRebuild, rendererRebuildFrameMetrics } from "./pbrRendererRebuildAccounting.js";
import { beginPbrOpaquePass } from "./pbrOpaquePass.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { createPbrGround, drawPbrGround, type PbrGroundResources } from "./pbrGroundPass.js";
import { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import type { PbrTransientTextureHandle } from "./pbrTransientTextureTypes.js";
import type { SurfaceSize } from "./surfaceSize.js";
import { DynamicResolutionScaler, internalResolutionReport,
  DEFAULT_RESOLUTION_SCALE_POLICY, type ResolutionScalePolicy } from "../postprocess/resolutionScaler.js";
import { internalRenderSize, temporalUpscaleActive } from "../postprocess/temporalUpscaleCpu.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual,
  createPbrFrameReceipt, pbrFramePassTimingsUnavailable } from "./pbrFramePlanExecutor.js";
import type { PbrFramePassTimings, PbrReceiptTimingAvailability } from "./pbrFrameReceipt.js";
import { computePbrFrameExecutionCoverage } from "./pbrFrameExecutionCoverage.js";
import { PbrFrameCapture } from "./pbrFrameCapture.js";
import type { PbrFrameReadbackResult } from "./pbrFrameCaptureReadback.js";
import type { FrameCaptureSession } from "../r12/frameCapture.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import { pbrGodRaysFrame } from "./pbrGodRaysFrame.js";
import { encodeRenderGraphEncoderGroup } from "./renderGraphEncoderExecutor.js";
import type { RenderGraphCompileResult } from "../renderGraph.js";
import { AdaptiveQualityController, adaptiveShadowMapSize } from "./adaptiveQuality.js";
import type { CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import { ProbeClipmapPbrController, type ProbeClipmapPbrTarget } from "./probeClipmapPbrController.js";
import { ProbeSceneRadianceProducer } from "../rayTracing/probeSceneRadianceProducer.js";
import { EnvironmentAmbientReader, type EnvironmentAmbient } from "./environmentAmbientReader.js";
import { PbrParticlePass } from "./pbrParticlePass.js";
import { GaussianSplatSceneOwner, type SplatStageResult } from "./gaussianSplatSceneOwner.js";
import type { SplatCloud } from "../gaussianSplat/decodeSplatPly.js";
import { pbrSplatFrame } from "./pbrSplatFrame.js";
import { createGpuParticleRuntimeFromEmitters, submitGpuParticleEmitterFrame } from "./gpuParticleEmitters.js";
import type { GpuParticleRuntime } from "./gpuParticleRuntime.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT, resolvePbrMsaaSampleCount } from "./renderTargets.js";
import { PbrDepthResolvePass } from "./pbrDepthResolve.js";
import { A2cFrameProbe } from "./a2cFrameProbe.js";
import { VisibilityBufferPath } from "./visibilityBufferPass.js";
import { SoftRasterizeFallback } from "./softRasterizeFallback.js";
import { ClusterLodRenderSlot, type ClusterLodSceneStaging } from "./clusterLodRenderSlot.js";
import { resolveClusterLodSlotOption } from "./clusterLodSlotSupport.js";
import { PbrAutoExposureRuntime } from "./pbrAutoExposure.js";
import { createVirtualTextureFrameBridge, virtualTextureUvBounds, type VirtualTextureFrameBridge,
  type VirtualTextureFeedbackEntry, type VirtualTextureFrameMetrics } from "./virtualTextureFrameBridge.js";
import { VirtualTextureTileLookupPass } from "./virtualTextureSampling.js";
import type { CachedPacketGeometry } from "./packetBufferTypes.js";
export type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
export class PbrRenderer {
  readonly id = "deep-webgpu";
  private readonly diagnostics: PbrRendererDiagnostics; get gpuTimer() { return this.diagnostics.gpuTimer; }
  get performanceTelemetry() { return this.diagnostics.performance; } get transientTextureStats() { return this.targets.transientStats; }
  /** 宿主停止提交并等待 queue 完成后，可回收 free 目标再判断停放预算。 */
  releaseIdleResources(): number { return this.transientTextures.releaseIdleResources(); }
  /** 设备侧未捕获错误镜像(session.events 的只读视图;探针/面板诊断用)。 */
  get deviceDiagnostics() { return this.session.diagnostics; }
  get materialBindingStats() { return this.packets.materialBindingStats; }
  preparedPacketFor(packet: RenderPacket) { return this.packets.preparedPacketFor(packet); }
  /** C26: immutable device compile ledger, copied only when requested. */
  getPipelineCompileRecords() { return snapshotPipelineCompileRecords(this.session.device); }
  private readonly packets: PacketBuffers; private readonly ground: PbrGroundResources;
  private readonly frameBuffer: GPUBuffer;
  private readonly mainBindings: PbrMainBindings;
  private readonly environment: PbrEnvironmentState;
  private readonly shadowState: PbrShadowState; private get shadows() { return this.shadowState.current; }
  /** B1 Brief-VSM 主阴影档与虚拟阴影资源(缺省/失败 = undefined,fail-closed 回级联)。 */
  readonly shadowMode: "virtual" | "cascaded";
  readonly virtualShadows: import("./virtualShadowResources.js").VirtualShadowResources | undefined;
  readonly virtualShadowFallbackReason: string | undefined;
  /** C10 屏幕空间接触阴影;opt-in(features.contactShadows),默认不存在。 */
  private readonly contactShadows: ContactShadowResources | undefined;
  private adaptiveContactShadowTier: "performance" | "balanced" | "quality" | undefined;
  /** Brief-GI M2 生产 SDF GI dispatch;opt-in(features.sdfGi),默认不存在(帧逐位零变化)。 */
  readonly sdfGi: SdfGiProductionRuntime | undefined;
  private readonly targets: RenderTargets; private readonly transientTextures: PbrTransientTexturePool;
  private readonly postProcess: PbrPostProcessChain;
  private readonly transparency: PbrTransparencyPass; private readonly lighting: ForwardPlusPbrRuntime;
  private readonly localShadows: LocalSpotShadowRuntime;
  private readonly cameraHistory = new CameraFrameHistory();
  private readonly previousHiZ = new PreviousHiZVisibility();
  private pendingHiZ: PreviousHiZFramePlan | undefined; private readonly outputs: PbrOutputBindings;
  private features: PbrRendererFeatures; private frame = 0;
  /** M2 方向光 RT 阴影控制器(opt-in features.rayTracedShadows):mask 纹理生命周期
   *  +ShadowRayFramePass 供给。构造期场景供给未就绪或 staging 降级时 features 快照的
   *  RT 位回退(开关位 0 → WGSL 回级联),后置 stage 成功再切回(下一帧生效)。 */
  readonly rtShadows: RtShadowFrameController | undefined;
  /** B3 RT 阴影自动选路状态(滞回冷却计数;与 rtShadows 同生命周期,未接选路为 undefined)。 */
  readonly rtShadowScheduling: import("./rtShadowScheduling.js").RtShadowSchedulingState | undefined;
  /** M2 供给收口(2026-10-06):已接入 shadowState 的 mask 视图 epoch;帧钩子按
   *  rtShadows.maskViewEpoch 差分换装(仅 resize/staging 时重建 group(2) bind group)。 */
  rtShadowMaskEpoch = 0;
  private rtShadowsFallbackReason: string | undefined;
  private readonly frameCapture: PbrFrameCapture | undefined;
  private lastFrameReadback: Promise<readonly PbrFrameReadbackResult[]> | undefined;
  get frameReadbackResults(): Promise<readonly PbrFrameReadbackResult[]> | undefined { return this.lastFrameReadback; }
  private lastAuthorShadowSize: number | undefined;
  private readonly optionsExactShadowCascade: number | undefined;
  private readonly probeDirectionsOverride: PbrRendererOptions["probeDirections"];
  private adaptiveShadowTier: CascadedShadowQualityTier | undefined;
  private adaptiveShadowSize: number | undefined;
  private adaptiveShadowStage: AbortController | undefined;
  private readonly probeClipmap: ProbeClipmapPbrController | undefined;
  private probeClipmapBusy = false;
  private readonly probeClipmapAbort = new AbortController();
  private probeClipmapFailed = false;
  /** Owns the real scene-radiance capture chain (F1) for the product probe-clipmap session. */
  private probeRadianceProducer: ProbeSceneRadianceProducer | undefined;
  /** Latest committed environment average (GPU readback); feeds the probe ambient term. */
  private environmentAmbient: EnvironmentAmbient = Object.freeze([0, 0, 0]);
  private ambientReader: EnvironmentAmbientReader | undefined;
  private ambientEnvironment: StudioEnvironment | undefined;
  /** Optional GPU particle simulation; committed binding is consumed one frame later. */
  private readonly particleRuntime: GpuParticleRuntime | undefined;
  private readonly particlePass: PbrParticlePass | undefined;
  private splats: GaussianSplatSceneOwner | undefined;
  private particleBusy = false;
  private particleLastTime = performance.now();
  private readonly visibility: VisibilityBufferPath | undefined;
  private readonly adaptiveQuality: AdaptiveQualityController | undefined;
  /** AA-M1:主 pass 生效采样数与遥测快照(能力探针结果);帧宿主接口与 FrameMetrics 消费。 */
  readonly mainSampleCount: 1 | 4;
  readonly msaaMetrics: import("./pbrRendererTypes.js").FrameMetrics["msaa"];
  /** A2C-P1 运行时 a2c 有效性探针(一次性;MSAA4 渲染器才持有,见构造注释)。 */
  readonly a2cProbe: import("./a2cFrameProbe.js").A2cFrameProbe | undefined;
  readonly depthResolve: import("./pbrDepthResolve.js").PbrDepthResolvePass | undefined;
  /** G1-S1 簇级微多边形绘制槽位；仅 options.clusterLod === true 时可经 stageClusterLodScene 注入。 */
  private readonly clusterLodEnabled: boolean;
  private clusterLodSlot: ClusterLodRenderSlot | undefined;
  private readonly preparationPlan: RenderGraphCompileResult;
  private readonly preparationGroupIndex: number;
  private allocationPlanKey: string | undefined;
  private allocationPlan: RenderGraphCompileResult | undefined;
  private capturePlanKey: string | undefined;
  private capturePlan: ReturnType<typeof buildPbrFrameExecutionPlan> | undefined;
  private captureActualPasses: ReturnType<typeof collectActualPbrFramePasses> | undefined;
  private readonly writeGeometryBuffers: boolean;
  private readonly resolutionScaler: DynamicResolutionScaler | undefined;
  private resolutionScale = 1;
  private resolutionScaleRevision = 0;
  private shadowDirty = true; private historyDirty = true;
  private previousAmbientOcclusion: boolean | undefined;
  private previousTemporalLights: RenderView["lights"];
  private temporalLightRevision = 0;
  private readonly frameData = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
  /** F8 自动曝光(opt-in):缺省 undefined = 固定启发式 view.exposure 原样生效。 */
  private readonly autoExposure: PbrAutoExposureRuntime | undefined;
  /** F4 虚拟纹理采样接线(opt-in):缺省 undefined = 整纹理驻留权威路径零行为变化。 */
  private readonly virtualTextures: VirtualTextureFrameBridge | undefined;
  private readonly virtualTileLookup: VirtualTextureTileLookupPass | undefined;
  /** DeviceSession recovery requires replacement of this complete GPU graph. */
  private readonly deviceEpoch: RendererDeviceEpoch;
  /** A2-刀1:dispose 时显式断开的编译管线图与 release 门引用(证据链见构造器首注)。 */
  private pipelines: Pipelines | undefined;
  private releasePipelines: (() => void) | undefined;
  private readonly deformationNeedsEarlyRelease: boolean;
  /** A2-刀2:重建周期账目 —— 本实例序号(构造期领取)与已披露的台账总数。 */
  private readonly rebuildOrdinal = currentRendererRebuildOrdinal();
  private publishedRebuildTotal = -1;
  /** 上一已提交渲染帧的相机切换;自动曝光在其后一帧直取目标(剪除瞬态)。 */
  private previousFrameCameraCut = false;
  private constructor(readonly session: DeviceSession, pipelines: Pipelines, environment: StudioEnvironment,
    lighting: ForwardPlusPbrRuntime, localShadows: LocalSpotShadowRuntime, options: PbrRendererOptions, features: PbrRendererFeatures,
    deformationPipelines?: Pipelines | Promise<Pipelines> | (() => Promise<Pipelines>), releasePipelines?: () => void,
    msaa: import("./pbrMsaaCapability.js").PbrMsaaCapability = { sampleCount: 1 }) {
    // A2-刀1:两字段声明为可空并在 dispose 显式断开 —— 它们是整张编译管线图
    // (WGSL 源+管线对象+bind group 布局,soak 语境 3104 管线事件)仅有的实例级强引用;
    // releasePipelines 只开 deferred 编译队列门(PbrPipelineSet.release=releaseDeferredQueues),
    // 不释放图本身。帧宿主经 `as unknown as` 转型,dispose 后帧路径本就非法,提前在此失败。
    this.pipelines = pipelines;
    this.releasePipelines = releasePipelines;
    this.deformationNeedsEarlyRelease = options.pipelines?.firstFrameMainKeys === undefined;
    // Initial TLAS staging uses the same public path as later updates.
    // Publish the feature snapshot before that path reads its RT flag.
    this.features = features;
    this.deviceEpoch = new RendererDeviceEpoch(session.device);
    this.diagnostics = new PbrRendererDiagnostics(session);
    this.clusterLodEnabled = resolveClusterLodSlotOption(options.clusterLod);
    // F4 虚拟纹理(opt-in):resolve disabled(未启用/非法配置)时不构造任何资源,
    // 与整纹理路径零差异;enabled 时驻留失败 fail-closed 回整纹理(原因随遥测披露)。
    this.virtualTextures = createVirtualTextureFrameBridge(session,
      options.virtualTextures === undefined ? undefined : { ...options.virtualTextures, frameClock: () => performance.now() });
    this.virtualTileLookup = this.virtualTextures ? new VirtualTextureTileLookupPass(session) : undefined;
    this.autoExposure = options.autoExposure === undefined ? undefined
      : new PbrAutoExposureRuntime(options.autoExposure, options.environment);
    this.adaptiveQuality = options.adaptiveQuality ? new AdaptiveQualityController(options.adaptiveQuality) : undefined;
    if (options.adaptiveQuality?.enabled) this.diagnostics.setEnabled(true);
    // F1 逐 pass GPU 计时(opt-in):开启即连带启用诊断采样;设备不支持/槽忙时
    // beginPasses 返回 undefined,帧内自动回退帧级三段计时,见 renderPreparedFrame。
    if (options.gpuPassTiming) {
      this.diagnostics.setEnabled(true);
      this.diagnostics.gpuTimer.passTimingEnabled = true;
    }
    if (options.particleEmitters?.length) {
      const setup = createGpuParticleRuntimeFromEmitters(session,
        `pbr-particles-${probeClipmapDeviceEpoch(session.device)}`, options.particleEmitters,
        options.particleRuntime);
      this.particleRuntime = setup.runtime;
      this.particlePass = new PbrParticlePass(session, PBR_HDR_FORMAT, PBR_DEPTH_FORMAT,
        features.temporalAa ? "r8unorm" : undefined);
    } else {
      this.particleRuntime = undefined;
      this.particlePass = undefined;
    }
    this.probeClipmap = options.probeClipmap === undefined ? undefined
      : new ProbeClipmapPbrController(this, probeClipmapDeviceEpoch(session.device), options.probeClipmap);
    const fallback = pipelines.textureArrayFallback;
    // 变形变体可以是就绪实例，也可以是延迟就绪的 promise：PacketBuffers 在含变形的
    // packet 边界等待并附着。
    this.packets = new PacketBuffers(session, (fallback ?? pipelines).materialLayout,
      deformationPipelines, options.meshlets === true, features.visibilityBuffer,
      fallback ? pipelines.materialLayout.material : undefined, options.vertexStreamingGeometry, pipelines);
    if (this.clusterLodEnabled) this.packets.stageClusterLodProduction();
    this.writeGeometryBuffers = features.ambientOcclusion || features.screenSpaceReflection || features.volumetricFog || features.temporalAa || features.contactShadows
      || deformationPipelines !== undefined;
    this.ground = createPbrGround(session);
    this.frameBuffer = uploadBuffer(session, "Deep frame", this.frameData, GPUBufferUsage.UNIFORM);
    this.outputs = new PbrOutputBindings(session, pipelines, () => performance.now(), features.spatialAa, session.hdrDisplayCapability?.policy);
    // M2 方向光 RT 阴影(opt-in):RT 管线变体下 group(2) binding(3) 必须装配;控制器
    // 先建(占位 1×1 mask),场景供给未就绪/staging 降级 → features 快照 RT 位清 0
    // (fail-closed 回级联,原因经 rayTracedShadowStatus 披露,不静默假开)。
    if (features.rayTracedShadows) {
      this.rtShadows = new RtShadowFrameController(session, { ...(options.rayTracedShadowF16 ? { f16: true } : {}) });
      // B3 自动选路状态(帧粒度混合调度;帧钩子逐帧 resolve+tick)。
      this.rtShadowScheduling = { cascadeCooldownFrames: 0 };
      if (options.rayTracedShadowScene !== undefined) this.stageRayTracedShadowScene(options.rayTracedShadowScene);
      else this.rtShadowsFallbackReason = "scene-not-supplied";
    }
    // RT 管线变体的 group(2) binding(3) 槽恒装配:未 staging 时供占位 1×1 mask
    // (值 1.0 = 可见,fail-closed 方向;features 快照 RT 位未就绪时已压 0,级联生效)。
    // 2026-10-06 供给收口:场景允许"先建后 stage"——构造期 sceneStaged=false 曾与
    // 管线变体失配直接抛错(渲染器整体起不来);真实 mask 视图由 stageRayTracedShadowScene
    // 与帧钩子按 maskViewEpoch 换装进 shadowState。
    const rtShadowMaskView = this.rtShadows !== undefined ? this.rtShadows.maskView : undefined;
    this.shadowState = new PbrShadowState(session, pipelines, options.shadows, rtShadowMaskView);
    this.optionsExactShadowCascade = options.shadows?.exactProfile?.cascadeCount;
    // B1 Brief-VSM:虚拟档资源(opt-in shadowMode="virtual";构造失败 fail-closed 回
    // 级联档,原因随遥测披露 —— 不静默,不阻塞渲染循环)。
    this.shadowMode = options.shadowMode === "virtual" ? "virtual" : "cascaded";
    if (this.shadowMode === "virtual") {
      try {
        this.virtualShadows = new VirtualShadowResources(session, pipelines,
          new VirtualShadowPageTable(VIRTUAL_SHADOW_PHYSICAL_PAGES, options.virtualShadow?.perPageCostMs),
          options.virtualShadow ?? {});
      } catch (error) {
        this.virtualShadows = undefined;
        this.virtualShadowFallbackReason = error instanceof Error ? error.message : String(error);
      }
    } else {
      this.virtualShadows = undefined;
      this.virtualShadowFallbackReason = undefined;
    }
    this.mainSampleCount = msaa.sampleCount;
    this.msaaMetrics = Object.freeze({ requested: resolvePbrMsaaSampleCount(options.msaaSampleCount),
      active: msaa.sampleCount, ...(msaa.fallbackReason ? { fallbackReason: msaa.fallbackReason } : {}) });
    // A2C-P1 运行时有效性探针(一次性):仅 MSAA≥4 渲染器持有(a2c 管线变体只在多采样
    // 档存在,1x 渲染器物理上画不出 a2c 批次)。空闲控制器零开销;首个含 a2c 批次的帧
    // 编码一次 opaque-hdr 读回并经 FrameMetrics.a2cProbe 披露(只披露不决策)。
    this.a2cProbe = msaa.sampleCount === 4 ? new A2cFrameProbe() : undefined;
    // AA-M1:深度 resolve pass 仅 MSAA 渲染器持有(管线 + 按帧源视图的 bind group 缓存)。
    this.depthResolve = msaa.sampleCount > 1 ? new PbrDepthResolvePass(session) : undefined;
    this.probeDirectionsOverride = options.probeDirections;
    this.lastAuthorShadowSize = options.shadows?.exactProfile?.shadowMapSize;
    this.contactShadows = features.contactShadows ? new ContactShadowResources(session, options.contactShadows ?? {}) : undefined;
    this.sdfGi = features.sdfGi ? new SdfGiProductionRuntime(session, options.sdfGi ?? {}) : undefined;
    this.environment = new PbrEnvironmentState(environment);
    this.mainBindings = new PbrMainBindings(session, pipelines, this.frameBuffer, this.shadows, environment);
    this.transientTextures = new PbrTransientTexturePool(session, options.transientTextureBudgetBytes);
    this.targets = new RenderTargets(session, pipelines.output.getBindGroupLayout(0), this.outputs.buffer,
      this.transientTextures, msaa.sampleCount);
    // M2 方向光 RT 阴影 fail-closed:场景供给未就绪/staging 降级时 features 快照的 RT 位
    // 清 0(开关位 0 → WGSL 分支不进;管线保持 RT 变体,占位 mask 值 1.0 无黑影)。
    this.features = this.rtShadows === undefined || this.rtShadows.sceneStaged ? features
      : Object.freeze({ ...features, rayTracedShadows: false });
    if (this.features.rayTracedShadows === false && this.rtShadows !== undefined) {
      this.rtShadowsFallbackReason ??= this.rtShadows.disabled?.reason ?? "scene-not-staged";
    }
    this.resolutionScaler = options.resolutionScalePolicy === undefined ? undefined
      : new DynamicResolutionScaler(options.resolutionScalePolicy);
    // P0-2 可见性切片（opt-in）：共享 frame uniform 与 transient 池；默认 features.visibilityBuffer=false 时不构建。
    this.visibility = features.visibilityBuffer ? new VisibilityBufferPath(session, this.transientTextures, this.frameBuffer,
      features.softRasterizeFallback ? new SoftRasterizeFallback(session) : undefined) : undefined;
    if (this.visibility) void this.visibility.ensure();
    this.preparationPlan = compilePbrFrameGraph({ transparency: true, features,
      writeGeometryBuffers: this.writeGeometryBuffers });
    this.preparationGroupIndex = this.preparationPlan.parallelGroups?.findIndex(group =>
      group.length === 2 && group.includes("deform") && group.includes("cluster-lights")) ?? -1;
    this.frameCapture = options.frameCapture === undefined ? undefined : new PbrFrameCapture({ ...options.frameCapture,
      now: options.frameCapture.now ?? (() => performance.now()) }, { builtinRenderer: true });
    this.postProcess = new PbrPostProcessChain(session, this.features, this.transientTextures);
    this.transparency = new PbrTransparencyPass(session, this.transientTextures, features.temporalAa);
    this.lighting = lighting; this.localShadows = localShadows;
  }
  /**
   * M2 方向光 RT 阴影:注入/更新 TLAS 打包场景(features.rayTracedShadows 构造档;
   * BLAS 段计数不变走增量 TLAS,变化整体重建 pass)。构造期未供给而此处后置供给成功时,
   * features 快照的 RT 位切回 true —— 下一帧起 WGSL 开关位=1、直出快路径按 RT 档禁用;
   * 本帧已在途的编码仍按位 0(级联)执行,一帧收敛,如实披露。staging 失败降级并在
   * rayTracedShadowStatus 披露原因,不抛穿渲染循环。
   */
  stageRayTracedShadowScene(packed: TlasPackedScene): void {
    const controller = this.rtShadows;
    if (controller === undefined) throw new Error("Ray-traced shadows require features.rayTracedShadows.");
    controller.stageScene(packed);
    if (controller.sceneStaged) {
      this.rtShadowsFallbackReason = undefined;
      if (!this.features.rayTracedShadows) {
        this.features = Object.freeze({ ...this.features, rayTracedShadows: true });
      }
      // 供给收口(2026-10-06):真实 mask 视图换装进 group(2)(构造期经占位视图装配;
      // 后置 staging 在此接入)。构造期直供场景的路径 shadowState 尚未构造,由构造器
      // 尾部的 PbrShadowState 初建按当前 maskView 装配,不在此重复。
      const shadowState = this.shadowState as PbrShadowState | undefined;
      if (shadowState !== undefined && this.pipelines?.rayTracedShadowMaskBinding === true) {
        shadowState.setRayTracedShadowMaskView(controller.maskView);
        this.rtShadowMaskEpoch = controller.maskViewEpoch;
      }
    } else {
      this.rtShadowsFallbackReason = controller.disabled?.reason ?? "scene-not-staged";
    }
  }
  /** M2 RT 阴影诊断:构造档 disabled=true 时给出回退原因(级联档生效),否则 active。 */
  get rayTracedShadowStatus(): { active: boolean; reason?: string } {
    if (this.rtShadows === undefined) return { active: false };
    if (this.rtShadowsFallbackReason !== undefined) return { active: false, reason: this.rtShadowsFallbackReason };
    return this.features.rayTracedShadows ? { active: true } : { active: false, reason: "features-fallback" };
  }
  get frameCaptureSession(): FrameCaptureSession | undefined { return this.frameCapture?.session; }
  get hdrDisplay() {
    const capability = this.session.hdrDisplayCapability;
    if (!capability) return undefined;
    const runtime = this.outputs.hdrDisplay;
    return Object.freeze({ ...capability, state: runtime?.state ?? "fallback",
      policy: runtime?.fallbackReason ? Object.freeze({ ...capability.policy, mode: "sdr" as const, strategy: "aces-sdr" as const,
        reason: runtime.fallbackReason, failClosed: true }) : capability.policy,
      canvasFormat: this.session.format, ...(runtime?.fallbackReason ? { fallbackReason: runtime.fallbackReason } : {}) });
  }
  /** DC rendering status explicitly reports stored higher-order SH without claiming view-dependent evaluation. */
  get splatRenderStatus() { return this.splats?.current; }
  stageSplatCloud(cloud: SplatCloud, signal?: AbortSignal): Promise<SplatStageResult> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    this.splats ??= new GaussianSplatSceneOwner(this.session, PBR_HDR_FORMAT, PBR_DEPTH_FORMAT, this.features.temporalAa);
    return this.splats.stage(cloud, signal).then(result => { if (result === "staged") this.historyDirty = true; return result; });
  }
  clearSplatCloud(): void {
    this.deviceEpoch?.assertCurrent(this.session.device); this.splats?.clear(); this.historyDirty = true;
  }
  /** 首帧验证通过后由宿主调用：放行背景 main 变体排队，避免与首帧争抢设备。 */
  releaseBackgroundPipelines(): void { this.releasePipelines?.(); this.scheduleOutlinePrewarm(); }
  /** 就绪后的空闲时刻预编译描边管线(无描边场景也只付一次后台编译,换取首次出现描边零卡顿)。 */
  private scheduleOutlinePrewarm(): void {
    if (this.outlinePrewarmScheduled) return;
    this.outlinePrewarmScheduled = true;
    const run = () => { this.outlinePrewarmHandle = undefined; if (this.session.state === "ready") void this.postProcess.prewarmInstanceOutline(); };
    const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    this.outlinePrewarmHandle = typeof idle === "function"
      ? { kind: "idle", id: idle.call(globalThis, run, { timeout: 2000 }) }
      : { kind: "timeout", id: setTimeout(run, 250) as unknown as number };
  }
  private cancelOutlinePrewarm(): void {
    const handle = this.outlinePrewarmHandle; this.outlinePrewarmHandle = undefined;
    if (!handle) return;
    if (handle.kind === "idle") (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(handle.id);
    else clearTimeout(handle.id);
  }
  static async create(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, options: PbrRendererOptions = {}): Promise<PbrRenderer> {
    if (typeof performance !== "undefined") performance.mark("deep-webgpu:device-open-start");
    const session = await DeviceSession.open(canvas, gpu, signal, options.deviceMemoryBudgetBytes, options.recovery,
      options.features?.layeredMaterials === true || options.hdrDisplay !== undefined || options.advancedMaterials === true ? {
        ...(options.advancedMaterials === true ? { advancedMaterials: true,
          rayTracedShadows: options.features?.rayTracedShadows === true, virtualShadowPages: options.shadowMode === "virtual" } : {}),
        ...(options.features?.layeredMaterials === true ? { layeredMaterials: true } : {}),
        ...(options.hdrDisplay === undefined ? {} : { hdrDisplay: options.hdrDisplay }),
        // B1 Brief-VSM:group 2 布局对全部档位统一增补页表/页 atlas 绑定(级联档占位),
        // 片元峰值 10 storage / 17 sampled 超出 WebGPU 基线 8/16 —— 与 layered 材质
        // (19 sampled)同先例按需抬高上限,DeviceSession 侧 clamp 到 adapter 能力。
        extendedShadowBindings: true,
      } : {
        extendedShadowBindings: true,
      });
    const deviceEpoch = new RendererDeviceEpoch(session.device);
    if (typeof performance !== "undefined") performance.mark("deep-webgpu:device-opened");
    const renderer = await openPbrRenderer(session, signal, options, () => new DOMException("GPU preparation cancelled", "AbortError"),
      (...args) => { deviceEpoch.assertCurrent(session.device); return new PbrRenderer(...args); });
    try {
      if (renderer.outputs.ready) await abortableGpu(renderer.outputs.ready, signal, "HDR display preparation cancelled.");
      deviceEpoch.assertCurrent(session.device);
      if (signal.aborted) throw new DOMException("GPU preparation cancelled", "AbortError");
      renderer.scheduleOutlinePrewarm();
      return renderer;
    } catch (error) { renderer.dispose(); throw error; }
  }
  setInstances(data: Float32Array<ArrayBuffer>): void { this.setPacket(spherePacket(data)); }
  setPacket(packet: RenderPacket): void {
    this.deviceEpoch?.assertCurrent(this.session.device);
    if (this.packets.set(packet)) { this.sceneChanged(); this.syncProbeClipmapSurfaces(packet);
      if (this.clusterLodEnabled) this.packets.stageClusterLodProduction(); }
    // F4 虚拟纹理目录全量同步:opt-in 才有 bridge;包内 RGBA8 纹理按需分页,压缩纹理
    // 显式不入目录(反馈侧 droppedUnknownTexture 计数,采样方整纹理路径不受影响)。
    this.virtualTextures?.syncTextures(packet.textures ?? []);
  }
  async setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    // 旧 SDK 全量变形集合仍需提前放行；子集模式按实际 packet 启动关键变体，
    // 保留背景管线门直到真实首帧验证完成，避免无用编译抢占初始化。
    if (this.deformationNeedsEarlyRelease && (packet.deformation !== undefined || packet.instances.some(instance => instance.pose !== undefined))) this.releasePipelines?.();
    if (await this.packets.setValidated(packet, signal)) { this.sceneChanged(); this.syncProbeClipmapSurfaces(packet);
      if (this.clusterLodEnabled) this.packets.stageClusterLodProduction(); }
    this.virtualTextures?.syncTextures(packet.textures ?? []);
  }
  stageResidentPacket(projection: ResidentPacketProjection): void {
    this.deviceEpoch?.assertCurrent(this.session.device);
    this.packets.stageResidentProjection(projection);
  }
  async stageResidentPacketValidated(projection: ResidentPacketProjection,
    signal?: AbortSignal): Promise<void> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    if (this.deformationNeedsEarlyRelease && projection.batches.some(batch => batch.source.pose !== undefined)) this.releasePipelines?.();
    await this.packets.stageResidentProjectionValidated(projection, signal);
  }
  cancelResidentPacketStage(): void { this.packets.cancelPendingPacketStage(); }
  async setInstancesValidated(data: Float32Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> { await this.setPacketValidated(spherePacket(data), signal); }
  setDiagnosticsSampling(enabled: boolean): void { this.diagnostics.setEnabled(enabled); } updateInstances(update: InstanceUpdate): void { this.deviceEpoch?.assertCurrent(this.session.device); if (this.packets.updateInstances(update)) this.shadowDirty = true; }
  /**
   * 第 3 条权威路径:CPU 拾取查询(同步)。遍历当前发布实例并用几何球体宽相位筛选,
   * 最坏仍为 O(实例 × 三角形);边界与精度限制见 webgpu/picking.ts 头注;不可用时返回
   * unavailable + 原因(不抛糊错),输入契约违例(非法射线)才抛精确错误。
   */
  pick(origin: ArrayLike<number>, direction: ArrayLike<number>, options: PickOptions = {}): PickResult {
    let inputs: ReturnType<PacketBuffers["visibilityInputs"]>;
    try { inputs = this.packets.visibilityInputs(); }
    catch (error) { return pickingUnavailable(`packet resources inaccessible (${(error as Error).message})`); }
    if (!this.packets.scenePublished) return pickingUnavailable("no render packet published");
    const notes = this.packets.drawProfile().hasDeformation
      ? ["deformation-active:instances-picked-at-base-pose"] : undefined;
    return pickScene({ batches: inputs.batches, geometries: inputs.geometries,
      ...(notes ? { degradedNotes: notes } : {}) }, origin, direction, options);
  }
  setProbeClipmap(binding?: Parameters<ForwardPlusPbrRuntime["setProbeClipmap"]>[0]): void { this.deviceEpoch?.assertCurrent(this.session.device); this.lighting.setProbeClipmap(binding); this.historyDirty = true; }
  /**
   * G1-S1：注入簇级微多边形绘制槽位（bake DAG + 各层几何，clusterLodBake 产物）。
   * 需 PbrRendererOptions.clusterLod = true（fail-closed：未开启显式拒绝）；重复调用替换旧槽位。
   * threeBridge 作者链路接线点（本轮留主线，不动 threeBridge/）：作者包编译页 →
   * bakeClusterLodDag → 本方法。
   */
  stageClusterLodScene(staging: ClusterLodSceneStaging): void {
    this.deviceEpoch?.assertCurrent(this.session.device);
    if (!this.clusterLodEnabled) {
      throw new Error("Cluster LOD slot is not enabled (PbrRendererOptions.clusterLod).");
    }
    this.clusterLodSlot?.dispose();
    this.clusterLodSlot = ClusterLodRenderSlot.create(this.session, staging, this.mainSampleCount);
  }
  /**
   * Product GI source (DeepWebGpuRenderRuntime contract): installs the real one-bounce
   * scene-radiance capture chain. Returning a controller without a radiance encoder would
   * fail closed at the session, so the producer is constructed here with the live device.
   */
  createProbeClipmapController(target: ProbeClipmapPbrTarget, deviceEpoch: string): ProbeClipmapPbrController {
    this.deviceEpoch?.assertCurrent(this.session.device);
    // 32 directions clear the thin-wall reference threshold (RMSE gate, G3-S1); fixed 8
    // probes/frame keeps the worst-case ray workload at 256 even when the grid has thousands
    // of probes. Explicit probeDirections config resolves through the fail-closed gate;
    // unconfigured keeps the shipped 32 (zero-config quality mandate).
    const frameBudget = 8;
    this.probeRadianceProducer ??= new ProbeSceneRadianceProducer(this.session.device,
      { directionCount: resolveDeepGiProducerDirectionCount(this.probeDirectionsOverride) });
    const producer = this.probeRadianceProducer;
    return new ProbeClipmapPbrController(target, deviceEpoch, {
      frameBudget, cameraCutBudget: frameBudget,
      encodeSourceRadiance: context => producer.encodeSourceRadiance(context),
      captureUnavailableReason: () => producer.captureUnavailableReason,
      captureVisibilityMoments: true,
      // Soft scene sync: an invalid packet (e.g. a deformation snapshot the ray scene
      // rejects) records a capture-blocked reason and later captures refuse, instead of
      // throwing through the session activation and killing the render loop.
      sceneRadianceSync: packet => {
        try { producer.syncScene(packet); } catch { /* reason recorded on the producer */ }
      },
    });
  }
  stageEnvironment(source: PbrEnvironmentSource, signal?: AbortSignal): Promise<EnvironmentStageResult> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    this.autoExposure?.observeSource(source);
    return this.environment.stage(candidateSignal => createPbrEnvironment(this.session, source, candidateSignal), signal); }
  stageShadowMapSize(mapSize: number, signal?: AbortSignal): Promise<EnvironmentStageResult> { this.deviceEpoch?.assertCurrent(this.session.device); return this.shadowState.stage(mapSize, signal); }
  /** Chunk streaming reads this when a new residency catalog is created; 1 keeps the fixed budget. */
  residencyBudgetScale(): number { return this.adaptiveQuality?.state().knobs.residencyBudgetScale ?? 1; }
  /** The author map size is a ceiling: adaptive pressure only ever asks for equal or less. */
  private refreshAdaptiveShadowRequest(authorShadowSize: number | undefined): void {
    const state = this.adaptiveQuality?.state();
    if (!state?.enabled) { this.adaptiveShadowSize = undefined; return; }
    if (state.knobs.shadowTier === this.adaptiveShadowTier) return;
    this.adaptiveShadowTier = state.knobs.shadowTier;
    this.adaptiveShadowSize = adaptiveShadowMapSize(state.knobs.shadowTier, authorShadowSize);
    // C10 自适应压力同轴驱动接触阴影档位:quality→…→performance(14→6 步)。
    // prepare 签名缓存被 retier 作废,下一帧按新步数重步进,无需额外失效。
    this.contactShadows?.retier(state.knobs.contactShadowTier);
  }
  private stageAdaptiveShadow(mapSize: number): void {
    if (this.optionsExactShadowCascade !== 1) return;
    const controller = new AbortController();
    this.adaptiveShadowStage = controller;
    void this.shadowState.stage(mapSize, controller.signal)
      .then(result => { if (result !== "staged") this.adaptiveShadowSize = undefined; })
      .catch(() => { this.adaptiveShadowSize = undefined; })
      .finally(() => { if (this.adaptiveShadowStage === controller) this.adaptiveShadowStage = undefined; });
  }
  /** Packet identity is the surface-cache input; the freshly advanced scene revision is the sync epoch. */
  private syncProbeClipmapSurfaces(packet: RenderPacket): void {
    if (this.probeClipmap === undefined || this.probeClipmapFailed) return;
    const revision = this.packets.visibilityRevision;
    if (revision < 1) return;
    try { this.probeClipmap.syncRenderPacket({ packet, revision }); }
    catch { this.probeClipmapFailed = true; this.probeClipmap.dispose(); }
  }
  /** Fire-and-forget particle simulation; the previous committed binding is drawn this frame. */
  private driveParticles(frame: number, flow: RenderView["particleFlow"]): void {
    const runtime = this.particleRuntime;
    if (!runtime || this.particleBusy) return;
    this.particleBusy = true;
    const now = performance.now();
    const deltaTime = Math.min(0.25, Math.max(0, (now - this.particleLastTime) / 1000));
    this.particleLastTime = now;
    void submitGpuParticleEmitterFrame(runtime, { frame, deltaTime, ...(flow === undefined ? {} : { flow }) })
      .catch(() => undefined).finally(() => { this.particleBusy = false; });
  }
  private driveProbeClipmap(frame: number, size: { readonly width: number; readonly height: number },
    cameraPosition: readonly [number, number, number], cameraCut: boolean): void {
    const controller = this.probeClipmap;
    if (controller === undefined || this.probeClipmapBusy || this.probeClipmapAbort.signal.aborted) return;
    this.probeClipmapBusy = true;
    void controller.beginFrame({ frame, viewport: [size.width, size.height],
      cameraPosition, cameraCut, sceneBounds: controller.sceneBounds }, this.probeClipmapAbort.signal)
      .catch(() => { /* runtime records its own failed diagnostics; the render loop must survive. */ })
      .finally(() => { this.probeClipmapBusy = false; });
  }
  render(view: RenderView): FrameMetrics | undefined {
    this.deviceEpoch?.assertCurrent(this.session.device);
    return this.decorateRebuildAccounting(
      this.environment.runFrame(() => this.renderPreparedFrame(view), previous => this.mainBindings.setEnvironment(previous)));
  }
  private renderPreparedFrame(view: RenderView): FrameMetrics | undefined {
    return renderPreparedFrame(this as unknown as PbrRendererFrameHost, view);
  }
  async validateFrame(view: RenderView): Promise<FrameMetrics> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    await this.ground.author.prepare(view.authorGrid);
    return this.decorateRebuildAccounting(await validateFrame(this as unknown as PbrRendererFrameHost, view));
  }
  /**
   * A2-刀2:重建周期账目披露。每次重建只展开一次(台账 total 变化的那一帧携带
   * rendererRebuilds),避开逐帧对象拷贝的分配敏感路径;消费方以 total 变化为准。
   */
  private decorateRebuildAccounting<T extends FrameMetrics | undefined>(metrics: T): T {
    if (metrics === undefined) return metrics;
    const total = rendererRebuildFrameMetrics(this.rebuildOrdinal).total;
    if (this.publishedRebuildTotal === total) return metrics;
    this.publishedRebuildTotal = total;
    return { ...metrics, rendererRebuilds: rendererRebuildFrameMetrics(this.rebuildOrdinal) } as T;
  }
  dispose(): void {
    // 拆除测试以裸 this 调用 dispose;可选调用保持其不依赖新增私有方法。
    this.cancelOutlinePrewarm?.();
    // A2-刀1:先切断拴住 renderer 实例的在途异步链。
    // ① driveProbeClipmap 的 `.finally(() => { this.probeClipmapBusy = ... })` 闭包捕获 this,
    //    probeClipmapAbort 全生命周期从未 abort,在途 beginFrame 结算前整张 renderer 图
    //    (管线/几何快照/池)被钉在堆上;② stageAdaptiveShadow 的 then/catch/finally 闭包
    //    同理捕获 this。abort 让两条链在 dispose 边界立即结算,不再拖尾。
    this.probeClipmapAbort?.abort();
    this.adaptiveShadowStage?.abort();
    this.probeClipmap?.dispose();
    this.probeRadianceProducer?.dispose();
    this.probeRadianceProducer = undefined;
    this.particlePass?.dispose();
    this.particleRuntime?.dispose();
    this.splats?.dispose();
    const owners = [this.ground.author, this.outputs, this.environment, this.lighting, this.localShadows,
      this.shadowState, this.previousHiZ, this.transparency, this.postProcess, this.packets, this.targets,
      ...(this.visibility ? [this.visibility] : []), ...(this.clusterLodSlot ? [this.clusterLodSlot] : []),
      ...(this.virtualTextures ? [this.virtualTextures] : []),
      ...(this.virtualTileLookup ? [this.virtualTileLookup] : []),
      ...(this.virtualShadows ? [this.virtualShadows] : []),
      ...(this.sdfGi ? [this.sdfGi] : []),
      ...(this.rtShadows ? [this.rtShadows] : [])];
    // 释放背景排队门：未 release 就销毁的宿主也能让挂起的门禁 promise 结算。
    this.releasePipelines?.();
    runResourceCleanup("PBR renderer cleanup failed.", [
      // A2-刀2:先入账(此刻 session/池/编译清单仍可读),失败随 AggregateError 披露,
      // 不阻断后续 owner 释放。内联展开:拆除测试以裸 this 调用 dispose(既有调用契约,
      // 与上方可选调用同族)—— 账目数据源缺失 = 无账可记,跳过且不伪零;
      // 真实渲染器恒有两源,必记账。
      () => {
        const memory: import("./deviceResourceMemory.js").DeviceResourceMemorySnapshot | undefined
          = this.session.resourceMemory;
        const transient = this.transientTextures?.stats;
        if (memory === undefined || transient === undefined) return;
        const device = this.session.device as GPUDevice | undefined;
        recordRendererRebuild({ atMs: this.now(), releasedEstimateBytes: memory.estimatedBytes,
          bufferBytes: memory.bufferBytes, textureBytes: memory.textureBytes,
          transientAllocatedBytes: transient.allocatedBytes,
          transientPeakResidentBytes: transient.peakResidentBytes,
          pipelineCompiles: device === undefined ? 0 : snapshotPipelineCompileRecords(device).length });
      },
      ...owners.map(owner => () => owner.dispose()),
      () => this.cameraHistory.reset(),
      // A2-刀1:断开编译管线图的两条实例级强引用(this.pipelines 构造参数属性 +
      // this.releasePipelines 经 bootstrap 闭包持 set/延迟 deformation build),并丢弃
      // 帧捕获读回 promise(lastFrameReadback 持整帧像素大 typed array)。
      // 都放在 session.dispose 之前:此后无任何消费方,renderer 实例即便被残余闭包
      // 短暂钉住,也不再拖住最大头的管线图与读回缓冲。
      () => {
        this.pipelines = undefined;
        this.releasePipelines = undefined;
        this.lastFrameReadback = undefined;
      },
      () => this.session.dispose()]);
  }
  private sceneChanged(): void { this.shadowDirty = true; this.historyDirty = true; }
  /** 帧编排宿主时钟注入(PbrRendererFrameHost.now;本类是 performance 白名单面)。 */
  now(): number { return performance.now(); }
  private outlinePrewarmScheduled = false;
  private outlinePrewarmHandle: { kind: "idle" | "timeout"; id: number } | undefined;
}

const probeClipmapDeviceEpochs = new WeakMap<object, string>();
let probeClipmapEpochCounter = 0;
function probeClipmapDeviceEpoch(device: GPUDevice): string {
  const cached = probeClipmapDeviceEpochs.get(device);
  if (cached !== undefined) return cached;
  const created = `deep-probe-clipmap-${++probeClipmapEpochCounter}`;
  probeClipmapDeviceEpochs.set(device, created);
  return created;
}
