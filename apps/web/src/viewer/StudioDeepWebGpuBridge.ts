import type {
  DeepWebGpuBackend,
  DeepWebGpuSyncResult,
  ThreeObjectSource,
} from "@bim-studio/deep-engine/three-bridge";
import type { AuthoredQualityProfile, HdrDisplayRequest } from "@bim-studio/deep-engine/webgpu";
import { publishStudioQualityTelemetry, type StudioDeepQualityTelemetrySampler } from "./StudioDeepQualityTelemetry";
import { StudioDeepRenderView } from "./StudioDeepRenderView";
import { StudioDeepEnvironmentCache } from "./StudioDeepEnvironmentCache";
import { StudioDeepAuthorPacketSync } from "./StudioDeepAuthorPacketSync";
import { prepareStudioAuthorPacket } from "./prepareStudioAuthorPacket";
import { StudioDeepInactiveCandidate } from "./StudioDeepInactiveCandidate";
import { trimInactiveDeepCandidate, supportsInactiveMaterialProfile, type InactiveDeepCandidate } from "./trimInactiveDeepCandidate";
import { prepareStudioRendererCandidate } from "./prepareStudioRendererCandidate";
import { isStudioDeepEnvironmentSourceCurrent } from "./studioDeepEnvironmentSource";
import type { ViewerEngine } from "./ViewerEngine";
import type { RendererBackend } from "./viewerTypes";
import { recoveredAttemptCount } from "./studioRecoveryCandidate";
import { TemporalFrameSettler } from "./temporalFrameSettler";
import { StudioDeepFrameQueue } from "./StudioDeepFrameQueue";
import type { PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";
import type { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import type { StudioDeepShadowSession } from "./StudioDeepShadowSession";
import type { StudioDeepPerformance } from "./StudioDeepPerformance";
import { StudioDeformationPoseSync } from "./studioDeformationPoseSync";
import { StudioDeepOutlineSync } from "./studioDeepOutlineSync";
import { sameHostCameraPose, type DeepCameraController } from "./deepCameraController";
import type { DeepCameraInputSession } from "./deepCameraInputSession";
import { DeepGizmoInteraction } from "./deepGizmoInteraction";
import { createDeepCanvas, prepareAuthorInputCanvas, captureAuthorStyle, restoreAuthorStyle,
  type AuthorCanvasStyle } from "./studioDeepPresentationCanvas";
import { collectDeepOverlayPrimitives } from "./deepOverlayPrimitiveSource";
import { isAlphaToCoverageRejection, isDeepAdvancedMaterialsRejection, packetUsesDeepAdvancedMaterials,
  resolveAlphaToCoverageCreateModes } from "./studioDeepAdvancedMaterials";
import type { FrameCaptureSession, RenderPacket } from "@bim-studio/deep-engine";
import { publishDeepPresentation, publishWebGlPresentation, releaseDeepPresentation,
  type StudioDeepBridgePresentationHost } from "./studioDeepWebGpuBridgePresentation";
import { flowProbe, recordProbeSample, type DeepFlowProbe } from "./studioDeepWebGpuBridgeFlowProbe";
import { cameraSnapshot, renderViewFingerprint, sameSnapshot,
  nextFrame, type BridgeModuleLoader, type RuntimeSession, type DeepRenderView } from "./studioDeepWebGpuBridgeSceneHelpers";
import { markSwitchPhase } from "./studioDeepWebGpuBridgeFeatureToggles";
import type { StudioDeepWebGpuBridgeOptions, StudioRendererSwitchResult } from "./studioDeepWebGpuBridgeOptions";
import { prepareStudioDeepSwitchCandidate, type StudioDeepBridgeSwitchHost,
  type StudioDeepSwitchCandidateFrame } from "./studioDeepWebGpuBridgeSwitchCandidate";

export { t11PipelineBootstrap, t07DynamicResolutionPolicy, b4HlodClusterEnabled, g1ClusterLodEnabled,
  t25GpuPassTimingEnabled, f4TemporalUpscaleEnabled, f3VirtualTexturesEnabled, sdfGiEnabled, ssgiEnabled,
  projectedTexturesEnabled, megaLightsEnabled, rayTracedShadowsEnabled, rayTracedReflectionsEnabled } from "./studioDeepWebGpuBridgeFeatureToggles";
export type { StudioDeepWebGpuBridgeOptions, StudioRendererSwitchResult } from "./studioDeepWebGpuBridgeOptions";

/**
 * Studio 保留唯一的 WebGL 作者 Viewer，Deep 只持有可重建的投影快照和独立画布。
 * 候选画布通过首帧验证后才显示；作者画布始终保留输入和场景状态。
 */
export class StudioDeepWebGpuBridge {
  private readonly loadModule: BridgeModuleLoader;
  private readonly authorCanvas: HTMLCanvasElement;
  private readonly authorStyle: AuthorCanvasStyle;
  private activeBackendValue: RendererBackend = "webgl";
  private deepBackend: DeepWebGpuBackend | undefined;
  private deepCanvas: HTMLCanvasElement | undefined;
  private pending: AbortController | undefined;
  private unsubscribeFrame: (() => void) | undefined;
  private generation = 0;
  private presentationGeneration = 0;
  private syncPending: DeepWebGpuBackend | undefined;
  private syncAgain: DeepWebGpuBackend | undefined;
  private lastCameraSnapshot: readonly number[] | undefined;
  private cameraSettleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private failureReported = false;
  private environmentSession: StudioDeepEnvironmentSession | undefined;
  private shadowSession: StudioDeepShadowSession | undefined;
  private performanceSource: StudioDeepPerformance | undefined;
  private quality: StudioDeepQualityTelemetrySampler | undefined;
  private qualityProfile: AuthoredQualityProfile | null = null;
  private frameCaptureSession: FrameCaptureSession | undefined;
  private readonly viewReader: StudioDeepRenderView;
  private readonly environmentCache = new StudioDeepEnvironmentCache();
  private readonly authorPacketSync = new StudioDeepAuthorPacketSync();
  private readonly inactive = new StudioDeepInactiveCandidate<InactiveDeepCandidate>(null);
  private inactiveAuthorKey: string | undefined;
  private warmup: Promise<StudioRendererSwitchResult> | undefined;
  private backgroundPreparation = false;
  private projectionBridge: import("@bim-studio/deep-engine/three-bridge").ThreeProjectionBridge | undefined;
  private readonly temporalSettler = new TemporalFrameSettler({ initialDelayFrames: 1,
    onSettled: () => this.performanceSource?.pause(), onError: reason => this.failRuntime(reason) });
  private readonly cameraFrameInFlightLimit: 1 | 2;
  private cameraFramesInFlight = 0;
  private pendingCameraView: DeepRenderView | undefined;
  private cameraFramesSubmitted = 0;
  private cameraFramesCoalesced = 0;
  private cameraMaxInFlight = 0;
  private readonly frameQueue: StudioDeepFrameQueue<DeepWebGpuBackend>;
  /** F5-L4 探针捕获心跳泵:探针仍有捕获欠账时的一条自终止 RAF 心跳。渲染帧曾是
   * 唯一捕获驱动,静置场景因此饿死捕获,GI 采样回退全量 IBL(门态无关洗光)。 */
  private probePumpArmed = false;
  private controller: DeepCameraController | undefined;
  private inputSession: DeepCameraInputSession | undefined;
  private gestureActive = false;
  private lastGestureTickAt: number | undefined;
  /** 控制器最后写回/采纳的姿态:区分"手势收敛中"与"宿主程序性变更"(与 WASM 桥同族)。 */
  private lastAppliedPose: import("./deepCameraController").CameraPose | undefined;
  private readonly gizmoInteraction: DeepGizmoInteraction;
  private independentPacketPath = false;
  private pendingDeformationPacket: RenderPacket | undefined;
  private deformationSync: StudioDeformationPoseSync | undefined;
  /** 独立包路径的描边实时同步(勾选"轮廓"/选中变化 → 仅翻转实例 outline 位)。 */
  private outlineSync: StudioDeepOutlineSync | undefined;
  /** 最近一次提交的 view 指纹:settle 背压只对相同指纹的重绘生效。 */
  private settledViewKey = "";
  /** 上次读到的 renderDemand 修订号:静置短路的变化信号(不可用时为 -1)。 */
  private lastDemandRevision = -1;
  /** 构造期冻结 HDR 请求，异步设备创建与后续切换使用同一份配置。 */
  private readonly hdrDisplayRequest: HdrDisplayRequest | undefined;
  private replacementBudget: number | undefined;
  /** 当前 backend 是否以 advancedMaterials 变体创建(创建时判定,见 switchTo)。 */
  private advancedMaterialsActive = false;
  /** 编辑中新激活高级 lobe 后受控重建的粘性请求:此后每次创建都带变体,直到 bridge 释放。 */
  private advancedMaterialsRequested = false;
  /** 当前 backend 是否以 alphaToCoverage 能力门创建(创建时判定,见 switchTo)。 */
  private alphaToCoverageActive = false;
  /** 编辑中新出现 a2c 材质后受控重建的粘性请求:此后每次创建都带能力门,直到 bridge 释放。 */
  private alphaToCoverageRequested = false;
  /** 当前 backend 是否以 a2c maskFallback 降级档创建(创建时判定,见 switchTo)。 */
  private a2cMaskFallbackActive = false;
  /** 渲染器探针判 a2c 掩码未生效后的粘性降级请求:此后每次创建都不带 a2c 能力门,
   * 改投 alphaToCoverageMaskFallback(材质 → MASK@cutoff),直到 bridge 释放。 */
  private a2cMaskFallbackRequested = false;
  private recoveryCandidateFailure: { readonly generation: number; readonly attempts: number } | undefined;

  constructor(
    private readonly viewer: ViewerEngine,
    private readonly container: HTMLElement,
    private readonly options: StudioDeepWebGpuBridgeOptions = {},
  ) {
    this.viewReader = new StudioDeepRenderView(viewer, container, () => this.environmentSession, () => this.shadowSession);
    // Deep 原生编辑辅助图形(切片 A/B/C):选择盒/测量线段/gizmo 顶点由 Deep 自有通道生成,
    // 注册进渲染视图的 overlay 合并点;Three 侧对应 helper 的 CPU 投影由
    // getDeepEditorOverlayRoots 在 webgpu 呈现后端下排除,WebGL 呈现不受影响。
    this.viewReader.setDeepOverlayPrimitiveSource((width, height, pixelRatio) =>
      collectDeepOverlayPrimitives(this.viewer, width, height, pixelRatio));
    this.loadModule = options.loadModule ?? (() => import("@bim-studio/deep-engine/three-bridge"));
    this.cameraFrameInFlightLimit = options.cameraFrameInFlightLimit ?? 2;
    this.frameQueue = new StudioDeepFrameQueue(this.cameraFrameInFlightLimit,
      backend => !this.closed && this.deepBackend === backend, reason => this.failRuntime(reason), () => {
        const stats = this.frameQueue.stats;
        this.cameraFramesInFlight = stats.inFlight; this.cameraMaxInFlight = stats.maxInFlight;
        this.cameraFramesSubmitted = stats.submitted; this.cameraFramesCoalesced = stats.coalesced;
        if (!stats.pendingLatest) this.pendingCameraView = undefined;
      });
    this.hdrDisplayRequest = options.hdrDisplay === undefined ? undefined : Object.freeze({ ...options.hdrDisplay });
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
    this.gizmoInteraction = new DeepGizmoInteraction(viewer, () => this.authorCanvas.getBoundingClientRect());
    prepareAuthorInputCanvas(this.authorCanvas);
  }

  get activeBackend(): RendererBackend { return this.activeBackendValue; }
  get retainedGpuBytes(): number {
    const session = this.deepBackend?.runtime.session as (RuntimeSession & { resourceMemory?: { estimatedBytes: number } }) | undefined;
    return session?.resourceMemory?.estimatedBytes ?? this.inactive.retainedBytes;
  }

  get diagnostics() {
    if (!this.deepBackend) return undefined;
    const backend = this.deepBackend.diagnostics;
    return { ...(backend ?? {}), ...(this.deepBackend.runtime.hdrDisplay ? { hdrDisplay: this.deepBackend.runtime.hdrDisplay } : {}), cameraFlow: { inFlight: this.cameraFramesInFlight,
      maxInFlight: this.cameraMaxInFlight, submitted: this.cameraFramesSubmitted,
      coalesced: this.cameraFramesCoalesced, pendingLatest: this.pendingCameraView !== undefined,
      limit: this.cameraFrameInFlightLimit } };
  }

  cancelPendingSwitch(preservePreparation = false): void {
    this.presentationGeneration++;
    if (preservePreparation && this.warmup) return;
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }

  switchTo(target: RendererBackend,
    beforePublish?: (signal: AbortSignal) => Promise<void>): Promise<StudioRendererSwitchResult> {
    if (target === this.activeBackendValue && this.warmup) return Promise.resolve(this.result("unchanged"));
    if (target === "webgpu" && this.warmup) {
      const generation = this.generation, presentation = this.presentationGeneration;
      return this.warmup.then(() => generation === this.generation && presentation === this.presentationGeneration && !this.closed
        ? this.runSwitch(target, beforePublish) : this.result("cancelled"));
    }
    return this.runSwitch(target, beforePublish);
  }

  /** Keep a validated GPU candidate for the current scene; never publish it in the background. */
  prewarm(signal: AbortSignal): Promise<StudioRendererSwitchResult> {
    if (this.warmup) return this.warmup;
    if (this.pending) return Promise.resolve(this.result("cancelled"));
    if (this.activeBackendValue === "webgpu" || (this.inactive.available
      && this.inactiveAuthorKey === this.options.authorPacketKey?.())) return Promise.resolve(this.result("unchanged"));
    signal.throwIfAborted();
    const abort = () => this.cancelPendingSwitch();
    signal.addEventListener("abort", abort, { once: true });
    this.backgroundPreparation = true;
    const task = this.runSwitch("webgpu", undefined, true).finally(() => {
      signal.removeEventListener("abort", abort);
      this.backgroundPreparation = false;
      if (this.warmup === task) this.warmup = undefined;
    });
    this.warmup = task;
    return task;
  }

  private async runSwitch(target: RendererBackend,
    beforePublish?: (signal: AbortSignal) => Promise<void>, prepareOnly = false): Promise<StudioRendererSwitchResult> {
    const replacementBudget = this.replacementBudget;
    this.replacementBudget = undefined;
    this.recoveryCandidateFailure = undefined;
    if (this.closed) return this.result("failed", "Renderer bridge is disposed.");
    this.cancelPendingSwitch();
    const generation = this.generation;
    if (target === this.activeBackendValue) return this.result("unchanged");
    if (target === "webgl") {
      const controller = new AbortController();
      this.pending = controller;
      try {
        await nextFrame(controller.signal);
        if (this.closed || generation !== this.generation) return this.result("cancelled");
        const park = await this.prepareInactiveParking();
        controller.signal.throwIfAborted();
        this.publishWebGl(park);
        return this.result("switched");
      } catch (reason) {
        if (controller.signal.aborted) return this.result("cancelled");
        return this.result("failed", reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (this.pending === controller) this.pending = undefined;
      }
    }
    if (!("gpu" in navigator) || !navigator.gpu) return this.result("failed", "WebGPU is unavailable in this browser.");

    const controller = new AbortController();
    this.pending = controller;
    markSwitchPhase("deep-webgpu:switch-start");
    const authorKey = this.options.authorPacketKey?.();
    let warm = this.inactive.take();
    const canvas = warm?.canvas ?? createDeepCanvas(this.container);
    canvas.dataset.rendererPreparing = "true";
    // 单次事务内 create 写入、尾部与 finally 读回的可变局部量(原 switchTo 闭包 let)。
    const frame: StudioDeepSwitchCandidateFrame = { environment: undefined, shadowMapSize: 1024,
      frameCaptureSession: undefined, candidateObserver: undefined };
    // create/prepare 候选事务本体在 studioDeepWebGpuBridgeSwitchCandidate(本桥实例
    // 以类型层映射传入,字段读写语义与桥内一致)。
    try {
      let warmPacket: RenderPacket | undefined;
      try {
        warmPacket = warm ? await this.options.authorRenderPacket!(controller.signal) : undefined;
        controller.signal.throwIfAborted();
      } catch (error) {
        try { warm?.backend.dispose(); } finally { canvas.remove(); }
        return this.result(controller.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
      }
      if (warm) {
        const modes = resolveAlphaToCoverageCreateModes({ requested: this.alphaToCoverageRequested, authorRenderPacket: warmPacket, scene: this.viewer.scene,
          maskFallbackActive: this.a2cMaskFallbackRequested });
        if (!warmPacket || (packetUsesDeepAdvancedMaterials(warmPacket) && !this.advancedMaterialsActive)
          || (warmPacket && !supportsInactiveMaterialProfile(warm.backend, warmPacket))
          || (modes.alphaToCoverage && !this.alphaToCoverageActive)
          || (modes.a2cMaskFallback && !this.a2cMaskFallbackActive)) {
          warm.backend.dispose(); warm = undefined;
        }
      }
      const prepared = warm ? await prepareStudioRendererCandidate({ signal: controller.signal,
        timeoutMs: this.options.preparationTimeoutMs ?? 30_000, loadModule: async () => undefined,
        create: async () => warm!.backend,
        prepare: async (backend, signal) => {
          markSwitchPhase("deep-webgpu:inactive-reused");
          this.qualityProfile = warm!.qualityProfile; this.independentPacketPath = true;
          if (!prepareOnly) this.viewer.setAuthorPacketIndependent(true);
          let packet = warmPacket!;
          this.viewReader.setIndependentPacketBounds(packet);
          if (packet !== warm!.packet || warm!.sceneResourcesEvicted) {
            packet = (warm!.deformationSync ?? StudioDeformationPoseSync.create(warm!.packet, this.viewer))?.prepareReplacement(packet, this.viewer) ?? packet;
            if (warm!.sceneResourcesEvicted) await backend.prepareRenderPacket(packet, this.viewReader.renderViewDirect(canvas), signal);
            else await prepareStudioAuthorPacket(backend, warm!.packet, packet, this.viewReader.renderViewDirect(canvas), signal);
            warm!.sceneResourcesEvicted = false;
            this.authorPacketSync.seed(backend, warmPacket!);
            warm!.deformationSync = StudioDeformationPoseSync.create(packet, this.viewer); warm!.packet = warmPacket!;
          }
          await backend.prepareView(this.viewReader.renderViewDirect(canvas), signal, true);
          frame.environment = warm!.environment; frame.shadowMapSize = warm!.shadowMapSize;
          this.pendingDeformationPacket = packet.deformation ? packet : undefined;
        }, dispose: backend => backend.dispose(), removeCanvas: () => canvas.remove(),
      }) : await prepareStudioDeepSwitchCandidate(this as unknown as StudioDeepBridgeSwitchHost, canvas,
        controller.signal, generation, replacementBudget, this.options.preparationTimeoutMs ?? 30_000, frame);
      if (prepared.status !== "ready") {
        if (warm) this.viewer.setAuthorPacketIndependent(false);
        return this.result(prepared.status, prepared.error?.message);
      }
      const backend = prepared.value;
      if (authorKey !== undefined && this.options.authorPacketKey?.() !== authorKey) {
        try { backend.dispose(); } finally { canvas.remove(); }
        return this.result("failed", "场景在 WebGPU 准备期间改变，请重试。");
      }
      try {
        controller.signal.throwIfAborted();
        await beforePublish?.(controller.signal);
      } catch (reason) {
        try { backend.dispose(); } finally { canvas.remove(); }
        if (controller.signal.aborted) return this.result("cancelled");
        return this.result("failed", reason instanceof Error ? reason.message : String(reason));
      }
      if (this.closed || controller.signal.aborted || generation !== this.generation) {
        try { backend.dispose(); } finally { canvas.remove(); }
        return this.result("cancelled");
      }
      if (prepareOnly) {
        const packet = this.authorPacketSync.current(backend);
        const runtime = backend.runtime as { releaseIdleResources?(): number;
          gpuTimer?: { releaseIdleResources?(): Promise<void> }; session?: RuntimeSession & {
          resourceMemory?: { estimatedBytes: number; unknownResources: number } } };
        await runtime.gpuTimer?.releaseIdleResources?.();
        if (this.closed || controller.signal.aborted || generation !== this.generation) {
          try { backend.dispose(); } finally { canvas.remove(); }
          return this.result("cancelled");
        }
        runtime.releaseIdleResources?.();
        const memory = runtime.session?.resourceMemory;
        const bytes = memory?.unknownResources === 0 ? memory.estimatedBytes : Number.NaN;
        if (!packet || !frame.environment || !this.retainInactive({ backend, canvas, packet,
          environment: frame.environment, shadowMapSize: frame.shadowMapSize, qualityProfile: this.qualityProfile,
          deformationSync: warm?.deformationSync ?? StudioDeformationPoseSync.create(this.pendingDeformationPacket ?? packet, this.viewer) }, bytes)) {
          try { backend.dispose(); } finally { canvas.remove(); }
          return this.result("failed", `后台渲染器未保留：资源 ${bytes} 字节，未知资源 ${memory?.unknownResources}，设备 ${runtime.session?.state}，场景 ${!!packet}，环境 ${!!frame.environment && isStudioDeepEnvironmentSourceCurrent(this.viewer.scene, frame.environment)}。`);
        }
        markSwitchPhase("deep-webgpu:prewarmed");
        return this.result("switched");
      }
      this.publishDeep(canvas, backend, frame.environment!, frame.shadowMapSize, frame.frameCaptureSession);
      if (warm?.deformationSync && warmPacket === warm.packet) this.deformationSync = warm.deformationSync;
      const currentPacket = this.authorPacketSync.current(backend);
      if (currentPacket) this.viewReader.setIndependentPacketBounds(currentPacket);
      markSwitchPhase("deep-webgpu:published");
      return this.result("switched");
    } finally {
      frame.candidateObserver?.dispose();
      if (this.pending === controller) this.pending = undefined;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.inactive.clear();
    this.environmentCache.clear();
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    try { this.releaseDeep(); } finally {
      restoreAuthorStyle(this.authorCanvas, this.authorStyle);
      this.activeBackendValue = "webgl";
      this.viewer.setPresentationRendererBackend("webgl");
    }
  }

  private publishDeep(canvas: HTMLCanvasElement, backend: DeepWebGpuBackend, environment: PreparedStudioDeepEnvironment,
    shadowMapSize: number, frameCaptureSession: FrameCaptureSession | undefined): void {
    this.frameQueue.reset();
    publishDeepPresentation(this as unknown as StudioDeepBridgePresentationHost, canvas, backend, environment, shadowMapSize, frameCaptureSession);
  }

  private publishWebGl(park = false): void {
    this.frameQueue.reset();
    this.authorPacketSync.cancel();
    const backend = this.deepBackend, canvas = this.deepCanvas, environment = this.environmentSession?.prepared();
    const packet = backend && this.authorPacketSync.current(backend);
    const session = backend?.runtime.session as (RuntimeSession & { resourceMemory?: { estimatedBytes: number; unknownResources: number } }) | undefined;
    const bytes = session?.resourceMemory?.unknownResources === 0 ? session.resourceMemory.estimatedBytes : Number.NaN;
    const canPark = park && backend?.usesIndependentPacket === true && canvas && packet && environment
      && this.options.authorRenderPacket && !this.syncPending && Number.isFinite(bytes);
    if (park) markSwitchPhase(`deep-webgpu:inactive-park-${canPark ? "eligible" : "rejected"}-bytes-${bytes}-unknown-${session?.resourceMemory?.unknownResources}-pending-${!!this.syncPending}`);
    const shadowMapSize = this.shadowSession?.mapSize ?? 1024, qualityProfile = this.qualityProfile;
    const deformationSync = this.deformationSync;
    publishWebGlPresentation(this as unknown as StudioDeepBridgePresentationHost, !!canPark);
    if (!canPark || !backend || !canvas || !packet || !environment) return;
    canvas.style.opacity = "0"; canvas.style.visibility = "hidden";
    if (!this.retainInactive({ backend, canvas, packet, environment, shadowMapSize, qualityProfile,
      ...(deformationSync ? { deformationSync } : {}) }, bytes)) {
      try { backend.dispose(); } finally { canvas.remove(); }
    }
  }

  private retainInactive(candidate: InactiveDeepCandidate, bytes: number): boolean {
    bytes = trimInactiveDeepCandidate(candidate, bytes);
    const { backend, canvas, environment } = candidate;
    const session = backend.runtime.session as RuntimeSession | undefined;
    const settings = JSON.stringify(this.viewer.getPostProcessing());
    this.inactiveAuthorKey = this.options.authorPacketKey?.();
    return this.inactive.retain(candidate, bytes,
      () => {
        return session?.state === "ready"
          && JSON.stringify(this.viewer.getPostProcessing()) === settings
          && isStudioDeepEnvironmentSourceCurrent(this.viewer.scene, environment);
      },
      () => { try { backend.dispose(); } finally { canvas.remove(); } }, invalidate => {
        const unsubscribe = this.viewer.subscribePresentationFrames(() => this.inactive.check());
        const loss = backend.onFatalLoss?.(invalidate);
        // Promise listeners cannot unsubscribe; release the candidate captured by invalidate on transfer.
        let notifyLoss: (() => void) | undefined = invalidate;
        void session?.device?.lost.then(() => notifyLoss?.());
        return () => { notifyLoss = undefined; unsubscribe(); loss?.(); };
      });
  }

  private async prepareInactiveParking(): Promise<boolean> {
    if (!this.deepBackend?.usesIndependentPacket || !this.options.authorRenderPacket) return false;
    const backend = this.deepBackend;
    const runtime = backend.runtime as { gpuTimer?: { releaseIdleResources?(): Promise<void> }; releaseIdleResources?(): number } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.authorPacketSync.whenIdle().then(async () => {
        await runtime?.gpuTimer?.releaseIdleResources?.();
        if (this.closed || this.deepBackend !== backend) return false;
        runtime?.releaseIdleResources?.(); return true;
      }), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 80); })]);
    } finally { clearTimeout(timer); }
  }

  private releaseDeep(): void { this.frameQueue.reset(); this.authorPacketSync.dispose(); releaseDeepPresentation(this as unknown as StudioDeepBridgePresentationHost); }

  private replaceRecoveredBackend(backend: DeepWebGpuBackend): void {
    if (this.closed || this.deepBackend !== backend) return;
    const userSwitchPending = this.pending !== undefined;
    let usedAttempts = recoveredAttemptCount(backend);
    const maxAttempts = this.options.recovery?.maxAttempts ?? 3;
    this.cancelPendingSwitch();
    try { this.publishWebGl(); }
    catch (error) { this.options.onRuntimeFailure?.(error instanceof Error ? error : new Error(String(error))); return; }
    if (userSwitchPending) return;
    // The candidate transaction creates every GPU owner and validates its first
    // frame. A recovered DeviceSession cannot reuse the old resource graph.
    const replace = async (): Promise<void> => {
      while (!this.closed && usedAttempts <= maxAttempts) {
        this.replacementBudget = maxAttempts - usedAttempts;
        const replacement = this.switchTo("webgpu"), generation = this.generation;
        let result: StudioRendererSwitchResult;
        try { result = await replacement; }
        catch (error) { result = this.result("failed", error instanceof Error ? error.message : String(error)); }
        if (this.closed || generation !== this.generation || result.status === "cancelled") return;
        if (result.status !== "failed") return;
        const lost = this.recoveryCandidateFailure;
        if (lost?.generation === generation) {
          usedAttempts += lost.attempts;
          if (usedAttempts <= maxAttempts) continue;
        }
        if (this.activeBackendValue === "webgl") this.options.onRuntimeFailure?.(new Error(result.error ?? "GPU renderer replacement failed."));
        return;
      }
    };
    void replace();
  }

  private readonly renderPresentationFrame = (): void => {
    this.applyGesturePose();
    // The presenter owns the scene traversal. Refresh only the tiny camera
    // node here so direct test/host callbacks and late controls events cannot
    // expose a stale matrixWorld, without forcing the whole author tree again.
    this.viewer.camera.updateMatrixWorld(true);
    this.renderDeepFrame(true);
  };

  private readonly renderDeepFrame = (authorMatricesCurrent = false): void => {
    const probe = flowProbe();
    if (probe) { probe.renderDeepFrame++; recordProbeSample(probe, "rdf"); }
    const backend = this.deepBackend;
    const canvas = this.deepCanvas;
    if (this.closed || this.activeBackendValue !== "webgpu" || !backend || !canvas) return;
    try {
      // presentViewerFrame already updates author matrices/LOD before notifying
      // the external renderer. Keep the explicit path for environment/shadow
      // callbacks and trailing syncs which can run outside an author frame.
      if (!authorMatricesCurrent) this.updateAuthorMatrices();
      // Three AnimationMixer 已在作者帧推进;把骨骼/形变姿态读成 Deep 姿态。姿态变化即视为新画面,
      // 清除静置指纹以绕过 TAA 收敛背压,保证动画每帧都被绘制。
      // Instance mutations cancel PacketBuffers' pending full candidate. Keep drawing
      // the retained packet during author replacement; the rebound pose owner catches up.
      if (this.syncPending !== backend && this.deformationSync?.apply(backend)) this.settledViewKey = "";
      if (this.syncPending !== backend && this.outlineSync?.apply(backend, this.viewer, () => {
        // 流送包的实例位异步落地:完成后补绘一帧。
        if (this.deepBackend !== backend) return;
        this.settledViewKey = ""; this.renderDeepFrame();
      })) this.settledViewKey = "";
      const demand = this.viewer.getRenderDemandDiagnostics?.();
      this.viewReader.setSceneRevision(demand?.invalidationRevision);
      const camera = cameraSnapshot(this.viewer);
      if (probe) recordProbeSample(probe, "cam", camera[0]!, camera[1]!, camera[3]!, camera[4]!);
      const cameraChanged = !sameSnapshot(camera, this.lastCameraSnapshot);
      this.lastCameraSnapshot = camera;
      const shouldSync = !cameraChanged;
      if (!shouldSync) {
        this.temporalSettler.cancel();
        if (probe) probe.cameraPath++;
        if (this.syncPending === backend) this.syncAgain = backend;
        // Camera input can arrive every author frame. Render only the latest view
        // while the gesture is active; restarting the temporal settle sequence on
        // every pointer sample doubles/triples GPU work and makes WebGPU lag input.
        this.renderLatestCameraFrame(backend, canvas);
        this.scheduleCameraSettle();
        return;
      }
      if (probe) probe.syncPath++;
      this.cancelCameraSettle();
      if (!cameraChanged) this.viewReader.invalidateProjectionBounds();
      // 静置短路:intrinsic 连续源让渲染循环每帧走到这里,但相机与场景都未变。
      // 编辑/资源/相机复位必然经 renderDemand.invalidate 递增修订号;修订与呈现
      // 指纹都未变时跳过 sync 与首绘,静置负载归零。修订号不可用(测试宿主/旧
      // 集成)时保守视为"可能变化",维持每帧 sync 的既有行为。
      { const p2 = flowProbe(); if (p2) (p2 as DeepFlowProbe & { demand?: unknown }).demand = demand; }
      const demandRevision = demand?.invalidationRevision;
      const sceneMutated = demandRevision === undefined
        || demandRevision !== this.lastDemandRevision;
      this.lastDemandRevision = demandRevision ?? -1;
      const viewStart = probe ? performance.now() : 0;
      const view = this.viewReader.renderViewDirect(canvas);
      if (probe) probe.viewMs += performance.now() - viewStart;
      const viewKey = renderViewFingerprint(view);
      { const p2 = flowProbe(); if (p2) { p2.shortCircuits = (p2.shortCircuits ?? 0) + (viewKey === this.settledViewKey && !sceneMutated ? 1 : 0); p2.keyChanges = (p2.keyChanges ?? 0) + (viewKey !== this.settledViewKey ? 1 : 0); } }
      // 连续活动(动画/物理/特效/交互脚本)期间逐帧场景内容可能变化且不入指纹,
      // 保持既有每帧 sync 行为;只有完全静置(无修订、无活动、指纹不变)才短路。
      if (!sceneMutated && demand?.intrinsicActive !== true
        && !this.syncPending && viewKey === this.settledViewKey) {
        return;
      }
      this.temporalSettler.cancel();
      // An immutable RenderPacket backend has no author hierarchy to sync. The
      // generic sync call is intentionally retained for the legacy Three path,
      // but awaiting its already-committed no-op here adds a promise turn to
      // every settled frame and widens pointer-to-submit latency. Render the
      // packet directly while preserving the same bounded TAA settle sequence.
      if (backend.usesIndependentPacket === true
        || (backend.usesIndependentPacket === undefined && this.options.authorRenderPacket !== undefined)) {
        if (sceneMutated && demandRevision !== undefined && this.options.authorRenderPacket
          && typeof backend.prepareRenderPacket === "function") {
          if (this.syncPending) { this.syncAgain = backend; }
          else {
            this.syncPending = backend;
            void this.authorPacketSync.refresh(backend, this.options.authorRenderPacket,
              () => this.viewReader.renderViewDirect(canvas),
              packet => this.deformationSync?.prepareReplacement(packet, this.viewer) ?? packet).then(packet => {
              if (this.deepBackend !== backend) return;
              if (packet) {
                this.viewReader.setIndependentPacketBounds(packet);
                this.deformationSync = StudioDeformationPoseSync.create(packet, this.viewer);
                this.outlineSync = new StudioDeepOutlineSync(); this.settledViewKey = "";
              }
              this.renderCommittedFrame(backend, canvas, this.viewReader.renderViewDirect(canvas));
            }).catch(reason => { if (this.deepBackend === backend) this.failRuntime(reason); })
              .finally(() => {
                if (this.syncPending !== backend) return;
                this.syncPending = undefined;
                if (this.syncAgain === backend) { this.syncAgain = undefined; this.lastDemandRevision = -1; this.renderDeepFrame(); }
              });
          }
        }
        this.renderCommittedFrame(backend, canvas, view);
        return;
      }
      // 一帧一提交节流:发起 sync 的帧不在同步路径预画同一 view。sync 完成后的
      // renderCommittedFrame 才是这份 view 的唯一呈现(资源上传后的画面)。尾随与
      // 资源 sync 只发生在相机静止之后,呈现晚一个 sync 周期不可感知;手势进行中
      // 走相机路径,不经过这里。
      if (!this.syncPending) {
        this.syncPending = backend;
        const syncStart = probe ? performance.now() : 0;
        const syncPromise = backend.sync(this.projectionRoot(), this.viewer.camera.layers.mask, undefined, view);
        if (probe) syncPromise.finally(() => { probe.syncCount = (probe.syncCount ?? 0) + 1; probe.syncMs = (probe.syncMs ?? 0) + performance.now() - syncStart; });
        void syncPromise
          .then((result) => {
            if (this.deepBackend !== backend) return;
            this.acceptSyncResult(result);
            // 新作者帧已绘制时，由 finally 追上最新状态，禁止回放旧相机和选择修订。
            if (this.syncAgain !== backend) this.renderCommittedFrame(backend, canvas, view);
          })
          .catch((reason) => {
            if (this.deepBackend === backend) this.failRuntime(reason);
          })
          .finally(() => {
            if (this.syncPending !== backend) return;
            this.syncPending = undefined;
            if (this.syncAgain === backend) {
              this.syncAgain = undefined;
              this.renderDeepFrame();
            }
          });
      } else {
        // sync 在飞期间的唯一画面推进:按最新 view 直绘,不重复发起 sync。
        this.syncAgain = backend;
        this.renderCommittedFrame(backend, canvas, view);
      }
    } catch (reason) {
      this.failRuntime(reason);
    }
  };

  private renderLatestCameraFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement,
    // 相机手势帧:true 启用 viewReader 的场景字段缓存(200ms TTL),场景编辑由
    // 尾随 sync 以全量 source 追平;实测场景遍历是输入拖尾的主嫌疑之一。
    view = this.viewReader.renderViewDirect(canvas, true)): void {
    const probe = flowProbe();
    if (!this.renderCommittedFrame(backend, canvas, view, false) && probe) probe.coalesced++;
  }

  private renderCommittedFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement,
    view = this.viewReader.renderViewDirect(canvas), settle = true): boolean {
    settle = settle && view.authorDirectDisplay !== true;
    // 首绘保留唯一最新 view；TAA 重绘仅重试，所有路径共享真实 GPU completion 上限。
    let settling = false;
    const viewKey = renderViewFingerprint(view);
    const draw = (): boolean => {
      const latest = !settling;
      return this.frameQueue.submit(backend, () => {
        settling = true;
        this.settledViewKey = viewKey;
        const probe = flowProbe();
        backend.setProbeClipmapEnabled(this.probeClipmapEnabled());
        const renderStart = probe ? performance.now() : 0;
        const metrics = backend.render(view);
        if (probe) { probe.draws++; probe.renderMs += performance.now() - renderStart; }
        if (metrics) {
          this.performanceSource?.record(metrics, view.width, document.visibilityState !== "hidden");
          // T25:帧循环唯一采集点;true = 完成一次聚合落账,发布最新遥测状态。
          if (this.quality?.record(metrics) === true) publishStudioQualityTelemetry(this.quality.status());
          // A2C-P1:宿主收到 ineffective 探针后在帧回调之外受控重建。
          if (metrics.a2cProbe?.verdict === "ineffective" && this.alphaToCoverageActive
            && !this.a2cMaskFallbackActive && !this.a2cMaskFallbackRequested) {
            setTimeout(() => { if (!this.closed) this.restartWithAlphaToCoverageMaskFallback(); }, 0);
          }
        }
        this.shadowSession?.acknowledgeMapSize(metrics?.shadowMapSize);
        this.pumpProbeCapture();
        const session = (backend.runtime as { session?: RuntimeSession }).session;
        if (!metrics && session?.state === "lost") {
          throw new Error(session.diagnostics?.at(-1)?.message || "Deep WebGPU device was lost.");
        }
        return metrics !== undefined;
      }, () => (backend.runtime as { session?: RuntimeSession }).session?.device?.queue?.onSubmittedWorkDone(), latest);
    };
    const rendered = draw();
    if (!rendered && this.frameQueue.stats.pendingLatest) this.pendingCameraView = view;
    // 只重绘这一份快照以收敛TAA；不重扫Box3、不上传资源、不推进作者动画。
    // 手势相机帧(settle=false)不重启收敛序列;收敛只在相机静止(主路径/尾随
    // sync)后发生,且每轮有界(frames 默认 16,构造硬限 1..120)。
    if (settle) this.temporalSettler.restart(draw);
    return rendered;
  }

  private acceptSyncResult(result: DeepWebGpuSyncResult): void {
    if (result.status === "rejected") {
      throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    }
  }

  /**
   * 方案:受控重建(而非桥直接拒绝致整场景回退)。变体在 backend 创建时编译,故编辑中新激活高级 lobe 时,
   * 先回到作者(three)画布保持可见与可交互,再用 advancedMaterials 变体重建一次 Deep backend——
   * 与设备恢复重建同一事务(候选画布首帧验证通过才显示)。重建后仍被拒绝则按原路径失败上报。
   */
  private restartWithAdvancedMaterials(): void {
    this.advancedMaterialsRequested = true;
    this.restartDeepWithStickyVariant("Advanced material renderer rebuild failed.");
  }

  /**
   * AA-M2 a2c 的同族受控重建:编辑中新出现 `material.alphaToCoverage` 请求而能力门未声明时,
   * 投影桥 fail-closed 拒绝;先回作者画布,再带 `capabilities.alphaToCoverage` + MSAA4 重建一次。
   * 重建后仍被拒(含 transparent 组合的无定义语义拒绝)则按原路径失败上报,无重建环
   * (alphaToCoverageActive 在创建时落定,重复拒绝不再进入本分支)。
   */
  private restartWithAlphaToCoverage(): void {
    this.alphaToCoverageRequested = true;
    this.restartDeepWithStickyVariant("Alpha-to-coverage renderer rebuild failed.");
  }

  /**
   * A2C-P1 运行时降级:渲染器一次性有效性探针判 a2c 采样掩码未生效(descriptor 被驱动
   * 接受但不按片元 alpha 生成掩码 → 纯 a2c 材质全画实心板,证据链见
   * test-output/A2C-P1-HANDOFF.md)时,走与 restartWithAlphaToCoverage 同族的粘性事务
   * 重建 —— a2c 能力门关闭,a2c 材质经 alphaToCoverageMaskFallback 投影为 MASK
   * (alphaTest≈0.4)。一次性:a2cMaskFallbackRequested/Active 落定后不再重触发;重建
   * 后材质不再请求 a2c,渲染器探针也不会再进入测量。
   */
  private restartWithAlphaToCoverageMaskFallback(): void {
    this.a2cMaskFallbackRequested = true;
    this.restartDeepWithStickyVariant("Alpha-to-coverage mask-fallback renderer rebuild failed.");
  }

  /** restartWithAdvancedMaterials / restartWithAlphaToCoverage 的事务骨架(先回作者画布,再换粘性变体重建)。 */
  private restartDeepWithStickyVariant(failureMessage: string): void {
    const userSwitchPending = this.pending !== undefined;
    this.cancelPendingSwitch();
    try { this.publishWebGl(); }
    catch (error) { this.options.onRuntimeFailure?.(error instanceof Error ? error : new Error(String(error))); return; }
    if (userSwitchPending) return;
    void this.switchTo("webgpu").then(result => {
      if (result.status === "failed" && this.activeBackendValue === "webgl") {
        this.options.onRuntimeFailure?.(new Error(result.error ?? failureMessage));
      }
    }, error => this.options.onRuntimeFailure?.(error instanceof Error ? error : new Error(String(error))));
  }

  private failRuntime(reason: unknown): void {
    if (this.closed || this.failureReported || this.activeBackendValue !== "webgpu") return;
    if (!this.advancedMaterialsActive && isDeepAdvancedMaterialsRejection(reason)) { this.restartWithAdvancedMaterials(); return; }
    if (!this.alphaToCoverageActive && isAlphaToCoverageRejection(reason)) { this.restartWithAlphaToCoverage(); return; }
    this.failureReported = true;
    let error = reason instanceof Error ? reason : new Error(String(reason));
    try { this.publishWebGl(); }
    catch (cleanup) { error = new AggregateError([error, cleanup], "Deep runtime failed and cleanup reported errors."); }
    this.options.onRuntimeFailure?.(error);
  }

  private updateAuthorMatrices(): void {
    if (!this.independentPacketPath) this.viewer.scene.updateMatrixWorld(true);
    this.viewer.camera.updateMatrixWorld(true);
  }

  /** 手势帧:控制器推进后把姿态写回作者相机(单一事实源),由既有 fast path 出帧。 */
  private readonly applyGesturePose = (): void => {
    if (!this.gestureActive || !this.controller) return;
    const now = performance.now();
    const dt = this.lastGestureTickAt === undefined ? 16 : Math.min(100, now - this.lastGestureTickAt);
    this.lastGestureTickAt = now;
    const stillConverging = this.controller.tick(dt);
    this.viewer.setContinuousRender?.("deep-camera", stillConverging);
    const state = this.viewer.getCameraState();
    if (!sameHostCameraPose(state, this.lastAppliedPose)) {
      // 宿主相机偏离控制器最后同步姿态 = 程序性变更(fitAll/标准视角/快照恢复):
      // 以宿主为准重设控制器,禁止把手势中的旧球坐标刷回覆盖程序性相机命令(与 WASM 桥同族)。
      this.controller.setPose([state.position.x, state.position.y, state.position.z],
        [state.target.x, state.target.y, state.target.z]);
      this.lastAppliedPose = this.controller.getPose();
      return;
    }
    {
      const pose = this.controller.getPose();
      if (!sameHostCameraPose(state, pose)) this.viewer.applyViewportCameraPose?.(pose);
      this.lastAppliedPose = pose;
    }
  };

  private scheduleCameraSettle(): void {
    this.cancelCameraSettle();
    this.cameraSettleTimer = setTimeout(() => {
      this.cameraSettleTimer = undefined;
      // One trailing full sync preserves scene/material edits that happened in
      // the same author frame as camera input, without traversing/uploading the
      // scene for every pointer sample.
      this.renderDeepFrame();
    }, 80);
  }

  private cancelCameraSettle(): void {
    if (this.cameraSettleTimer !== undefined) clearTimeout(this.cameraSettleTimer);
    this.cameraSettleTimer = undefined;
  }

  private probeClipmapEnabled(): boolean {
    const lighting = (this.viewer as Partial<ViewerEngine>).getGlobalLighting?.();
    return lighting?.enabled === true && lighting.globalIlluminationEnabled === true;
  }

  /**
   * F5-L4: 武装探针捕获心跳泵。每次 deep 帧绘制后调用——覆盖探针启用、包修订
   * (dirty 全场景)、相机事件三类捕获需求源;泵按 RAF 自续,直到会话上报无欠账
   * (idle)自停,静置期不驻留任何定时器/回调。预算合同不变:泵只重新触发会话既有的
   * 串行批次提交,每批仍受 updateBudget 约束。
   */
  private pumpProbeCapture(): void {
    if (this.probePumpArmed || this.closed || !this.probeClipmapEnabled()) return;
    this.probePumpArmed = true;
    const step = (): void => {
      this.probePumpArmed = false;
      const backend = this.deepBackend;
      if (!backend || this.closed || !this.probeClipmapEnabled()
        || document.visibilityState !== "visible") return;
      let tick: "idle" | "busy" | "submitted" | "unavailable";
      try { tick = backend.probeCaptureTick(); }
      catch { return; }
      if (tick === "submitted" || tick === "busy") this.pumpProbeCapture();
    };
    requestAnimationFrame(step);
  }

  private projectionRoot(): ThreeObjectSource {
    return this.viewer.getDeepProjectionRoot() as unknown as ThreeObjectSource;
  }

  private result(status: StudioRendererSwitchResult["status"], error?: string): StudioRendererSwitchResult {
    return { status, activeBackend: this.activeBackendValue, ...(error ? { error } : {}) };
  }
}
