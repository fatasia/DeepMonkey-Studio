import * as THREE from "three";
import type {
  DeepWebGpuBackend,
  DeepWebGpuSyncResult,
  HlodClusterStreamBinding,
  ThreeObjectSource,
} from "@bim-studio/deep-engine/three-bridge";
import type { AuthoredQualityProfile, ClusterLodSceneStaging, DeviceRecoveryOptions } from "@bim-studio/deep-engine/webgpu";
import { DEFAULT_RESOLUTION_SCALE_POLICY } from "@bim-studio/deep-engine/postprocess";
import { buildClusterLodAuthorStaging, clusterLodAuthorBakeFromModule } from "../delivery/buildClusterLodAuthorStaging";
import { StudioDeepQualityTelemetrySampler, publishStudioQualityTelemetry,
  type StudioQualityTelemetryOptions } from "./StudioDeepQualityTelemetry";
import type { ViewerEngine } from "./ViewerEngine";
import type { RendererBackend } from "./viewerTypes";
import { prepareStudioRendererCandidate } from "./prepareStudioRendererCandidate";
import { TemporalFrameSettler } from "./temporalFrameSettler";
import { studioDeepShadowAllocation, studioDeepShadowMapSize, studioDeepShadowTier } from "./studioDeepShadowAllocation";
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
  readonly onFatalLoss?: (listener: (reason: { readonly message: string }) => void) => () => void;
  readonly onDeviceRecreated?: (listener: (epoch: number) => void) => () => void;
  readonly device?: { readonly lost: Promise<{ readonly message: string; readonly reason: string }>;
    readonly queue?: { onSubmittedWorkDone(): Promise<void> } };
}

type DeepRenderView = ReturnType<StudioDeepRenderView["renderViewDirect"]>;

interface DeepFlowProbe {
  renderDeepFrame: number; cameraPath: number; syncPath: number; coalesced: number;
  draws: number; viewMs: number; renderMs: number; samples: string[];
  syncCount?: number; syncMs?: number; shortCircuits?: number; keyChanges?: number; demand?: unknown;
}

/** pointer→submit 链路归因探针:仅在宿主预先挂载 window.__deepFlowProbe 时
 * 按帧累计各层调用与耗时;默认零开销(一次属性读取),不影响任何行为。 */
function flowProbe(): DeepFlowProbe | undefined {
  return (globalThis as { __deepFlowProbe?: DeepFlowProbe }).__deepFlowProbe;
}

function recordProbeSample(probe: DeepFlowProbe, tag: string, ...values: readonly number[]): void {
  if (probe.samples.length >= 48) probe.samples.shift();
  probe.samples.push(`${tag}:${values.map(v => v.toFixed(2)).join(",")}`);
}

export interface StudioDeepWebGpuBridgeOptions {
  readonly onRuntimeFailure?: (error: Error) => void;
  readonly loadModule?: BridgeModuleLoader;
  readonly preparationTimeoutMs?: number;
  /** Maximum submitted camera views awaiting GPU queue completion. */
  readonly cameraFrameInFlightLimit?: 1 | 2;
  /** Optional packet compiled from SceneSnapshot; when provided Deep skips
   * Three scene projection for candidate publication. */
  readonly authorRenderPacket?: (signal: AbortSignal) => Promise<RenderPacket | undefined>;
  /**
   * B4 簇级 HLOD(opt-in,`b4-hlod-cluster=1`):逐放置簇绑定提供方;仅在独立
   * 作者包路径下被消费,与 authorRenderPacket 共享同一编译缓存由宿主保证。
   */
  readonly authorHlodClusters?: (signal: AbortSignal) => Promise<readonly HlodClusterStreamBinding[] | undefined>;
  /** T25 质量遥测采样配置;缺省 4Hz 聚合、256 帧窗口。 */
  readonly qualityTelemetry?: StudioQualityTelemetryOptions;
  /** C13 recovery is explicit opt-in; omitted keeps the legacy bridge behavior. */
  readonly recovery?: DeviceRecoveryOptions;
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
  private quality: StudioDeepQualityTelemetrySampler | undefined;
  private qualityProfile: AuthoredQualityProfile | null = null;
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
  /** 最近一次提交的 view 指纹:settle 背压只对相同指纹的重绘生效。 */
  private settledViewKey = "";
  /** 上次读到的 renderDemand 修订号:静置短路的变化信号(不可用时为 -1)。 */
  private lastDemandRevision = -1;

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
          // 作者包编译与 GPU 环境准备互不依赖，重叠执行以压缩切换前段；
          // 两者都只读作者场景，顺序 await 之外的并发不引入新的写入竞争。
          const packetTask = this.options.authorRenderPacket?.(signal);
          environment = await prepareStudioDeepEnvironmentSource(this.viewer.scene, signal);
          markSwitchPhase("deep-webgpu:environment-ready");
          const postProcessing = this.viewer.getPostProcessing();
          this.qualityProfile = postProcessing.qualityProfile ?? null;
          // Z1 P1：阴影分配档跟随作者质量档（引擎既有 PROFILES 表映射，零契约漂移）。
          const shadowTier = studioDeepShadowTier(this.qualityProfile);
          const shadowTierAllocation = studioDeepShadowAllocation(shadowTier);
          const authorRenderPacket = (await packetTask) ?? undefined;
          const pipelineBootstrap = t11PipelineBootstrap(authorRenderPacket !== undefined);
          this.independentPacketPath = authorRenderPacket !== undefined;
          this.viewer.setAuthorPacketIndependent(this.independentPacketPath);
          if (!authorRenderPacket) updateAuthorProjectionState(this.viewer.scene, this.viewer.camera, signal);
          else this.viewReader.setIndependentPacketBounds(authorRenderPacket);
          // B4 簇级 HLOD(opt-in):仅独立作者包路径消费;默认关闭不改变现网行为。
          const authorHlodClusters = b4HlodClusterEnabled() && authorRenderPacket
            ? (await this.options.authorHlodClusters?.(signal)) ?? undefined : undefined;
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
          const view = this.viewReader.renderView(module, canvas);
          shadowMapSize = view.lights?.directional?.[0]?.shadow?.mapSize
            ?? studioDeepShadowMapSize(this.viewer.scene, this.viewer.camera.layers.mask, shadowTierAllocation.shadowMapSize);
          frameCaptureSession = createRequestedStudioFrameCaptureSession();
          // A compiled SceneSnapshot packet is a complete Deep input. Keep the
          // Three projection bridge out of this path so geometry, materials,
          // hierarchy and transforms are never read from the author scene.
          this.projectionBridge = authorRenderPacket ? undefined : new module.ThreeProjectionBridge({ hooks: threePrototypeHooks(), capabilities: { authorDeformation: true, authorLod: true },
            authorTransformResolver: source => resolveAuthorWorldTransform(this.viewer, source),
          });
          // T07 动态分辨率与 T25 逐 pass 计时均为 opt-in；缺省字段不进快照。
          const resolutionScalePolicy = t07DynamicResolutionPolicy();
          const gpuPassTiming = t25GpuPassTimingEnabled();
          // F4 超分需动态分辨率同开(scale<1 才激活);F3 虚拟纹理独立开关。
          const temporalUpscale = resolutionScalePolicy !== undefined && f4TemporalUpscaleEnabled();
          const virtualTextures = f3VirtualTexturesEnabled();
          const backend = await module.DeepWebGpuBackend.create({
            canvas, gpu: navigator.gpu,
            ...(this.projectionBridge ? { projection: this.projectionBridge, root: this.projectionRoot() } : {}),
            view, authorChunks: true,
            ...(authorRenderPacket ? { renderPacket: authorRenderPacket } : {}),
            ...(authorHlodClusters?.length ? { hlodClusters: authorHlodClusters } : {}),
            ...(clusterLodStaging ? { clusterLodStaging } : {}),
            renderer: { environment: environment.source, deformation: true, meshlets: true,
              ...(clusterLodEnabled ? { clusterLod: true } : {}),
              ...(resolutionScalePolicy ? { resolutionScalePolicy } : {}),
              ...(gpuPassTiming ? { gpuPassTiming: true } : {}),
              ...(temporalUpscale ? { features: { temporalUpscale: true } } : {}),
              ...(virtualTextures ? { virtualTextures: { enabled: true } } : {}),
              ...(this.options.recovery ? { recovery: this.options.recovery } : {}),
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
    this.viewer.setAuthorPacketIndependent(this.independentPacketPath);
    this.frameCaptureSession = frameCaptureSession;
    publishStudioFrameCaptureSession(frameCaptureSession);
    this.performanceSource = new StudioDeepPerformance(backend.runtime as ConstructorParameters<typeof StudioDeepPerformance>[0]);
    this.performanceSource.setDiagnosticsSource(() => {
      const diagnostics = backend.diagnostics;
      return diagnostics?.probeClipmap ? { probeClipmap: diagnostics.probeClipmap } : undefined;
    });
    this.viewer.setPresentationPerformanceSource(this.performanceSource);
    // T25:每个 Deep 会话一个采样器;先发布"等待采样"状态,面板立即可见会话存在。
    this.quality = new StudioDeepQualityTelemetrySampler(this.options.qualityTelemetry,
      this.qualityProfile, () => backend.chunkStreaming?.residentGpuBytes);
    publishStudioQualityTelemetry(this.quality.status());
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
    const unsubscribeFatalLoss = backend.onFatalLoss?.(reason => {
      if (this.deepBackend === backend) this.failRuntime(new Error(reason.message));
    });
    const unsubscribeRecreated = backend.onDeviceRecreated?.(() => {
      if (this.deepBackend !== backend) return;
      this.syncPending = undefined;
      this.syncAgain = undefined;
      this.settleFrameInFlight = false;
      this.settleFrameBackend = undefined;
      this.lastCameraSnapshot = undefined;
      this.settledViewKey = "";
      this.lastDemandRevision = -1;
      this.renderDeepFrame();
    });
    const legacyLoss = session?.onFatalLoss === undefined && session?.device?.lost;
    if (legacyLoss) void legacyLoss.then((info) => {
      if (this.deepBackend === backend) this.failRuntime(new Error(info.message || info.reason));
    }).catch((reason) => {
      if (this.deepBackend === backend) this.failRuntime(reason);
    });
    const unsubscribeFrames = this.viewer.subscribePresentationFrames(this.renderPresentationFrame);
    const previousUnsubscribe = this.unsubscribeFrame;
    this.unsubscribeFrame = () => {
      unsubscribeFrames();
      previousUnsubscribe?.();
      unsubscribeFatalLoss?.();
      unsubscribeRecreated?.();
    };
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
    this.viewer.setAuthorPacketIndependent(false);
    this.viewer.setPresentationPerformanceSource(undefined);
    this.quality = undefined;
    publishStudioQualityTelemetry(undefined);
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
    this.settledViewKey = "";
    this.lastDemandRevision = -1;
    this.qualityProfile = null;
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
    const probe = flowProbe();
    if (probe) { probe.renderDeepFrame++; recordProbeSample(probe, "rdf"); }
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
      if (probe) recordProbeSample(probe, "cam", camera[0]!, camera[1]!, camera[3]!, camera[4]!);
      const cameraChanged = !sameSnapshot(camera, this.lastCameraSnapshot);
      this.lastCameraSnapshot = camera;
      const shouldSync = !cameraChanged;
      if (!shouldSync) {
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
      const demand = this.viewer.getRenderDemandDiagnostics?.();
      this.viewReader.setSceneRevision(demand?.invalidationRevision);
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
    if (this.cameraFramesInFlight >= this.cameraFrameInFlightLimit) {
      // Replace, never append: stale camera poses have no semantic value after
      // newer input. Scene/material edits are preserved by the trailing sync.
      // 消费时机由 renderDeepFrame 驱动(下一作者帧相机路径覆盖/主路径呈现后
      // 清空),GPU 完成回调不做即时重放——见 completeCameraFrame 的合并注释。
      this.pendingCameraView = view;
      this.cameraFramesCoalesced++;
      if (probe) probe.coalesced++;
      // 合并不再静默丢帧:本 rAF 必须至少完成一次 submit,否则该帧在 GPU 侧
      // 零呈现,输入尾延迟撞上整帧间隔(submitGap p95 45ms 的来源)。提交即
      // 释放名额的语义下,在飞计数只反映同一事件循环内的重入;真实节流由
      // swapchain present 上限承担,pending 交给下一帧覆盖。
      if (this.cameraFramesInFlight > 0) this.cameraFramesInFlight--;
      this.renderCommittedFrame(backend, canvas, view, false);
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
    // 提交即释放名额。相机帧的在飞计数只保护同一帧内的重复进入,不再等待
    // queue.onSubmittedWorkDone:该回调在 Chrome/Dawn 按 vsync 粒度滞后 2-3 帧
    // 才 resolve,把它当提交背压会把相机帧限流到每 2 帧一次(submitGap p50
    // 33ms,pointer→submit P95 40ms+)。真实帧率背压由浏览器 swapchain 的
    // present 上限与作者帧 rAF 节奏提供;GPU 帧编码仅 0.1ms 级,队列不会积压。
    // pending 的合并语义不变:被合并的旧 view 不回放,由下一次 renderDeepFrame
    // 以更新后的 view 覆盖,80ms 尾随 sync 兜底。
    this.completeCameraFrame(backend);
  }

  /** 释放一个在飞名额(同帧内重复进入仍受 cameraFrameInFlightLimit 约束)。 */
  private completeCameraFrame(backend: DeepWebGpuBackend): void {
    if (this.deepBackend !== backend) return;
    this.cameraFramesInFlight = Math.max(0, this.cameraFramesInFlight - 1);
  }

  private renderCommittedFrame(backend: DeepWebGpuBackend, canvas: HTMLCanvasElement,
    view = this.viewReader.renderViewDirect(canvas), settle = true): void {
    // settle 背压只作用于"同一 view 的 TAA 收敛重绘";view 指纹变化(相机、
    // 编辑辅助投影、尺寸)意味着用户可见状态更新,首绘无条件直绘。
    // onSubmittedWorkDone 在 Chrome 按 vsync 粒度滞后 2-3 帧 resolve,若它连
    // 新 view 一起挡住,场景编辑/资源同步期间的呈现会被限流到每 2-3 个 rAF
    // 一次(submitGap p50 32ms 的第二处来源);而完全静置(view 不变)时保留
    // 背压,避免 settle 序列被每帧首绘不断重启(静置 P95 7.2ms 的前提)。
    let settling = false;
    const viewKey = renderViewFingerprint(view);
    const draw = (): boolean => {
      if (this.deepBackend !== backend) return false;
      if (settling && this.settleFrameInFlight && this.settleFrameBackend === backend
        && viewKey === this.settledViewKey) return false;
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
      }
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
      handleGizmoPointer: (phase, event) => {
        const consumed = this.gizmoInteraction.handle(phase, event);
        const probe = flowProbe();
        if (probe) recordProbeSample(probe, `gizmo:${phase}=${consumed ? 1 : 0}@${Math.round(event.clientX)},${Math.round(event.clientY)}`);
        return consumed;
      },
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

/** 呈现指纹:eye/target/尺寸/编辑辅助投影/灯光摘要的轻量序列。编辑辅助(选择
 * 盒/gizmo/测量线)的顶点校验和与灯光强度/颜色随场景状态变化,足以区分"同一
 * 画面"与"新状态";未纳入指纹的编辑仍由保底重同步与 settle 序列收敛。 */
function renderViewFingerprint(view: DeepRenderView): string {
  const overlay = view.editorOverlay;
  let overlaySum = 0;
  if (overlay && "vertices" in overlay) {
    const vertices = overlay.vertices as ArrayLike<number>;
    for (let index = 0; index < vertices.length; index += 12) overlaySum += vertices[index]!;
  }
  const lights = view.lights;
  let lightsKey = "0";
  if (lights) {
    const digest: string[] = [];
    for (const light of lights.directional ?? []) digest.push(`${light.intensity?.toFixed(3)},${light.color?.map(v => v.toFixed(2)).join(".")}`);
    for (const light of lights.points ?? []) digest.push(`${light.intensity?.toFixed(3)}`);
    for (const light of lights.spots ?? []) digest.push(`${light.intensity?.toFixed(3)}`);
    lightsKey = digest.join(";");
  }
  return `${view.eye[0]},${view.eye[1]},${view.eye[2]},${view.target[0]},${view.target[1]},${view.target[2]},`
    + `${view.width}x${view.height}@${view.pixelRatio}|ov:${overlay ? overlay.revision : -1}:${overlaySum.toFixed(2)}|li:${lightsKey}`;
}

function markSwitchPhase(name: string): void {
  if (typeof performance?.mark === "function") performance.mark(name);
}

/**
 * T11 首帧管线时序开关：独立作者包路径生产默认启用两个可独立回退的时序优化——
 * 首帧关键管线子集（`t11-critical-pipelines=0` 关闭）与变形变体延迟创建
 * （`t11-defer-deformation=0` 关闭）。两开关只改变"发布前等待哪些变体"，
 * 不改变任何帧的画质与管线集合内容。
 */
export function t11PipelineBootstrap(hasAuthorPacket: boolean):
  { firstFrameSubset: boolean; deferDeformation: boolean } | undefined {
  if (!hasAuthorPacket) return undefined;
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const enabled = (name: string): boolean => {
    const value = params?.get(name)?.toLowerCase();
    return value !== "0" && value !== "false" && value !== "off";
  };
  return { firstFrameSubset: enabled("t11-critical-pipelines"), deferDeformation: enabled("t11-defer-deformation") };
}

/**
 * T07 动态内部分辨率接入开关：默认关闭（67% 模式画质未经 GPU 序列联测，不冒充
 * 默认优秀画质）；`t07-dynamic-resolution=1` 显式开启后按帧时反馈在 0.5–1 之间
 * 调整内部渲染比例。开启即消费 deep-engine `resolutionScalePolicy` 能力。
 */
export function t07DynamicResolutionPolicy():
  import("@bim-studio/deep-engine/postprocess").ResolutionScalePolicy | undefined {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("t07-dynamic-resolution")?.toLowerCase();
  if (value !== "1" && value !== "true" && value !== "on") return undefined;
  return { ...DEFAULT_RESOLUTION_SCALE_POLICY };
}

/**
 * B4 簇级 HLOD 驻留感知隐藏开关：默认关闭（簇代理画质与切换序列未过浏览器视觉
 * 闭环，不冒充默认体验）；`b4-hlod-cluster=1` 显式开启后，Deep 后端按相机消费
 * 簇决策做 demand 过滤 + 行置零补偿 + 代理 overlay 注入，选择/剖切/测量
 * （编辑辅助 overlay 顶点非空）强制原件驻留。
 */
export function b4HlodClusterEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("b4-hlod-cluster")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * G1 簇级微多边形槽位开关：默认关闭（作者链路帧时收益未过真机对照，不冒充默认
 * 体验）；`g1-cluster-lod=1` 显式开启后，宿主把作者包合并静态几何 bake 成簇级
 * DAG 随 create 下发，backend 在静态包发布成功后注入渲染器槽位（像素阈值选层 +
 * indirect RenderBundle 进默认 opaque pass）。注入失败仅记诊断，不打断渲染链。
 */
export function g1ClusterLodEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("g1-cluster-lod")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * T25 逐 pass GPU 计时采集开关（F1）：默认关闭（timestamp 查询有逐帧开销）；
 * `t25-gpu-pass-timing=1` 开启后 T25 面板出现「逐 Pass GPU 耗时」小节。
 */
export function t25GpuPassTimingEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("t25-gpu-pass-timing")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * F4 时域超分采集开关：`f4-temporal-upscale=1`。需与 `t07-dynamic-resolution=1`
 * 同开——超分在 scale<1 时才激活（temporalUpscaleActive 门），单开无效。
 */
export function f4TemporalUpscaleEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("f4-temporal-upscale")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** F3 虚拟纹理开关：`f3-virtual-textures=1`（opt-in，默认整纹理驻留路径零变化）。 */
export function f3VirtualTexturesEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("f3-virtual-textures")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
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
