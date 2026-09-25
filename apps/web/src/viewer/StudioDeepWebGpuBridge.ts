import * as THREE from "three";
import type {
  DeepWebGpuBackend,
  DeepWebGpuSyncResult,
  ThreeObjectSource,
} from "@bim-studio/deep-engine/three-bridge";
import type { ViewerEngine } from "./ViewerEngine";
import type { RendererBackend } from "./viewerTypes";
import { prepareStudioRendererCandidate } from "./prepareStudioRendererCandidate";
import { TemporalFrameSettler } from "./temporalFrameSettler";
import { studioDeepShadowMapSize } from "./studioDeepShadowAllocation";
import { prepareStudioDeepEnvironmentSource, isStudioDeepEnvironmentSourceCurrent,
  type PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";
import { readStudioDeepEnvironmentView } from "./studioDeepEnvironmentView";
import { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import { StudioDeepShadowSession } from "./StudioDeepShadowSession";
import { StudioDeepPerformance } from "./StudioDeepPerformance";
import { StudioDeepRenderView } from "./StudioDeepRenderView";
import { updateAuthorProjectionState } from "./authorLodSelection";
import { DeepCameraController } from "./deepCameraController";
import { DeepCameraInputSession } from "./deepCameraInputSession";
import { DeepGizmoInteraction } from "./deepGizmoInteraction";
import { createDeepCanvas, prepareAuthorInputCanvas, captureAuthorStyle, restoreAuthorStyle,
  type AuthorCanvasStyle } from "./studioDeepPresentationCanvas";
import { collectDeepOverlayPrimitives } from "./deepOverlayPrimitiveSource";
import type { FrameCaptureSession, RenderPacket } from "@bim-studio/deep-engine";
import { createRequestedStudioFrameCaptureSession, createStudioFrameReadbackListener,
  publishStudioFrameCaptureSession, releaseStudioFrameCaptureSession } from "./studioFrameCaptureDiagnostics";

type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");
type BridgeModuleLoader = () => Promise<BridgeModule>;
interface RuntimeSession {
  readonly state?: string;
  readonly diagnostics?: readonly { message: string }[];
  readonly device?: { readonly lost: Promise<{ readonly message: string; readonly reason: string }>;
    readonly queue?: { onSubmittedWorkDone(): Promise<void> } };
}

type DeepRenderView = ReturnType<StudioDeepRenderView["renderViewDirect"]>;

export interface StudioDeepWebGpuBridgeOptions {
  readonly onRuntimeFailure?: (error: Error) => void;
  readonly loadModule?: BridgeModuleLoader;
  readonly preparationTimeoutMs?: number;
  /** Maximum submitted camera views awaiting GPU queue completion. */
  readonly cameraFrameInFlightLimit?: 1 | 2;
  /** Optional packet compiled from SceneSnapshot; when provided Deep skips
   * Three scene projection for candidate publication. */
  readonly authorRenderPacket?: (signal: AbortSignal) => Promise<RenderPacket | undefined>;
}

export interface StudioRendererSwitchResult {
  readonly status: "switched" | "unchanged" | "cancelled" | "failed";
  readonly activeBackend: RendererBackend;
  readonly error?: string;
}

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
  private syncPending: DeepWebGpuBackend | undefined;
  private syncAgain: DeepWebGpuBackend | undefined;
  private lastCameraSnapshot: readonly number[] | undefined;
  private cameraSettleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private failureReported = false;
  private environmentSession: StudioDeepEnvironmentSession | undefined;
  private shadowSession: StudioDeepShadowSession | undefined;
  private performanceSource: StudioDeepPerformance | undefined;
  private frameCaptureSession: FrameCaptureSession | undefined;
  private readonly viewReader: StudioDeepRenderView;
  private projectionBridge: import("@bim-studio/deep-engine/three-bridge").ThreeProjectionBridge | undefined;
  private readonly temporalSettler = new TemporalFrameSettler({ initialDelayFrames: 1,
    onSettled: () => this.performanceSource?.pause(), onError: reason => this.failRuntime(reason) });
  private readonly cameraFrameInFlightLimit: 1 | 2;
  private cameraFramesInFlight = 0;
  private pendingCameraView: DeepRenderView | undefined;
  private cameraFramesSubmitted = 0;
  private cameraFramesCoalesced = 0;
  private cameraMaxInFlight = 0;
  /** TAA settle frames share the same WebGPU queue as camera frames. Keep at
   * most one settle submission pending so RAF cannot build an unbounded queue. */
  private settleFrameInFlight = false;
  private settleFrameBackend: DeepWebGpuBackend | undefined;
  private controller: DeepCameraController | undefined;
  private inputSession: DeepCameraInputSession | undefined;
  private gestureActive = false;
  private lastGestureTickAt: number | undefined;
  private readonly gizmoInteraction: DeepGizmoInteraction;
  /** True after an immutable SceneSnapshot packet was accepted for this session. */
  private independentPacketPath = false;

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
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
    this.gizmoInteraction = new DeepGizmoInteraction(viewer, () => this.authorCanvas.getBoundingClientRect());
    prepareAuthorInputCanvas(this.authorCanvas);
  }

  get activeBackend(): RendererBackend { return this.activeBackendValue; }

  get diagnostics() {
    if (!this.deepBackend) return undefined;
    const backend = this.deepBackend.diagnostics;
    return { ...(backend ?? {}), cameraFlow: { inFlight: this.cameraFramesInFlight,
      maxInFlight: this.cameraMaxInFlight, submitted: this.cameraFramesSubmitted,
      coalesced: this.cameraFramesCoalesced, pendingLatest: this.pendingCameraView !== undefined,
      limit: this.cameraFrameInFlightLimit } };
  }

  cancelPendingSwitch(): void {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }

  async switchTo(target: RendererBackend): Promise<StudioRendererSwitchResult> {
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
        this.publishWebGl();
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
    const canvas = createDeepCanvas(this.container);
    let environment: PreparedStudioDeepEnvironment | undefined;
    let shadowMapSize = 1024;
    let frameCaptureSession: FrameCaptureSession | undefined;
    try {
      const prepared = await prepareStudioRendererCandidate({
        signal: controller.signal,
        timeoutMs: this.options.preparationTimeoutMs ?? 30_000,
        loadModule: async () => {
          const module = await this.loadModule();
          markSwitchPhase("deep-webgpu:module-ready");
          return module;
        },
        create: async (module, signal) => {
          signal.throwIfAborted();
          environment = await prepareStudioDeepEnvironmentSource(this.viewer.scene, signal);
          markSwitchPhase("deep-webgpu:environment-ready");
          const postProcessing = this.viewer.getPostProcessing();
          const authorRenderPacket = this.options.authorRenderPacket
            ? await this.options.authorRenderPacket(signal) : undefined;
          this.independentPacketPath = authorRenderPacket !== undefined;
          if (!authorRenderPacket) updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
          else this.viewReader.setIndependentPacketBounds(authorRenderPacket);
          const view = this.viewReader.renderView(module, canvas);
          shadowMapSize = view.lights?.directional?.[0]?.shadow?.mapSize
            ?? studioDeepShadowMapSize(this.viewer.scene, this.viewer.camera.layers.mask);
          frameCaptureSession = createRequestedStudioFrameCaptureSession();
          // A compiled SceneSnapshot packet is a complete Deep input. Keep the
          // Three projection bridge out of this path so geometry, materials,
          // hierarchy and transforms are never read from the author scene.
          this.projectionBridge = authorRenderPacket ? undefined : new module.ThreeProjectionBridge({ hooks: threePrototypeHooks(), capabilities: { authorDeformation: true, authorLod: true },
            authorTransformResolver: source => resolveAuthorWorldTransform(this.viewer, source),
          });
          const backend = await module.DeepWebGpuBackend.create({
            canvas, gpu: navigator.gpu,
            ...(this.projectionBridge ? { projection: this.projectionBridge, root: this.projectionRoot() } : {}),
            view, authorChunks: true,
            ...(authorRenderPacket ? { renderPacket: authorRenderPacket } : {}),
            renderer: { environment: environment.source, deformation: true, meshlets: true,
              adaptiveQuality: {
                enabled: true,
                collectHotspots: false,
                ...(postProcessing.qualityProfile
                  ? { overrides: module.adaptiveQualityOverridesForProfile(postProcessing.qualityProfile) }
                  : {}),
              },
              shadows: { exactProfile: { cascadeCount: 1, shadowMapSize } },
              features: { environment: true, groundPlane: false,
                groundGrid: false, screenSpaceReflection: true, volumetricFog: true, toneMapping: "three-aces-r185" },
              ...(frameCaptureSession ? { frameCapture: { session: frameCaptureSession,
                readbacks: { requests: [{ resourceId: "present-color" as const }, { resourceId: "linear-depth" as const }] },
                onReadbackResults: createStudioFrameReadbackListener() } } : {}) },
            cameraLayerMask: this.viewer.camera.layers.mask, signal,
          });
          markSwitchPhase("deep-webgpu:scene-uploaded");
          return backend;
        },
        prepare: async (backend, signal) => {
          await nextFrame(signal);
          if (!this.independentPacketPath) updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
          // create 期间作者仍可编辑；重新投影并验证当前相机，而非发布创建时的快照。
          // 这不是 revision 锁：验证期间的连续动画仍由发布后的作者帧订阅追平。
          const latestView = this.viewReader.renderViewDirect(canvas);
          if (typeof backend.prepareView === "function") await backend.prepareView(latestView, signal);
          else await backend.prepareScene(this.projectionRoot(), latestView, this.viewer.camera.layers.mask, signal);
          readStudioDeepEnvironmentView(this.viewer.scene, this.viewer.usesAuthorPostProcessing());
          if (!environment || !isStudioDeepEnvironmentSourceCurrent(this.viewer.scene, environment)) {
            throw new Error("作者环境在候选准备期间已改变。");
          }
          markSwitchPhase("deep-webgpu:frame-validated");
        },
        dispose: (backend) => backend.dispose(),
        removeCanvas: () => canvas.remove(),
      });
      if (prepared.status !== "ready") return this.result(prepared.status, prepared.error?.message);
      const backend = prepared.value;
      if (this.closed || controller.signal.aborted || generation !== this.generation) {
        try { backend.dispose(); } finally { canvas.remove(); }
        return this.result("cancelled");
      }
      this.publishDeep(canvas, backend, environment!, shadowMapSize, frameCaptureSession);
      markSwitchPhase("deep-webgpu:published");
      return this.result("switched");
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
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
    backend.setProbeClipmapEnabled(this.probeClipmapEnabled());
    const environmentSession = new StudioDeepEnvironmentSession({ scene: this.viewer.scene, initial: environment,
      readView: () => readStudioDeepEnvironmentView(this.viewer.scene, this.viewer.usesAuthorPostProcessing()),
      stage: (source, signal) => backend.stageEnvironment(source, signal),
      onReady: this.renderDeepFrame, onFailure: error => this.failRuntime(error) });
    // Publishing is the atomic handoff boundary. If retiring the previous
    // backend reports a cleanup error, the candidate must be retired too;
    // otherwise a failed switch leaks a live GPU device and canvas.
    try {
      this.releaseDeep();
    } catch (error) {
      try { backend.dispose(); } finally { canvas.remove(); }
      throw error;
    }
    canvas.style.visibility = "visible";
    canvas.style.opacity = "1";
    this.authorCanvas.style.opacity = "0";
    this.deepCanvas = canvas;
    this.deepBackend = backend;
    this.independentPacketPath = backend.usesIndependentPacket;
    this.frameCaptureSession = frameCaptureSession;
    publishStudioFrameCaptureSession(frameCaptureSession);
    this.performanceSource = new StudioDeepPerformance(backend.runtime as ConstructorParameters<typeof StudioDeepPerformance>[0]);
    this.performanceSource.setDiagnosticsSource(() => {
      const diagnostics = backend.diagnostics;
      return diagnostics?.probeClipmap ? { probeClipmap: diagnostics.probeClipmap } : undefined;
    });
    this.viewer.setPresentationPerformanceSource(this.performanceSource);
    this.environmentSession = environmentSession;
    this.shadowSession = new StudioDeepShadowSession({ initialMapSize: shadowMapSize,
      stage: (mapSize, signal) => backend.stageShadowMapSize(mapSize, signal),
      onReady: this.renderDeepFrame, onFailure: error => this.failRuntime(error) });
    this.activeBackendValue = "webgpu";
    this.viewer.setPresentationRendererBackend("webgpu");
    this.viewer.setDeepPointerPick?.((origin, direction) => this.pickDeep(backend, origin, direction));
    this.failureReported = false;
    this.lastCameraSnapshot = cameraSnapshot(this.viewer);
    this.takeoverGesture();
    // 静止视口没有帧回调，设备丢失必须主动通知，不能等待下一次用户输入。
    const session = (backend.runtime as { session?: RuntimeSession }).session;
    void session?.device?.lost.then((info) => {
      if (this.deepBackend === backend) this.failRuntime(new Error(info.message || info.reason));
    }).catch((reason) => {
      if (this.deepBackend === backend) this.failRuntime(reason);
    });
    this.unsubscribeFrame = this.viewer.subscribePresentationFrames(this.renderPresentationFrame);
  }

  private publishWebGl(): void {
    this.generation++;
    this.authorCanvas.style.opacity = "1";
    this.activeBackendValue = "webgl";
    this.viewer.setPresentationRendererBackend("webgl");
    this.releaseDeep();
  }

  private releaseDeep(): void {
    this.viewer.setDeepPointerPick?.(undefined);
    this.projectionBridge = undefined;
    this.independentPacketPath = false;
    this.viewer.setPresentationPerformanceSource(undefined);
    this.performanceSource?.dispose();
    this.performanceSource = undefined;
    this.temporalSettler.cancel();
    this.viewReader.reset();
    this.environmentSession?.dispose();
    this.environmentSession = undefined;
    this.shadowSession?.dispose();
    this.shadowSession = undefined;
    const unsubscribe = this.unsubscribeFrame;
    this.unsubscribeFrame = undefined;
    const backend = this.deepBackend;
    const canvas = this.deepCanvas;
    const frameCaptureSession = this.frameCaptureSession;
    this.deepBackend = undefined;
    this.deepCanvas = undefined;
    this.frameCaptureSession = undefined;
    releaseStudioFrameCaptureSession(frameCaptureSession);
    this.syncPending = undefined;
    this.syncAgain = undefined;
    this.releaseGesture();
    this.lastCameraSnapshot = undefined;
    this.cameraFramesInFlight = 0;
    this.pendingCameraView = undefined;
    this.cameraFramesSubmitted = 0;
    this.cameraFramesCoalesced = 0;
    this.cameraMaxInFlight = 0;
    this.cancelCameraSettle();
    const errors: unknown[] = [];
    for (const clean of [unsubscribe, () => backend?.dispose(), () => canvas?.remove()]) {
      try { clean?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Deep renderer cleanup failed.");
  }

  private pickDeep(backend: DeepWebGpuBackend, origin: readonly [number, number, number],
    direction: readonly [number, number, number]): import("./viewerEngineTypes").DeepPointerPickResult {
    const runtime = backend.runtime as unknown as {
      pick?: (origin: ArrayLike<number>, direction: ArrayLike<number>, options?: { maxHits?: number }) =>
        { available: false; reason: string } | { available: true; hits: readonly { instanceId: string; point: readonly [number, number, number]; distance: number }[]; degraded?: readonly string[] };
    };
    if (typeof runtime.pick !== "function") return { available: false, reason: "Deep runtime does not expose picking.", fallbackToAuthor: true };
    let result;
    const localOrigin = backend.worldToRenderLocal(origin);
    try { result = runtime.pick(localOrigin, direction, { maxHits: 1 }); }
    catch (reason) { return { available: false, reason: reason instanceof Error ? reason.message : String(reason), fallbackToAuthor: true }; }
    if (!result.available) return { available: false, reason: result.reason, fallbackToAuthor: true };
    const hit = result.hits[0];
    if (!hit) return result.degraded
      ? { available: true, degraded: result.degraded, fallbackToAuthor: false }
      : { available: true, fallbackToAuthor: false };
    const packetModelId = backend.modelIdForInstanceId(hit.instanceId);
    const source = this.projectionBridge?.sourceForInstanceId(hit.instanceId) as unknown as
      { userData?: Record<string, unknown>; parent?: unknown } | undefined;
    const modelId = packetModelId ?? (source ? authorModelId(source) : undefined);
    if (!modelId) return { available: true, degraded: [...(result.degraded ?? []), "node-mapping-unavailable:deep-hit-not-selectable"], fallbackToAuthor: true };
    const picked = { point: new THREE.Vector3(...hit.point), distance: hit.distance, objectName: modelId, modelId };
    return result.degraded
      ? { available: true, degraded: result.degraded, hit: picked, fallbackToAuthor: false }
      : { available: true, hit: picked, fallbackToAuthor: false };
  }

  private readonly renderPresentationFrame = (): void => {
    // The presenter owns the scene traversal. Refresh only the tiny camera
    // node here so direct test/host callbacks and late controls events cannot
    // expose a stale matrixWorld, without forcing the whole author tree again.
    this.viewer.camera.updateMatrixWorld(true);
    this.renderDeepFrame(true);
  };

  private readonly renderDeepFrame = (authorMatricesCurrent = false): void => {
    const backend = this.deepBackend;
    const canvas = this.deepCanvas;
    if (this.closed || this.activeBackendValue !== "webgpu" || !backend || !canvas) return;
    try {
      this.temporalSettler.cancel();
      // presentViewerFrame already updates author matrices/LOD before notifying
      // the external renderer. Keep the explicit path for environment/shadow
      // callbacks and trailing syncs which can run outside an author frame.
      if (!authorMatricesCurrent) this.updateAuthorMatrices();
      const camera = cameraSnapshot(this.viewer);
      const cameraChanged = !sameSnapshot(camera, this.lastCameraSnapshot);
      this.lastCameraSnapshot = camera;
      const shouldSync = !cameraChanged;
      if (!shouldSync) {
        if (this.syncPending === backend) this.syncAgain = backend;
        // Camera input can arrive every author frame. Render only the latest view
        // while the gesture is active; restarting the temporal settle sequence on
        // every pointer sample doubles/triples GPU work and makes WebGPU lag input.
        this.renderLatestCameraFrame(backend, canvas);
        this.scheduleCameraSettle();
        return;
      }
      this.cancelCameraSettle();
      if (!cameraChanged) this.viewReader.invalidateProjectionBounds();
      const view = this.viewReader.renderViewDirect(canvas);
      // An immutable RenderPacket backend has no author hierarchy to sync. The
      // generic sync call is intentionally retained for the legacy Three path,
      // but awaiting its already-committed no-op here adds a promise turn to
      // every settled frame and widens pointer-to-submit latency. Render the
      // packet directly while preserving the same bounded TAA settle sequence.
      if (backend.usesIndependentPacket === true
        || (backend.usesIndependentPacket === undefined && this.options.authorRenderPacket !== undefined)) {
        this.renderCommittedFrame(backend, canvas, view);
        return;
      }
      // 一帧一提交节流:发起 sync 的帧不在同步路径预画同一 view。sync 完成后的
      // renderCommittedFrame 才是这份 view 的唯一呈现(资源上传后的画面)。尾随与
      // 资源 sync 只发生在相机静止之后,呈现晚一个 sync 周期不可感知;手势进行中
      // 走相机路径,不经过这里。
      if (!this.syncPending) {
        this.syncPending = backend;
        void backend.sync(this.projectionRoot(), this.viewer.camera.layers.mask, undefined, view)
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
    if (this.cameraFramesInFlight >= this.cameraFrameInFlightLimit) {
      // Replace, never append: stale camera poses have no semantic value after
      // newer input. Scene/material edits are preserved by the trailing sync.
      // 消费时机由 renderDeepFrame 驱动(下一作者帧相机路径覆盖/主路径呈现后
      // 清空),GPU 完成回调不做即时重放——见 completeCameraFrame 的合并注释。
      this.pendingCameraView = view;
      this.cameraFramesCoalesced++;
      return;
    }
    this.cameraFramesInFlight++;
    this.cameraMaxInFlight = Math.max(this.cameraMaxInFlight, this.cameraFramesInFlight);
    this.cameraFramesSubmitted++;
    try {
      this.renderCommittedFrame(backend, canvas, view, false);
    } catch (error) {
      this.cameraFramesInFlight--;
      throw error;
    }
    const session = (backend.runtime as { session?: RuntimeSession }).session;
    const completion = session?.device?.queue?.onSubmittedWorkDone();
    if (!completion) {
      this.completeCameraFrame(backend);
      return;
    }
    void completion.then(() => this.completeCameraFrame(backend)).catch(reason => {
      if (this.deepBackend === backend) this.failRuntime(reason);
    });
  }

  /** GPU 完成回调:只释放一个在飞名额。补位画面的合并策略见函数体注释。 */
  private completeCameraFrame(backend: DeepWebGpuBackend): void {
    if (this.deepBackend !== backend) return;
    this.cameraFramesInFlight = Math.max(0, this.cameraFramesInFlight - 1);
    // 补位合并:不在 GPU 完成回调里立即重放 pending——那会与同一渲染帧的作者帧
    // 提交相邻,形成一帧双提交(submitGap=0 的拖尾主体)。pending 保留到下一次
    // renderDeepFrame:相机路径以更新的 view 覆盖并在呈现后清空;主路径呈现后同样
    // 清空。手势输入逐帧驱动作者回调,80ms 尾随 sync 兜底,不会滞留旧画面。
  }

  private renderCommittedFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement,
    view = this.viewReader.renderViewDirect(canvas), settle = true): void {
    const draw = (): boolean => {
      if (this.deepBackend !== backend) return false;
      if (settle && this.settleFrameInFlight && this.settleFrameBackend === backend) return false;
      backend.setProbeClipmapEnabled(this.probeClipmapEnabled());
      const metrics = backend.render(view);
      if (metrics) this.performanceSource?.record(metrics, view.width, document.visibilityState !== "hidden");
      this.shadowSession?.acknowledgeMapSize(metrics?.shadowMapSize);
      const session = (backend.runtime as { session?: RuntimeSession }).session;
      if (!metrics && session?.state === "lost") {
        throw new Error(session.diagnostics?.at(-1)?.message || "Deep WebGPU device was lost.");
      }
      if (settle) {
        const completion = session?.device?.queue?.onSubmittedWorkDone();
        if (completion) {
          this.settleFrameInFlight = true;
          this.settleFrameBackend = backend;
          void Promise.resolve(completion).then(() => {
            if (this.settleFrameBackend === backend) {
              this.settleFrameInFlight = false;
              this.settleFrameBackend = undefined;
            }
          }).catch(reason => {
            if (this.settleFrameBackend === backend) {
              this.settleFrameInFlight = false;
              this.settleFrameBackend = undefined;
              if (this.deepBackend === backend) this.failRuntime(reason);
            }
          });
        }
      }
      return true;
    };
    draw();
    // 呈现已覆盖到这份(更新的)view:待补位的旧相机帧不再有价值,清空以避免
    // 在后续回调里回放旧画面。失败路径(throw)不清,由异常处理接管。
    this.pendingCameraView = undefined;
    // 只重绘这一份快照以收敛TAA；不重扫Box3、不上传资源、不推进作者动画。
    // 手势相机帧(settle=false)不重启收敛序列;收敛只在相机静止(主路径/尾随
    // sync)后发生,且每轮有界(frames 默认 16,构造硬限 1..120)。
    if (settle) this.temporalSettler.restart(draw);
  }

  private acceptSyncResult(result: DeepWebGpuSyncResult): void {
    if (result.status === "rejected") {
      throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    }
  }

  private failRuntime(reason: unknown): void {
    if (this.closed || this.failureReported || this.activeBackendValue !== "webgpu") return;
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

  /** 视口手势接管:Deep 画布持有输入,作者画布降级为透传目标(拾取/gizmo 零损失)。 */
  private takeoverGesture(): void {
    const state = this.viewer.getCameraState?.();
    const controller = this.controller ??= new DeepCameraController({
      verticalFovDegrees: this.viewer.getCameraProjectionState?.().verticalFovDegrees ?? 50,
    });
    if (state) controller.setPose([state.position.x, state.position.y, state.position.z],
      [state.target.x, state.target.y, state.target.z]);
    if (this.viewer.enableViewportGestureTakeover?.() !== true || !this.deepCanvas) return;
    this.gestureActive = true;
    this.deepCanvas.style.pointerEvents = "auto";
    this.authorCanvas.style.pointerEvents = "none";
    this.inputSession ??= new DeepCameraInputSession(this.deepCanvas, controller, () => this.applyGesturePose(), {
      forwardTo: this.authorCanvas,
      suppressGesture: () => this.viewer.isViewportGestureSuppressed?.() === true,
      handleGizmoPointer: (phase, event) => this.gizmoInteraction.handle(phase, event),
    });
    this.inputSession.attach();
  }

  private releaseGesture(): void {
    if (!this.gestureActive) return;
    this.gestureActive = false;
    this.lastGestureTickAt = undefined;
    this.inputSession?.detach();
    if (this.deepCanvas) this.deepCanvas.style.pointerEvents = "none";
    this.authorCanvas.style.pointerEvents = "auto";
    this.viewer.disableViewportGestureTakeover?.();
  }

  /** 手势帧:控制器推进后把姿态写回作者相机(单一事实源),由既有 fast path 出帧。 */
  private readonly applyGesturePose = (): void => {
    if (!this.gestureActive || !this.controller) return;
    const now = performance.now();
    const dt = this.lastGestureTickAt === undefined ? 16 : Math.min(100, now - this.lastGestureTickAt);
    this.lastGestureTickAt = now;
    this.controller.tick(dt);
    this.viewer.applyViewportCameraPose?.(this.controller.getPose());
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

  private projectionRoot(): ThreeObjectSource {
    return this.viewer.getDeepProjectionRoot() as unknown as ThreeObjectSource;
  }

  private result(status: StudioRendererSwitchResult["status"], error?: string): StudioRendererSwitchResult {
    return { status, activeBackend: this.activeBackendValue, ...(error ? { error } : {}) };
  }
}

function cameraSnapshot(viewer: ViewerEngine): readonly number[] {
  const camera = viewer.camera, target = viewer.orbit.target;
  return [camera.position.x, camera.position.y, camera.position.z,
    target.x, target.y, target.z, camera.fov, camera.zoom, camera.near, camera.far,
    camera.up.x, camera.up.y, camera.up.z];
}

function authorModelId(source: { userData?: Record<string, unknown>; parent?: unknown }): string | undefined {
  let current: { userData?: Record<string, unknown>; parent?: unknown } | undefined = source;
  for (let depth = 0; current && depth < 64; depth++) {
    const value = current.userData?.modelId;
    if (typeof value === "string" && value.length > 0) return value;
    current = current.parent as typeof current;
  }
  return undefined;
}

function resolveAuthorWorldTransform(viewer: ViewerEngine, source: ThreeObjectSource): ArrayLike<number> | undefined {
  const modelId = authorModelId(source as unknown as { userData?: Record<string, unknown>; parent?: unknown });
  if (!modelId) return undefined;
  const model = viewer.listModels().find(candidate => candidate.id === modelId);
  const authored = viewer.getModelTransform(modelId);
  if (!model || !authored) return undefined;
  const root = model.object;
  root.updateWorldMatrix(true, true);
  const object = source as unknown as THREE.Object3D;
  object.updateWorldMatrix(true, false);
  const relative = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(object.matrixWorld);
  const authoredWorld = new THREE.Matrix4().compose(
    new THREE.Vector3(authored.position.x, authored.position.y, authored.position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(authored.rotation.x, authored.rotation.y, authored.rotation.z)),
    new THREE.Vector3(authored.scale.x, authored.scale.y, authored.scale.z),
  );
  return authoredWorld.multiply(relative).elements;
}

function sameSnapshot(a: readonly number[], b: readonly number[] | undefined, epsilon = 1e-6): boolean {
  return b !== undefined && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= epsilon);
}

function markSwitchPhase(name: string): void {
  if (typeof performance?.mark === "function") performance.mark(name);
}

function threePrototypeHooks() {
  return {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
    objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
    objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender,
    materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  };
}

function nextFrame(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Renderer switch cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame(() => { signal?.removeEventListener("abort", onAbort); resolve(); });
    const onAbort = () => { cancelAnimationFrame(frame); reject(new DOMException("Renderer switch cancelled", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
