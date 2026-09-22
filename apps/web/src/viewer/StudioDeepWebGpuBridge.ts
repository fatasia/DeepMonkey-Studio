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
  readonly device?: { readonly lost: Promise<{ readonly message: string; readonly reason: string }> };
}

export interface StudioDeepWebGpuBridgeOptions {
  readonly onRuntimeFailure?: (error: Error) => void;
  readonly loadModule?: BridgeModuleLoader;
  readonly preparationTimeoutMs?: number;
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
  private closed = false;
  private failureReported = false;
  private environmentSession: StudioDeepEnvironmentSession | undefined;
  private shadowSession: StudioDeepShadowSession | undefined;
  private performanceSource: StudioDeepPerformance | undefined;
  private frameCaptureSession: FrameCaptureSession | undefined;
  private readonly viewReader: StudioDeepRenderView;
  private readonly temporalSettler = new TemporalFrameSettler({ initialDelayFrames: 1,
    onSettled: () => this.performanceSource?.pause(), onError: reason => this.failRuntime(reason) });

  constructor(
    private readonly viewer: ViewerEngine,
    private readonly container: HTMLElement,
    private readonly options: StudioDeepWebGpuBridgeOptions = {},
  ) {
    this.viewReader = new StudioDeepRenderView(viewer, container, () => this.environmentSession, () => this.shadowSession);
    this.loadModule = options.loadModule ?? (() => import("@bim-studio/deep-engine/three-bridge"));
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
    prepareAuthorInputCanvas(this.authorCanvas);
  }

  get activeBackend(): RendererBackend { return this.activeBackendValue; }

  get diagnostics() {
    return this.deepBackend?.diagnostics;
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
    const canvas = createDeepCanvas(this.container);
    let environment: PreparedStudioDeepEnvironment | undefined;
    let shadowMapSize = 1024;
    let frameCaptureSession: FrameCaptureSession | undefined;
    try {
      const prepared = await prepareStudioRendererCandidate({
        signal: controller.signal,
        timeoutMs: this.options.preparationTimeoutMs ?? 30_000,
        loadModule: this.loadModule,
        create: async (module, signal) => {
          signal.throwIfAborted();
          environment = await prepareStudioDeepEnvironmentSource(this.viewer.scene, signal);
          updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
          const view = this.viewReader.renderView(module, canvas);
          shadowMapSize = view.lights?.directional?.[0]?.shadow?.mapSize
            ?? studioDeepShadowMapSize(this.viewer.scene, this.viewer.camera.layers.mask);
          frameCaptureSession = createRequestedStudioFrameCaptureSession();
          return module.DeepWebGpuBackend.create({
            canvas, gpu: navigator.gpu,
            projection: new module.ThreeProjectionBridge({ hooks: threePrototypeHooks(), capabilities: { authorDeformation: true, authorLod: true } }),
            root: this.projectionRoot(), view, authorChunks: true,
            renderer: { environment: environment.source, deformation: true, meshlets: true,
              adaptiveQuality: { enabled: true, collectHotspots: false },
              shadows: { exactProfile: { cascadeCount: 1, shadowMapSize } },
              features: { environment: true, groundPlane: false,
              groundGrid: false, screenSpaceReflection: true, toneMapping: "three-aces-r185" },
              ...(frameCaptureSession ? { frameCapture: { session: frameCaptureSession,
                readbacks: { requests: [{ resourceId: "present-color" as const }, { resourceId: "linear-depth" as const }] },
                onReadbackResults: createStudioFrameReadbackListener() } } : {}) },
            cameraLayerMask: this.viewer.camera.layers.mask, signal,
          });
        },
        prepare: async (backend, signal) => {
          await nextFrame(signal);
          updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
          // create 期间作者仍可编辑；重新投影并验证当前相机，而非发布创建时的快照。
          // 这不是 revision 锁：验证期间的连续动画仍由发布后的作者帧订阅追平。
          await backend.prepareScene(this.projectionRoot(), this.viewReader.renderViewDirect(canvas),
            this.viewer.camera.layers.mask, signal);
          readStudioDeepEnvironmentView(this.viewer.scene, this.viewer.usesAuthorPostProcessing());
          if (!environment || !isStudioDeepEnvironmentSourceCurrent(this.viewer.scene, environment)) {
            throw new Error("作者环境在候选准备期间已改变。");
          }
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
    // 静止视口没有帧回调，设备丢失必须主动通知，不能等待下一次用户输入。
    const session = (backend.runtime as { session?: RuntimeSession }).session;
    void session?.device?.lost.then((info) => {
      if (this.deepBackend === backend) this.failRuntime(new Error(info.message || info.reason));
    }).catch((reason) => {
      if (this.deepBackend === backend) this.failRuntime(reason);
    });
    this.unsubscribeFrame = this.viewer.subscribePresentationFrames(this.renderDeepFrame);
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
    const errors: unknown[] = [];
    for (const clean of [unsubscribe, () => backend?.dispose(), () => canvas?.remove()]) {
      try { clean?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Deep renderer cleanup failed.");
  }

  private readonly renderDeepFrame = (): void => {
    const backend = this.deepBackend;
    const canvas = this.deepCanvas;
    if (this.closed || this.activeBackendValue !== "webgpu" || !backend || !canvas) return;
    try {
      this.temporalSettler.cancel();
      this.updateAuthorMatrices();
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

  private renderCommittedFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement,
    view = this.viewReader.renderViewDirect(canvas)): void {
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
    this.temporalSettler.restart(draw);
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
