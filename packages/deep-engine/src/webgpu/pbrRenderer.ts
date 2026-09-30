import { DeviceSession } from "./deviceSession.js";
import { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";
import { uploadBuffer } from "./meshBuffers.js";
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
import { PreviousHiZVisibility, type PreviousHiZFramePlan } from "./previousHiZVisibility.js";
import { PbrShadowState } from "./pbrShadowState.js";
import { ContactShadowResources, describeContactShadowPass, describeContactApplyPass } from "../shadows/contactShadowResources.js";
import { hasClusteredLights, resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import { resolveDeepGiProducerDirectionCount } from "../lighting/probeRadianceDirectionGate.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
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
import type { PbrFramePassTimings } from "./pbrFrameReceipt.js";
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
import { createGpuParticleRuntimeFromEmitters, submitGpuParticleEmitterFrame } from "./gpuParticleEmitters.js";
import type { GpuParticleRuntime } from "./gpuParticleRuntime.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "./renderTargets.js";
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
  get materialBindingStats() { return this.packets.materialBindingStats; }
  /** C26: immutable device compile ledger, copied only when requested. */
  getPipelineCompileRecords() { return snapshotPipelineCompileRecords(this.session.device); }
  private readonly packets: PacketBuffers; private readonly ground: PbrGroundResources;
  private readonly frameBuffer: GPUBuffer;
  private readonly mainBindings: PbrMainBindings;
  private readonly environment: PbrEnvironmentState;
  private readonly shadowState: PbrShadowState; private get shadows() { return this.shadowState.current; }
  /** C10 屏幕空间接触阴影;opt-in(features.contactShadows),默认不存在。 */
  private readonly contactShadows: ContactShadowResources | undefined;
  private readonly targets: RenderTargets; private readonly transientTextures: PbrTransientTexturePool;
  private readonly postProcess: PbrPostProcessChain;
  private readonly transparency: PbrTransparencyPass; private readonly lighting: ForwardPlusPbrRuntime;
  private readonly localShadows: LocalSpotShadowRuntime;
  private readonly cameraHistory = new CameraFrameHistory();
  private readonly previousHiZ = new PreviousHiZVisibility();
  private pendingHiZ: PreviousHiZFramePlan | undefined; private readonly outputs: PbrOutputBindings;
  private readonly features: PbrRendererFeatures; private frame = 0;
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
  private particleBusy = false;
  private particleLastTime = performance.now();
  private readonly visibility: VisibilityBufferPath | undefined;
  private readonly adaptiveQuality: AdaptiveQualityController | undefined;
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
  /** 上一已提交渲染帧的相机切换;自动曝光在其后一帧直取目标(剪除瞬态)。 */
  private previousFrameCameraCut = false;
  private constructor(readonly session: DeviceSession, private readonly pipelines: Pipelines, environment: StudioEnvironment,
    lighting: ForwardPlusPbrRuntime, localShadows: LocalSpotShadowRuntime, options: PbrRendererOptions, features: PbrRendererFeatures,
    deformationPipelines?: Pipelines | Promise<Pipelines>, private readonly releasePipelines?: () => void) {
    this.deviceEpoch = new RendererDeviceEpoch(session.device);
    this.diagnostics = new PbrRendererDiagnostics(session);
    this.clusterLodEnabled = resolveClusterLodSlotOption(options.clusterLod);
    // F4 虚拟纹理(opt-in):resolve disabled(未启用/非法配置)时不构造任何资源,
    // 与整纹理路径零差异;enabled 时驻留失败 fail-closed 回整纹理(原因随遥测披露)。
    this.virtualTextures = createVirtualTextureFrameBridge(session, options.virtualTextures);
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
      fallback ? pipelines.materialLayout.material : undefined);
    this.writeGeometryBuffers = features.ambientOcclusion || features.screenSpaceReflection || features.volumetricFog || features.temporalAa || features.contactShadows
      || deformationPipelines !== undefined;
    this.ground = createPbrGround(session);
    this.frameBuffer = uploadBuffer(session, "Deep frame", this.frameData, GPUBufferUsage.UNIFORM);
    this.outputs = new PbrOutputBindings(session, pipelines, () => performance.now(), features.spatialAa);
    this.shadowState = new PbrShadowState(session, pipelines, options.shadows);
    this.optionsExactShadowCascade = options.shadows?.exactProfile?.cascadeCount;
    this.probeDirectionsOverride = options.probeDirections;
    this.lastAuthorShadowSize = options.shadows?.exactProfile?.shadowMapSize;
    this.contactShadows = features.contactShadows ? new ContactShadowResources(session, options.contactShadows ?? {}) : undefined;
    this.environment = new PbrEnvironmentState(environment);
    this.mainBindings = new PbrMainBindings(session, pipelines, this.frameBuffer, this.shadows, environment);
    this.transientTextures = new PbrTransientTexturePool(session, options.transientTextureBudgetBytes); this.targets = new RenderTargets(session, pipelines.output.getBindGroupLayout(0), this.outputs.buffer, this.transientTextures);
    this.features = features;
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
  get frameCaptureSession(): FrameCaptureSession | undefined { return this.frameCapture?.session; }
  /** 首帧验证通过后由宿主调用：放行背景 main 变体排队，避免与首帧争抢设备。 */
  releaseBackgroundPipelines(): void { this.releasePipelines?.(); }
  static async create(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, options: PbrRendererOptions = {}): Promise<PbrRenderer> {
    if (typeof performance !== "undefined") performance.mark("deep-webgpu:device-open-start");
    const session = await DeviceSession.open(canvas, gpu, signal, options.deviceMemoryBudgetBytes, options.recovery);
    const deviceEpoch = new RendererDeviceEpoch(session.device);
    if (typeof performance !== "undefined") performance.mark("deep-webgpu:device-opened");
    return openPbrRenderer(session, signal, options, () => new DOMException("GPU preparation cancelled", "AbortError"),
      (...args) => { deviceEpoch.assertCurrent(session.device); return new PbrRenderer(...args); });
  }
  setInstances(data: Float32Array<ArrayBuffer>): void { this.setPacket(spherePacket(data)); }
  setPacket(packet: RenderPacket): void {
    this.deviceEpoch?.assertCurrent(this.session.device);
    if (this.packets.set(packet)) { this.sceneChanged(); this.syncProbeClipmapSurfaces(packet); }
    // F4 虚拟纹理目录全量同步:opt-in 才有 bridge;包内 RGBA8 纹理按需分页,压缩纹理
    // 显式不入目录(反馈侧 droppedUnknownTexture 计数,采样方整纹理路径不受影响)。
    this.virtualTextures?.syncTextures(packet.textures ?? []);
  }
  async setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    if (await this.packets.setValidated(packet, signal)) { this.sceneChanged(); this.syncProbeClipmapSurfaces(packet); }
    this.virtualTextures?.syncTextures(packet.textures ?? []);
  }
  stageResidentPacket(projection: ResidentPacketProjection): void {
    this.deviceEpoch?.assertCurrent(this.session.device);
    this.packets.stageResidentProjection(projection);
  }
  async stageResidentPacketValidated(projection: ResidentPacketProjection,
    signal?: AbortSignal): Promise<void> {
    this.deviceEpoch?.assertCurrent(this.session.device);
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
    this.clusterLodSlot = ClusterLodRenderSlot.create(this.session, staging);
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
  render(view: RenderView): FrameMetrics | undefined { this.deviceEpoch?.assertCurrent(this.session.device); return this.environment.runFrame(() => this.renderPreparedFrame(view), previous => this.mainBindings.setEnvironment(previous)); }
  private renderPreparedFrame(view: RenderView): FrameMetrics | undefined {
    const begin = performance.now();
    if (this.session.state !== "ready") return undefined;
    if (this.session.hasErrors) throw new Error("GPU validation failed; inspect device diagnostics.");
    validatePbrRenderView(view);
    // F8 自动曝光(opt-in):环境 mip 亮度静态代理(零 readback)→ ±EV 包络 →
    // 时域平滑(帧间收敛上限防闪烁)。无可靠亮度时 advance 返回 undefined,保持
    // 调用方固定启发式 view.exposure(fail-closed);原因见 FrameMetrics.autoExposure。
    if (this.autoExposure !== undefined) {
      const exposureFrame = this.autoExposure.advance(begin, this.previousFrameCameraCut);
      if (exposureFrame !== undefined) view = { ...view, exposure: exposureFrame.exposure };
    }
    const postProcess = resolvePbrPostProcessOverrides(view.postProcess, this.features);
    if (this.previousAmbientOcclusion !== undefined && this.previousAmbientOcclusion !== postProcess.ambientOcclusion) {
      this.historyDirty = true;
    }
    if (this.environment.beginFrame(candidate => this.mainBindings.setEnvironment(candidate))) this.historyDirty = true;
    if (view.lights !== this.previousTemporalLights) {
      this.previousTemporalLights = view.lights; this.temporalLightRevision += 1;
    }
    const sceneLighting = resolvePbrSceneLighting(view.lights);
    if (this.mainBindings.update(view.lights, view.fog)) this.historyDirty = true;
    // F1 scene-radiance latch: the producer packs whatever was latest at capture encode time,
    // so probes shade with the same primary light the raster pass uses. The ambient term is
    // the environment's GPU-read average; until the first readback lands it stays zero and a
    // zero total energy still fails closed (no dark volume is ever published).
    const currentEnvironment = this.environment.current;
    if (this.probeRadianceProducer && this.ambientEnvironment !== currentEnvironment
      && !this.ambientReader?.busy) {
      this.ambientEnvironment = currentEnvironment;
      this.ambientReader ??= new EnvironmentAmbientReader(this.session);
      void this.ambientReader.read(currentEnvironment).then(ambient => {
        this.environmentAmbient = ambient;
      }).catch(() => { /* keep the last committed average; capture stays fail-closed */ });
    }
    this.probeRadianceProducer?.syncLighting({
      primary: { surfaceToLightWorld: [...sceneLighting.primary.surfaceToLightWorld],
        color: [...sceneLighting.primary.color], intensity: sceneLighting.primary.intensity },
      ambient: this.environmentAmbient });
    if (this.pendingHiZ) { this.previousHiZ.failFrame(this.pendingHiZ); this.pendingHiZ = undefined; }
    this.packets.failLodFrame();
    this.packets.cancelDeformationFrame();
    this.cameraHistory.cancelPendingFrame();
    try {
      if (this.packets.publishResidentProjection()) this.sceneChanged();
    } catch (error) {
      this.sceneChanged(); throw error;
    }
    if (this.resolutionScaler && this.frame > 0) {
      // 前一帧的 CPU 编码时间驱动缩放决策；无样本（首帧/诊断关闭）保持 1 不猜测。
      const previousCpu = this.diagnostics.performance.snapshot().stages["frame-encode"];
      const frameMs = previousCpu?.p50Ms;
      if (frameMs !== undefined) {
        const decision = this.resolutionScaler.observe(frameMs);
        if (decision.scale !== this.resolutionScale) {
          this.resolutionScale = decision.scale;
          this.resolutionScaleRevision += 1;
        }
      }
    }
    // F4 时域超分联动:激活(特性开 + scale<1)时画布保持全分辨率、渲染目标按 scale
    // 降档,链尾上采样核重建到画布;未激活沿用原口径(画布即渲染分辨率,浏览器拉伸)。
    const upscaling = temporalUpscaleActive(this.features.temporalUpscale, this.resolutionScale);
    const surface = this.session.resize(view.width, view.height,
      view.pixelRatio * (upscaling ? 1 : this.resolutionScale));
    if (!surface) return undefined;
    const size = upscaling ? internalRenderSize(surface, this.resolutionScale) : surface;
    const authorShadowSize = sceneLighting.primary.shadow?.mapSize;
    if (authorShadowSize !== this.lastAuthorShadowSize) {
      this.lastAuthorShadowSize = authorShadowSize;
      // A fresh author request supersedes any adaptive shadow request still in flight.
      this.adaptiveShadowSize = undefined;
    }
    this.refreshAdaptiveShadowRequest(authorShadowSize);
    const desiredShadowSize = this.adaptiveShadowSize ?? authorShadowSize;
    if (desiredShadowSize !== undefined && desiredShadowSize !== authorShadowSize
      && this.adaptiveShadowStage === undefined
      && desiredShadowSize !== this.shadowState.current.selection.profile.options.shadowMapSize) {
      this.stageAdaptiveShadow(desiredShadowSize);
    }
    if (this.shadowState.publish(desiredShadowSize, candidate => this.mainBindings.setShadows(candidate, this.environment.current))) this.sceneChanged();
    const drawProfile = this.packets.drawProfile();
    const directClear = drawProfile.hasDeformation || view.authorGrid || this.particleRuntime
      ? undefined : pbrDirectDisplayClear(view, this.features, drawProfile.hasTransparent, this.writeGeometryBuffers);
    const directionalDisplay = directClear !== undefined && !this.lighting.hasProbeClipmap && !hasClusteredLights(sceneLighting.clustered)
      && !drawProfile.hasMaterialTextures && this.pipelines.displayDirectionalMain !== undefined;
    const frameState = updatePbrFrameUniforms(this.session.device.queue, this.cameraHistory, view,
      size.width, size.height, this.historyDirty, { frameBuffer: this.frameBuffer, outputBuffer: this.outputs.buffer,
        groundInstance: this.ground.instance, frameData: this.frameData, outputData: this.outputs.data, groundData: this.ground.data },
      sceneLighting.primary, this.features);
    const history = frameState.history;
    this.previousFrameCameraCut = history.cameraCut;
    const hiZPlan = this.features.occlusionCulling ? this.previousHiZ.beginFrame({
      frameRevision: history.revision, sceneRevision: this.packets.visibilityRevision,
      depthViewProjection: frameState.depthViewProjection, stableViewProjection: frameState.stableViewProjection, cameraPosition: view.eye,
      viewport: [size.width, size.height], reversedZ: false, cameraCut: history.cameraCut,
    }) : undefined;
    this.pendingHiZ = hiZPlan;
    const device = this.session.device;
    let submitAttempted = false;
    let particleReactive: PbrTransientTextureHandle | undefined;
    let captureOpen = false;
    try {
      const frameNumber = this.frame + 1;
      this.driveParticles(frameNumber, view.particleFlow);
      this.driveProbeClipmap(frameNumber, size, view.eye, history.cameraCut);
      // The same cached plan powers explicit captures and the lightweight live
      // Frame Graph receipt. Diagnostics stay opt-in, so ordinary frames pay
      // neither plan construction nor receipt allocation.
      const capturePlan = (this.frameCapture || this.performanceTelemetry.enabled)
        ? this.captureForFrame(size, drawProfile.hasTransparent, postProcess, directClear !== undefined) : undefined;
      if (this.frameCapture && capturePlan) {
        this.frameCapture.begin(`frame-${frameNumber}`, capturePlan.plan);
        captureOpen = true;
      }
      const allocationPlan = this.allocationPlanFor(drawProfile.hasTransparent, postProcess, directClear !== undefined);
      // Capture can append readbacks outside the production graph; keep its resources physically distinct.
      this.targets.beginFrame(size, this.frameCapture ? [] : allocationPlan.resources, this.writeGeometryBuffers);
    let lighting: ReturnType<ForwardPlusPbrRuntime["prepareAndEncode"]> | undefined;
    // Static packets have no deformation work. Encode their light assignment in the main
    // command buffer instead of allocating and submitting an empty parallel encoder.
    const preparation = directionalDisplay || !drawProfile.hasDeformation ? undefined : encodeRenderGraphEncoderGroup(device,
      this.preparationPlan, this.preparationGroupIndex, new Map([
        ["deform", ({ encoder }) => this.packets.encodeDeformation(encoder)],
        ["cluster-lights", ({ encoder }) => {
          lighting = this.lighting.prepareAndEncode(encoder, { viewportWidth: size.width, viewportHeight: size.height,
            near: frameState.projection.near, far: frameState.projection.far,
            verticalFovRadians: frameState.projection.verticalFovRadians,
            lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView) });
        }],
      ]), { encoderLabelPrefix: "Deep PBR prepare" });
    const encoder = device.createCommandEncoder({ label: "Deep frame" });
    // F4 虚拟纹理逐帧推进(opt-in):batch 级反馈代理 → 预算驻留 → tile-lookup 消费
    // 编码,全部挂主 encoder;驻留时钟独立自增(渲染失败重试帧不破坏单调合同)。
    const virtualTexturesMetrics = this.virtualTextures
      ? this.driveVirtualTextures(frameState, size, encoder) : undefined;
    // G1-S1 簇级槽位：选层 compute pass + 读回拷贝追加到主 encoder（相机静止时零工作）。
    // 仅 plain HDR 帧签名可执行；MRT/directDisplay 记录 sticky fallback（不静默降级）。
    const clusterLod = this.clusterLodSlot;
    const clusterLodSupported = clusterLod !== undefined && !directClear && !this.writeGeometryBuffers;
    if (clusterLod && !clusterLodSupported) clusterLod.noteFrameSignatureUnsupported();
    if (clusterLod && clusterLodSupported && !clusterLod.hasFallback()) {
      clusterLod.updateCameraFromView(view, size.height, frameState.projection.verticalFovRadians);
      clusterLod.setViewProjection(frameState.depthViewProjection);
      clusterLod.encodeFrame(encoder);
    }
    if (!preparation && drawProfile.hasDeformation) this.packets.encodeDeformation(encoder);
    if (!preparation && !directionalDisplay) lighting = this.lighting.prepareAndEncode(encoder, {
      viewportWidth: size.width, viewportHeight: size.height,
      near: frameState.projection.near, far: frameState.projection.far,
      verticalFovRadians: frameState.projection.verticalFovRadians,
      lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView),
    });
    const visibility = pbrVisibilityInput(view, frameState.projection, size.width, size.height, history.cameraCut,
      this.adaptiveQuality?.state().knobs.lodDetailScale ?? 1);
    const previousHiZ = hiZPlan ? this.previousHiZ.occlusionView(hiZPlan) : undefined;
    const mainFrustum = visibility.frustum, lodStats = this.packets.encodeLod(encoder,
      previousHiZ ? { ...visibility.lod, previousHiZ } : visibility.lod);
    const lodWork = new PbrLodWork(lodStats);
    const hasTransparent = drawProfile.hasTransparent;
    const detailedTiming = directClear === undefined && !view.editorOverlay?.vertices.length;
    // F1 逐 pass 计时:pass 清单取自同一帧的执行计划 ∩ executed 集合(单一 pass 身份
    // 来源,禁止第二套)。scope 不可用(不支持/槽忙/超容)时回退帧级三段计时。
    const executedPasses = this.executedCapturePassIds(directClear !== undefined, postProcess, hasTransparent);
    const passTiming = capturePlan && this.gpuTimer.passTimingEnabled ? this.gpuTimer.beginPasses(this.frame + 1,
      capturePlan.plan.mappedPassIds.filter(passId => executedPasses.has(passId))) : undefined;
    const timing = passTiming ? undefined : this.gpuTimer.begin(this.frame + 1, detailedTiming);
    const timingStart = timing ? { timestampWrites: { querySet: timing.queries, beginningOfPassWriteIndex: 0 } } : {};
    const shadowFrame = this.shadows.prepare({ eye: view.eye, target: view.target, ...(view.up ? { up: view.up } : {}),
      verticalFovRadians: frameState.projection.verticalFovRadians, aspect: size.width / size.height,
      near: frameState.projection.near, far: frameState.projection.far, extent: view.extent,
      lightDirection: sceneLighting.primary.rayDirectionWorld, ...(sceneLighting.primary.shadow ? { authored: sceneLighting.primary.shadow, viewportHeight: size.height } : {}) }, this.shadowDirty, sceneLighting.primary.castShadow !== false);
    let shadowUpdated = shadowFrame.render;
    let drawCalls = view.panoramaBackground ? 1 : 0, triangles = drawCalls;
    if (shadowUpdated) {
      const shadowLodStats = this.packets.encodeShadowLod(encoder, shadowFrame.plan);
      lodWork.add(shadowLodStats);
      shadowFrame.plan.cascades.forEach((cascade, index) => {
        this.packets.encodeCulling(encoder, viewProjectionFrustum(cascade.viewProjection), "shadow", undefined, index);
        const shadow = encoder.beginRenderPass({ label: `Deep shadow cascade ${index}`,
          ...(index === 0 ? timingStart : {}), colorAttachments: [], depthStencilAttachment: {
            view: this.shadows.layerViews[index]!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
          } });
        shadow.setPipeline(this.pipelines.shadow);
        shadow.setBindGroup(0, this.shadows.frameBindings[index]!);
        const stats = this.packets.draw(shadow, sceneLighting.primary.shadow ? authoredShadowPipelines(this.pipelines) : this.pipelines, "shadow", undefined, true, index, false, !!sceneLighting.primary.shadow);
        drawCalls += stats.drawCalls; triangles += stats.triangles;
        shadow.end();
      });
    }
    const localShadow = lighting ? this.localShadows.prepareAndEncode(encoder, this.packets, this.pipelines, sceneLighting.clustered,
      this.shadowDirty, !shadowUpdated && timing ? timingStart.timestampWrites : undefined) : { rendered: false, drawCalls: 0, triangles: 0 };
    shadowUpdated ||= localShadow.rendered; drawCalls += localShadow.drawCalls; triangles += localShadow.triangles;
    lodWork.add(localShadow);
    const opaqueCulling = this.packets.encodeCulling(encoder, mainFrustum, "opaque",
      { sceneRevision: this.packets.visibilityRevision, ...(previousHiZ ? { previousHiZ } : {}) });
    if (!hasTransparent) this.transparency.clearReactiveMask();
    let present: PbrPresentReceipt | undefined = directClear ? this.outputs.acquirePresent(this.performanceTelemetry.enabled) : undefined;
    const mainTimestamps = directClear && timing && !view.editorOverlay?.vertices.length ? { querySet: timing.queries,
      ...(!shadowUpdated ? { beginningOfPassWriteIndex: 0 } : {}), endOfPassWriteIndex: 1 }
      : timing && !directClear ? { querySet: timing.queries,
        ...(!shadowUpdated ? { beginningOfPassWriteIndex: 0 } : {}), endOfPassWriteIndex: 2 }
        : !shadowUpdated && timing ? timingStart.timestampWrites : undefined;
    passTiming?.beginMarker(encoder, "opaque");
    const main = beginPbrOpaquePass(encoder, { targets: this.targets, background: directClear ?? view.background,
      writeGeometryBuffers: this.writeGeometryBuffers, drawBackground: this.mainBindings.prepareBackground(view, this.environment.current, size.width / size.height, this.writeGeometryBuffers),
      ...(present ? { directDisplayView: present.view } : {}), ...(mainTimestamps ? { timestampWrites: mainTimestamps } : {}) });
    main.setPipeline(directClear ? this.pipelines.displayMain! : this.pipelines.main);
    main.setBindGroup(0, this.mainBindings.binding);
    main.setBindGroup(2, this.shadows.binding);
    if (lighting) main.setBindGroup(lighting.bindGroupIndex, lighting.bindGroup);
    const stats = this.packets.draw(main, this.pipelines, directClear ? "display" : "opaque", undefined, true, 0, directionalDisplay);
    drawCalls += stats.drawCalls; triangles += stats.triangles;
    const groundStats = drawPbrGround(this.features.groundPlane, main,
      directClear && directionalDisplay ? this.pipelines.displayDirectionalMain! : directClear ? this.pipelines.displayMain! : this.pipelines.main,
      this.ground.mesh, this.ground.instance, directClear !== undefined);
    drawCalls += groundStats.drawCalls; triangles += groundStats.triangles;
    // G1-S1：簇级前沿 bundle（executeBundles 计 1 次绘制调用；GPU indirect 命令数在
    // metrics.clusterLod.draws 如实报告）。选层为一帧延迟：首帧 warming 不绘制。
    if (clusterLod && clusterLodSupported && !clusterLod.hasFallback()) {
      const clusterLodStats = clusterLod.draw(main);
      if (clusterLodStats) { drawCalls += 1; triangles += clusterLodStats.triangles; }
    }
    main.end();
    passTiming?.endMarker(encoder, "opaque");
    // Particle simulation commits asynchronously; consume the latest committed binding here.
    // A one-frame simulation-to-render latency avoids queue stalls and keeps particle count
    // fully GPU-driven (drawIndirect never reads instance count back to JS).
    const particleBinding = this.particleRuntime?.current?.binding;
    if (this.particlePass && particleBinding) {
      // TAA 开启时才分配响应掩码目标；粒子 alpha 覆盖写入第二目标供时域降反馈。
      particleReactive = this.features.temporalAa
        ? this.transientTextures.acquire({ resourceId: "particle-reactive", format: "r8unorm",
          width: size.width, height: size.height, sampleCount: 1,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
        : undefined;
      this.particlePass.encode({ encoder, colorView: this.targets.hdr, depthView: this.targets.depth,
        width: size.width, height: size.height,
        camera: { viewProjection: [...frameState.depthViewProjection],
          cameraRight: [frameState.worldToView[0]!, frameState.worldToView[4]!, frameState.worldToView[8]!],
          cameraUp: [frameState.worldToView[1]!, frameState.worldToView[5]!, frameState.worldToView[9]!] },
        binding: particleBinding, ...(particleReactive ? { reactiveView: particleReactive.view } : {}) });
      drawCalls++;
    }
    const gridTriangles = this.ground.author.encode(encoder, this.targets.hdr, this.targets.depth, frameState.depthViewProjection, frameState.worldToView, view.authorGrid);
    if (gridTriangles) { drawCalls++; triangles += gridTriangles; }
    // P0-2 可见性合成（opt-in）：仅 HDR 管线路径；directDisplay 与 authorGrid 快路径保持逐字节不变。
    if (this.visibility && !directClear) {
      this.visibility.encodeComposite(encoder, { hdrView: this.targets.hdr, depthView: this.targets.depth,
        width: size.width, height: size.height, frameData: this.frameData, inputs: this.packets.visibilityInputs() });
    }
    // The chain owns override resolution. Keep the resolved snapshot above for
    // capture planning, but do not feed it back as if it were author input.
    const postProcessInput: PbrPostProcessInput = { encoder, targets: this.targets, revision: history.revision,
      ...(postProcess.volumetricFog && postProcess.volumetricFogProfile.godRaysStrength !== undefined
        ? { godRays: { ...pbrGodRaysFrame(sceneLighting.primary, frameState.worldToView), shadows: this.shadows.godRaysSource() } } : {}),
      ...(view.postProcess === undefined ? {} : { postProcess: view.postProcess }),
      extent: view.extent, verticalFovRadians: frameState.projection.verticalFovRadians,
      cameraCut: history.cameraCut, currentJitter: history.currentJitter,
      previousJitter: history.previousJitter, materialRevision: this.packets.visibilityRevision,
      lightRevision: this.temporalLightRevision, exposure: view.exposure,
      // T07: the flag now reports real reactive (no-motion-target) region presence:
      // weighted-OIT transparency and GPU particles never write the motion target.
      // Per-pixel mask supply stays unwired until the reactive-mask pass joins the
      // frame plan (see docs/reports/deep-core/T07-implementation.md).
      reactiveMaskAvailable: false,
      // C11:SSR 替换分数与主着色器共用同一 DFG(environment.brdf)。
      ...(this.environment.current ? { brdfLut: this.environment.current.brdf } : {}),
      surfaceWidth: size.width, surfaceHeight: size.height,
      ...(this.adaptiveQuality ? { adaptiveQuality: this.adaptiveQuality.state().knobs } : {}),
      ...(passTiming ? { passTiming } : {}) };
    const opaqueEffects: ReturnType<PbrPostProcessChain["encodeOpaque"]> = directClear
      ? { color: this.targets.hdrTexture, passCount: 0 } : this.postProcess.encodeOpaque(postProcessInput);
    if (hiZPlan && !opaqueEffects.hiZ) throw new Error("Hi-Z visibility enabled without a produced depth pyramid.");
    let temporalInput = opaqueEffects.color;
    if (hasTransparent) {
      const transparentStats = this.transparency.encode({ encoder, opaqueColor: opaqueEffects.color,
        hdrColor: this.targets.hdrTexture, hdrView: this.targets.hdr, depthView: this.targets.depth,
        ...(passTiming ? { passTiming } : {}),
        viewOf: texture => this.outputs.view(texture), draw: pass => {
          pass.setBindGroup(0, this.mainBindings.binding); pass.setBindGroup(2, this.shadows.binding);
          pass.setBindGroup(lighting!.bindGroupIndex, lighting!.bindGroup);
          return this.packets.draw(pass, this.pipelines, "transparent", undefined, true);
        } });
      temporalInput = transparentStats.color;
      drawCalls += transparentStats.drawCalls; triangles += transparentStats.triangles;
    }
    const finalEffects = directClear ? { color: temporalInput, passCount: 0 }
      : this.postProcess.encodeFinal({ ...postProcessInput,
        reactiveMaskAvailable: this.transparency.currentReactiveMask !== undefined || particleReactive !== undefined,
        ...(this.transparency.currentReactiveMask ? { reactiveMask: this.transparency.currentReactiveMask }
          : particleReactive ? { reactiveMask: particleReactive.texture } : {}) }, temporalInput);
    // C10 接触阴影(AO 同款管线形态):主 pass 写完 linear-depth 后短距步进生成
    // 半分辨率遮蔽贴,apply 将其乘回最终 HDR(整帧衰减,语义同 SSAO 合成)。
    // 相机切换帧强度归零(fail-closed)。opt-in:features.contactShadows,默认关闭。
    let presentColor = finalEffects.color;
    let contactApplied = false;
    if (this.contactShadows && !directClear) {
      const contactFrame = this.contactShadows.prepare({
        verticalFovRadians: frameState.projection.verticalFovRadians,
        aspect: size.width / size.height, near: frameState.projection.near, far: frameState.projection.far,
        worldToView: [...frameState.worldToView],
        lightDirectionWorld: sceneLighting.primary.rayDirectionWorld,
        extent: view.extent, width: size.width, height: size.height, cameraCut: history.cameraCut,
      }, this.shadowDirty, true);
      const applied = this.contactShadows.encode(encoder, contactFrame, this.targets.linearDepth,
        finalEffects.color, passTiming ?? undefined);
      presentColor = applied.texture;
      contactApplied = true;
    }
    let presentInput = finalEffects.color;
    let upscaleMetrics: FrameMetrics["temporalUpscale"] | undefined;
    if (!directClear) {
      if (contactApplied) presentInput = presentColor;
      // F4 时域超分:激活时链尾重建到画布全分辨率,输出即 present 输入与读回落点。
      if (upscaling) {
        passTiming?.beginMarker(encoder, "temporal-upscale");
        const upscaled = this.postProcess.encodeUpscale({
          encoder, targets: this.targets, revision: history.revision, extent: view.extent,
          cameraCut: history.cameraCut, currentJitter: history.currentJitter,
          previousJitter: history.previousJitter,
          // Reactive mask 与 encodeFinal 同源(透明 OIT/粒子两路,照 638-640 现成模式):
          // 带反应遮罩的像素历史降权,防止超分把透明/粒子变化拖出鬼影。
          ...(this.transparency.currentReactiveMask ? { reactiveMask: this.transparency.currentReactiveMask }
            : particleReactive ? { reactiveMask: particleReactive.texture } : {}),
          displayWidth: surface.width, displayHeight: surface.height,
        }, presentInput);
        if (!upscaled) throw new Error("Temporal upscale is active but the pass is unavailable.");
        presentInput = upscaled.texture;
        presentColor = upscaled.texture;
        upscaleMetrics = Object.freeze({ displayWidth: upscaled.width, displayHeight: upscaled.height,
          historyUsed: upscaled.historyUsed, invalidation: upscaled.invalidation });
        passTiming?.endMarker(encoder, "temporal-upscale");
        drawCalls += 1; triangles += 1;
      }
      passTiming?.beginMarker(encoder, "present");
      present = this.outputs.present(encoder, presentInput, view.authorColorEffects, this.performanceTelemetry.enabled,
        view.editorOverlay?.vertices.length ? undefined : timing?.queries, this.frameCapture !== undefined,
        detailedTiming && timing !== undefined);
      passTiming?.endMarker(encoder, "present");
      drawCalls += this.features.spatialAa ? 2 : 1; triangles += this.features.spatialAa ? 2 : 1;
    }
    if (this.mainBindings.encodeDisplayBackground(encoder, present!.view, this.targets.depth, view,
      this.environment.current, size.width / size.height)) { drawCalls++; triangles++;
    }
    const overlayTriangles = this.outputs.encodeEditorOverlay(encoder, present!.view, view.editorOverlay, timing?.queries);
    if (overlayTriangles) { drawCalls++; triangles += overlayTriangles; }
    if (this.frameCapture && captureOpen) {
      this.frameCapture.encodeReadbacks(encoder, device, {
        "present-color": presentColor,
        "opaque-hdr": this.targets.hdrTexture,
        "linear-depth": this.targets.linearDepthTexture,
      });
    }
    timing?.resolve(encoder);
    passTiming?.resolve(encoder);
    const commands = encoder.finish();
    const encoded = this.performanceTelemetry.enabled ? performance.now() : 0;
    if (this.frameCapture && captureOpen) {
      const executedPassIds = executedPasses;
      this.frameCapture.recordPasses(this.captureActualPasses ?? [], executedPassIds, present?.sourceMapRefs);
      this.frameCapture.mark("submit", "queue.submit");
    }
    submitAttempted = true; device.queue.submit([...(preparation?.commandBuffers ?? []), commands]);
    // G1-S1：读回本帧选层槽位并派生下一帧命令；异常走槽位 sticky fallback，不打断渲染循环。
    if (clusterLod && clusterLodSupported) void clusterLod.ingest().catch(error => clusterLod.noteIngestFailure(error));
    // TAA 已在 submit 前读取响应掩码；队列有序保证提交后释放可安全回池复用。
    if (particleReactive) { this.transientTextures.release(particleReactive); particleReactive = undefined; }
    this.targets.commitFrame();
    if (this.frameCapture && captureOpen) this.lastFrameReadback = this.frameCapture.collectReadbacksAfterSubmit();
    this.postProcess.commitFrame(history.revision);
    const submitted = this.performanceTelemetry.enabled ? performance.now() : 0;
    if (this.frameCapture && captureOpen) {
      this.frameCapture.mark("submitted", "queue submitted");
      this.frameCapture.end();
      captureOpen = false;
    }
    this.packets.commitLodFrame();
    this.shadows.commit(); this.localShadows.commit();
    this.cameraHistory.commitFrame(history);
    this.previousAmbientOcclusion = postProcess.ambientOcclusion;
    if (hiZPlan) this.previousHiZ.commitFrame(hiZPlan, opaqueEffects.hiZ!);
    this.pendingHiZ = undefined;
    this.packets.commitFrame();
    timing?.read();
    passTiming?.read();
    this.shadowDirty = false; this.historyDirty = false;
    this.diagnostics.recordFrame(frameNumber, begin, encoded, submitted, present!.acquireMs);
    const metrics: FrameMetrics = { frame: ++this.frame, cpuSubmitMs: performance.now() - begin, drawCalls, triangles, ...lodWork.snapshot(),
      width: size.width, height: size.height, resources: this.session.resourceCount, shadowUpdated, transientTextures: this.targets.transientStats,
      deviceResourceMemory: this.session.resourceMemory,
      ...(this.autoExposure ? { autoExposure: this.autoExposure.metrics() } : {}),
      ...(clusterLod ? { clusterLod: clusterLod.metrics() } : {}),
      cameraCut: history.cameraCut, postProcessPasses: opaqueEffects.passCount + finalEffects.passCount + (hasTransparent ? 2 + Number(this.transparency.currentReactiveMask !== undefined) : 0) + (upscaling ? 1 : 0) + (!directClear && this.features.spatialAa ? 1 : 0),
      weightedOit: hasTransparent,
      hiZMipLevels: opaqueEffects.hiZ?.mipLevelCount ?? 0,
      occlusionCulling: opaqueCulling.occlusionBatches > 0,
      frustumCulledBatches: opaqueCulling.frustumBatches, hiZOccludedBatches: opaqueCulling.occlusionBatches, lodSelectionBatches: lodStats.selectionBatches, lodIndirectDraws: lodStats.indirectDraws,
      lightCount: lighting?.lightCount ?? 0, lightClusters: lighting?.grid.clusterCount ?? 0,
      ...(capturePlan && this.performanceTelemetry.enabled ? {
        // 帧图回执记录本帧编码覆盖;逐 pass 毫秒随读回异步完成,发布在
        // gpuPassTimings(带实测帧号),本回执的 samples 对缺测 pass 保持显式
        // unavailable,不伪零。
        frameGraphReceipt: createPbrFrameReceipt(frameNumber, capturePlan.plan, [], begin,
          Math.max(performance.now(), begin + 0.001), executedPasses),
      } : {}),
      ...(this.gpuTimer.passTimingEnabled ? { gpuPassTimings: this.passTimingsMetrics(frameNumber) } : {}),
      ...(this.resolutionScale === 1 ? {} : { resolutionScale: this.resolutionScaleMetrics(surface) }),
      ...(upscaleMetrics ? { temporalUpscale: upscaleMetrics } : {}),
      ...this.shadows.metrics,
      ...(virtualTexturesMetrics ? { virtualTextures: virtualTexturesMetrics } : {}),
      ...(this.contactShadows ? this.contactShadows.metrics : {}) };
    this.sampleAdaptiveQuality(metrics);
    if (!this.adaptiveQuality) return metrics;
    const hotspots = this.adaptiveQuality.hotspotSummary();
    return { ...metrics, adaptiveQuality: this.adaptiveQuality.state(),
      ...(hotspots.length ? { adaptiveHotspots: hotspots } : {}) };
    } catch (error) {
      if (captureOpen) this.frameCapture?.cancel();
      this.postProcess.cancelFrame(history.revision);
      this.transparency.cancelFrame();
      if (particleReactive) { this.transientTextures.release(particleReactive); particleReactive = undefined; }
      this.targets.failFrame();
      this.packets.cancelDeformationFrame();
      if (submitAttempted) this.packets.failLodFrame(); else this.packets.cancelLodFrame();
      this.lighting.invalidateAssignment(); this.localShadows.failFrame(); this.cameraHistory.cancelPendingFrame();
      if (!submitAttempted) this.clusterLodSlot?.cancelPendingFrame();
      if (hiZPlan) this.previousHiZ.failFrame(hiZPlan); this.pendingHiZ = undefined;
      throw error;
    }
  }
  /** F4 虚拟纹理逐帧推进:batch 级反馈代理 → 预算驻留 → tile-lookup 消费编码。
   *  fallback/atlas 未就绪时跳过消费编码,遥测仍逐帧回报(fail-closed,不静默)。 */
  private driveVirtualTextures(frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }, encoder: GPUCommandEncoder):
    VirtualTextureFrameMetrics | undefined {
    const bridge = this.virtualTextures!;
    const metrics = bridge.observeFrame(this.collectVirtualTextureFeedback(frameState, size));
    const atlas = bridge.atlasTexture;
    if (atlas === undefined || bridge.fallbackActive) return metrics;
    const lookup = this.virtualTileLookup!;
    const sampled = lookup.encode(encoder, { atlasView: lookup.viewOf(atlas),
      atlasEdge: bridge.atlasEdgeTexels, catalog: bridge.textureCatalog(),
      layerOfPage: (textureId, tileX, tileY, mip) => bridge.layerOfPage(textureId, tileX, tileY, mip),
      packing: bridge.packPageTable(),
      samples: bridge.samples });
    return { ...metrics, sampling: { dispatches: sampled.dispatches, samples: sampled.samples,
      skipped: sampled.skipped } };
  }

  /** batch 级反馈条目:材质纹理槽 × UV 仿射包围域 × 球盘投影屏幕像素×实例数。
   *  静态代理口径(同 autoExposure 先例):不新增 GPU 往返;不做逐实例精确视锥剔除
   *  (背向/越远裁剪由 w≤0 与 NDC z 出界剔除),覆盖高估由反馈读取器 tile 聚合兜底。 */
  private collectVirtualTextureFeedback(frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }): VirtualTextureFeedbackEntry[] {
    const inputs = this.packets.visibilityInputs();
    const entries: VirtualTextureFeedbackEntry[] = [];
    for (const batch of inputs.batches.values()) {
      const textures = batch.source.textures;
      if (!textures) continue;
      const geometry = inputs.geometries.get(batch.source.geometry);
      const screenPixels = geometry === undefined ? 0 : virtualTextureScreenPixels(geometry,
        frameState.depthViewProjection, frameState.projection.verticalFovRadians, size) * batch.source.count;
      if (!(screenPixels > 0)) continue;
      for (const slot of [textures.baseColor, textures.metallicRoughness, textures.normal,
        textures.occlusion, textures.emissive]) {
        if (!slot) continue;
        const bounds = virtualTextureUvBounds(slot.uvTransform);
        entries.push({ textureId: slot.texture, ...bounds, screenPixels });
      }
    }
    return entries;
  }

  private resolutionScaleMetrics(surface: { readonly width: number; readonly height: number }): FrameMetrics["resolutionScale"] | undefined {
    if (this.resolutionScaler === undefined || this.resolutionScale === 1) return undefined;
    // 质量槽位保持 measured=false：真实画质数字须来自 GPU 序列联测，不许发明。
    // surface 传画布尺寸:超分激活时 internalWidth/Height 就是真实渲染分辨率。
    return { revision: this.resolutionScaleRevision,
      ...internalResolutionReport(this.resolutionScale, surface.width, surface.height) };
  }

  /** F1:最新完成读回的逐 pass 计时;尚无读回时显式 unavailable,不伪零。 */
  private passTimingsMetrics(frameNumber: number): PbrFramePassTimings {
    const latest = this.diagnostics.latestPassTimings;
    if (latest) return latest;
    const reason = !this.gpuTimer.enabled ? "诊断采样未启用,逐 pass GPU 计时未采集"
      : !this.gpuTimer.supported ? "设备不支持 timestamp-query,逐 pass GPU 计时不可用"
        : "等待首个逐 pass GPU 时间戳读回";
    return pbrFramePassTimingsUnavailable(frameNumber, reason);
  }

  private sampleAdaptiveQuality(metrics: FrameMetrics): void {
    if (!this.adaptiveQuality) return;
    const snapshot = this.performanceTelemetry.snapshot();
    const cpu = snapshot.stages["frame-encode"], gpu = snapshot.stages["gpu-frame"];
    if (!cpu) return;
    const samples = this.performanceTelemetry.samples("frame-encode");
    this.adaptiveQuality.sample({ frame: metrics.frame, sampleCount: cpu.samples, cpuP95Ms: cpu.p95Ms, cpuP99Ms: cpu.p99Ms,
      ...(gpu ? { gpuP95Ms: gpu.p95Ms, gpuP99Ms: gpu.p99Ms } : {}),
      longFrameCount: samples.filter(value => value > 33.34).length,
      width: metrics.width, height: metrics.height, drawCalls: metrics.drawCalls, triangles: metrics.triangles,
      memory: metrics.deviceResourceMemory ?? this.session.resourceMemory });
  }
  private captureForFrame(size: { readonly width: number; readonly height: number }, transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean): {
    readonly plan: ReturnType<typeof buildPbrFrameExecutionPlan>;
    readonly actual: ReturnType<typeof collectActualPbrFramePasses>;
  } {
    const key = `${size.width}x${size.height}:${transparency ? "transparent" : "opaque"}`
      + `:ao=${postProcess.ambientOcclusion ? 1 : 0}:ssr=${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:fog=${postProcess.volumetricFog ? 1 : 0}:god=${postProcess.volumetricFogProfile.godRaysStrength !== undefined ? 1 : 0}:bloom=${postProcess.bloom ? 1 : 0}:direct=${directDisplay ? 1 : 0}`
      + `:cs=${this.features.contactShadows ? 1 : 0}:up=${this.features.temporalUpscale ? 1 : 0}`;
    if (this.capturePlanKey !== key || !this.capturePlan || !this.captureActualPasses) {
      const captureFeatures: PbrRendererFeatures = Object.freeze({ ...this.features,
        ambientOcclusion: postProcess.ambientOcclusion,
        screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog,
        bloom: postProcess.bloom,
      });
      const opaqueColorResource = postProcess.ambientOcclusion ? "ao-hdr" : "opaque-hdr";
      const plan = buildPbrFrameExecutionPlan(size, { transparency, features: captureFeatures,
        godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
        directDisplay, writeGeometryBuffers: this.writeGeometryBuffers });
      const presentInputResource = this.features.temporalUpscale && !directDisplay ? "upscale-hdr"
        : this.features.contactShadows ? "contact-hdr"
        : postProcess.bloom ? "bloom-hdr"
        : this.features.temporalAa ? "temporal-hdr" : postProcess.screenSpaceReflection ? "ssr-hdr"
          : postProcess.volumetricFog ? "volumetric-fog-hdr"
          : transparency ? "composited-hdr" : opaqueColorResource;
      const actual = collectActualPbrFramePasses(captureFeatures, transparency,
        { opaqueColorResource, presentInputResource, directDisplay, writeGeometryBuffers: this.writeGeometryBuffers,
          godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
          bloom: postProcess.bloom });
      assertPlanMatchesActual(plan, actual);
      this.capturePlan = plan;
      this.captureActualPasses = actual;
      this.capturePlanKey = key;
    }
    return { plan: this.capturePlan, actual: this.captureActualPasses };
  }
  private allocationPlanFor(transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean): RenderGraphCompileResult {
    const key = `${transparency ? 1 : 0}:${postProcess.ambientOcclusion ? 1 : 0}:${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:${postProcess.volumetricFog ? 1 : 0}:${postProcess.volumetricFogProfile.godRaysStrength !== undefined ? 1 : 0}:${postProcess.bloom ? 1 : 0}:${directDisplay ? 1 : 0}`;
    if (this.allocationPlanKey !== key || !this.allocationPlan) {
      this.allocationPlan = compilePbrFrameGraph({ transparency, features: { ...this.features,
        ambientOcclusion: postProcess.ambientOcclusion, screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog, bloom: postProcess.bloom }, directDisplay,
        godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
        writeGeometryBuffers: this.writeGeometryBuffers });
      if (!this.allocationPlan.valid) throw new Error("PBR transient allocation graph is invalid.");
      this.allocationPlanKey = key;
    }
    return this.allocationPlan;
  }
  private executedCapturePassIds(directClear: boolean, postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>,
    transparency: boolean): ReadonlySet<string> {
    const ids = new Set<string>(["opaque"]);
    if (directClear) return ids;
    if (postProcess.ambientOcclusion) { ids.add("ambient-occlusion"); ids.add("apply-ambient-occlusion"); }
    if (postProcess.screenSpaceReflection) { ids.add("screen-space-reflection-trace"); ids.add("screen-space-reflection-composite"); }
    if (transparency) { ids.add("transparent-oit"); ids.add("composite-oit"); }
    if (postProcess.volumetricFog) { ids.add("volumetric-fog-march"); ids.add("volumetric-fog-composite"); }
    if (this.features.temporalAa) ids.add("temporal-aa");
    if (this.features.temporalUpscale) ids.add("temporal-upscale");
    if (postProcess.bloom) ids.add("bloom");
    ids.add("present");
    return ids;
  }
  async validateFrame(view: RenderView): Promise<FrameMetrics> {
    this.deviceEpoch?.assertCurrent(this.session.device);
    return validatePbrFrame(this.session, () => this.render(view), () => {
      this.previousHiZ.invalidate(); this.shadows.invalidate(); this.localShadows.invalidate();
      this.shadowDirty = true; this.historyDirty = true;
    });
  }
  dispose(): void {
    this.probeClipmap?.dispose();
    this.probeRadianceProducer?.dispose();
    this.probeRadianceProducer = undefined;
    this.particlePass?.dispose();
    this.particleRuntime?.dispose();
    const owners = [this.ground.author, this.outputs, this.environment, this.lighting, this.localShadows,
      this.shadowState, this.previousHiZ, this.transparency, this.postProcess, this.packets, this.targets,
      ...(this.visibility ? [this.visibility] : []), ...(this.clusterLodSlot ? [this.clusterLodSlot] : []),
      ...(this.virtualTextures ? [this.virtualTextures] : []),
      ...(this.virtualTileLookup ? [this.virtualTileLookup] : [])];
    // 释放背景排队门：未 release 就销毁的宿主也能让挂起的门禁 promise 结算。
    this.releasePipelines?.();
    runResourceCleanup("PBR renderer cleanup failed.", [...owners.map(owner => () => owner.dispose()),
      () => this.cameraHistory.reset(), () => this.session.dispose()]);
  }
  private sceneChanged(): void { this.shadowDirty = true; this.historyDirty = true; }
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

/** batch 球体 → 屏幕圆盘像素面积(静态代理):focal = height/2 / tan(fov/2),
 *  透视深取 clip w;w≤0 或 NDC z 出 [0,1](WebGPU 口径)显式 0 = 不产反馈。 */
function virtualTextureScreenPixels(geometry: CachedPacketGeometry, viewProjection: Float32Array,
  verticalFovRadians: number, size: { readonly width: number; readonly height: number }): number {
  const [cx, cy, cz] = geometry.center;
  const w = viewProjection[3]! * cx + viewProjection[7]! * cy + viewProjection[11]! * cz + viewProjection[15]!;
  if (!(w > 0)) return 0;
  const z = viewProjection[2]! * cx + viewProjection[6]! * cy + viewProjection[10]! * cz + viewProjection[14]!;
  if (z < 0 || z > w) return 0;
  const focal = size.height / (2 * Math.tan(verticalFovRadians / 2));
  const radiusPx = geometry.radius * focal / w;
  return Math.PI * radiusPx * radiusPx;
}
