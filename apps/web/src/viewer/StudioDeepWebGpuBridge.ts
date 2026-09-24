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
import { createDeepCanvas, prepareAuthorInputCanvas, captureAuthorStyle, restoreAuthorStyle,
  type AuthorCanvasStyle } from "./studioDeepPresentationCanvas";
import type { FrameCaptureSession } from "@bim-studio/deep-engine";
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
  private readonly temporalSettler = new TemporalFrameSettler({ initialDelayFrames: 1,
    onSettled: () => this.performanceSource?.pause(), onError: reason => this.failRuntime(reason) });
  private readonly cameraFrameInFlightLimit: 1 | 2;
  private cameraFramesInFlight = 0;
  private pendingCameraView: DeepRenderView | undefined;
  private cameraFramesSubmitted = 0;
  private cameraFramesCoalesced = 0;
  private cameraMaxInFlight = 0;

  constructor(
    private readonly viewer: ViewerEngine,
    private readonly container: HTMLElement,
    private readonly options: StudioDeepWebGpuBridgeOptions = {},
  ) {
    this.viewReader = new StudioDeepRenderView(viewer, container, () => this.environmentSession, () => this.shadowSession);
    this.loadModule = options.loadModule ?? (() => import("@bim-studio/deep-engine/three-bridge"));
    this.cameraFrameInFlightLimit = options.cameraFrameInFlightLimit ?? 2;
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
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
          updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
          const view = this.viewReader.renderView(module, canvas);
          shadowMapSize = view.lights?.directional?.[0]?.shadow?.mapSize
            ?? studioDeepShadowMapSize(this.viewer.scene, this.viewer.camera.layers.mask);
          frameCaptureSession = createRequestedStudioFrameCaptureSession();
          const backend = await module.DeepWebGpuBackend.create({
            canvas, gpu: navigator.gpu,
            projection: new module.ThreeProjectionBridge({ hooks: threePrototypeHooks(), capabilities: { authorDeformation: true, authorLod: true } }),
            root: this.projectionRoot(), view, authorChunks: true,
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
          updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
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
    this.frameCaptureSession = frameCaptureSession;
    publishStudioFrameCaptureSession(frameCaptureSession);
    this.performanceSource = new StudioDeepPerformance(backend.runtime as ConstructorParameters<typeof StudioDeepPerformance>[0]);
    this.viewer.setPresentationPerformanceSource(this.performanceSource);
    this.environmentSession = environmentSession;
    this.shadowSession = new StudioDeepShadowSession({ initialMapSize: shadowMapSize,
      stage: (mapSize, signal) => backend.stageShadowMapSize(mapSize, signal),
      onReady: this.renderDeepFrame, onFailure: error => this.failRuntime(error) });
    this.activeBackendValue = "webgpu";
    this.viewer.setPresentationRendererBackend("webgpu");
    this.failureReported = false;
    this.lastCameraSnapshot = cameraSnapshot(this.viewer);
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
      } else this.syncAgain = backend;
      this.renderCommittedFrame(backend, canvas, view);
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
      this.completeCameraFrame(backend, canvas);
      return;
    }
    void completion.then(() => this.completeCameraFrame(backend, canvas)).catch(reason => {
      if (this.deepBackend === backend) this.failRuntime(reason);
    });
  }

  private completeCameraFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement): void {
    if (this.deepBackend !== backend || this.deepCanvas !== canvas) return;
    this.cameraFramesInFlight = Math.max(0, this.cameraFramesInFlight - 1);
    const pending = this.pendingCameraView;
    if (!pending) return;
    this.pendingCameraView = undefined;
    try { this.renderLatestCameraFrame(backend, canvas, pending); }
    catch (reason) { this.failRuntime(reason); }
  }

  private renderCommittedFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement,
    view = this.viewReader.renderViewDirect(canvas), settle = true): void {
    const draw = () => {
      if (this.deepBackend !== backend) return;
      backend.setProbeClipmapEnabled(this.probeClipmapEnabled());
      const metrics = backend.render(view);
      if (metrics) this.performanceSource?.record(metrics, view.width, document.visibilityState !== "hidden");
      this.shadowSession?.acknowledgeMapSize(metrics?.shadowMapSize);
      const session = (backend.runtime as { session?: RuntimeSession }).session;
      if (!metrics && session?.state === "lost") {
        throw new Error(session.diagnostics?.at(-1)?.message || "Deep WebGPU device was lost.");
      }
    };
    draw();
    // 只重绘这一份快照以收敛TAA；不重扫Box3、不上传资源、不推进作者动画。
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
    this.viewer.scene.updateMatrixWorld(true);
    this.viewer.camera.updateMatrixWorld(true);
  }

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
