import { DEFAULT_DISPLAY_CONTRACT } from "@bim-studio/contracts";
import type {
  DeepWebGpuBackend,
  DeepWebGpuSyncResult,
  ThreeObjectSource,
} from "@bim-studio/deep-engine/three-bridge";
import type { AuthoredQualityProfile, ClusterLodSceneStaging, HdrDisplayRequest } from "@bim-studio/deep-engine/webgpu";
import { buildClusterLodAuthorStaging, clusterLodAuthorBakeFromModule } from "../delivery/buildClusterLodAuthorStaging";
import { publishStudioQualityTelemetry, type StudioDeepQualityTelemetrySampler } from "./StudioDeepQualityTelemetry";
import { StudioDeepRenderView } from "./StudioDeepRenderView";
import type { ViewerEngine } from "./ViewerEngine";
import type { RendererBackend } from "./viewerTypes";
import { prepareStudioRendererCandidate } from "./prepareStudioRendererCandidate";
import { observeRecoveryCandidate, recoveredAttemptCount } from "./studioRecoveryCandidate";
import { TemporalFrameSettler } from "./temporalFrameSettler";
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
import { sameHostCameraPose, type DeepCameraController } from "./deepCameraController";
import type { DeepCameraInputSession } from "./deepCameraInputSession";
import { DeepGizmoInteraction } from "./deepGizmoInteraction";
import { createDeepCanvas, prepareAuthorInputCanvas, captureAuthorStyle, restoreAuthorStyle,
  type AuthorCanvasStyle } from "./studioDeepPresentationCanvas";
import { collectDeepOverlayPrimitives } from "./deepOverlayPrimitiveSource";
import { resolveAlphaToCoverageCreateModes, isAlphaToCoverageRejection, isDeepAdvancedMaterialsRejection, sceneUsesAlphaToCoverage,
  packetUsesDeepAdvancedMaterials, sceneUsesDeepAdvancedMaterials } from "./studioDeepAdvancedMaterials";
import type { FrameCaptureSession, RenderPacket } from "@bim-studio/deep-engine";
import { createRequestedStudioFrameCaptureSession, createStudioFrameReadbackListener } from "./studioFrameCaptureDiagnostics";
import { publishDeepPresentation, publishWebGlPresentation, releaseDeepPresentation,
  type StudioDeepBridgePresentationHost } from "./studioDeepWebGpuBridgePresentation";
import { flowProbe, recordProbeSample, type DeepFlowProbe } from "./studioDeepWebGpuBridgeFlowProbe";
import { cameraSnapshot, renderViewFingerprint, sameSnapshot, resolveAuthorWorldTransform, threePrototypeHooks,
  nextFrame, type BridgeModuleLoader, type RuntimeSession, type DeepRenderView } from "./studioDeepWebGpuBridgeSceneHelpers";
import { markSwitchPhase, t11PipelineBootstrap, t07DynamicResolutionPolicy, b4HlodClusterEnabled, g1ClusterLodEnabled,
  t25GpuPassTimingEnabled, f4TemporalUpscaleEnabled, f3VirtualTexturesEnabled, debugFullRenderEnabled, sdfGiEnabled,
  megaLightsEnabled, rayTracedShadowsEnabled } from "./studioDeepWebGpuBridgeFeatureToggles";
import type { StudioDeepWebGpuBridgeOptions, StudioRendererSwitchResult } from "./studioDeepWebGpuBridgeOptions";

export { t11PipelineBootstrap, t07DynamicResolutionPolicy, b4HlodClusterEnabled, g1ClusterLodEnabled,
  t25GpuPassTimingEnabled, f4TemporalUpscaleEnabled, f3VirtualTexturesEnabled, sdfGiEnabled,
  megaLightsEnabled, rayTracedShadowsEnabled } from "./studioDeepWebGpuBridgeFeatureToggles";
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
  /** True after an immutable SceneSnapshot packet was accepted for this session. */
  private independentPacketPath = false;
  /** 带变形姿态的作者包:候选发布成功后据此建立逐帧姿态同步。 */
  private pendingDeformationPacket: RenderPacket | undefined;
  private deformationSync: StudioDeformationPoseSync | undefined;
  /** 独立包路径的描边实时同步(勾选"轮廓"/选中变化 → 仅翻转实例 outline 位)。 */
  private outlineSync: StudioDeepOutlineSync | undefined;
  /** 最近一次提交的 view 指纹:settle 背压只对相同指纹的重绘生效。 */
  private settledViewKey = "";
  /** 上次读到的 renderDemand 修订号:静置短路的变化信号(不可用时为 -1)。 */
  private lastDemandRevision = -1;
  /**
   * I-C21:构造期冻结的 HDR 请求快照。模块加载/设备创建是异步窗口,宿主在此
   * 窗口内改动传入对象不得改变实际下发的请求——每次 switchTo 重放同一份冻结
   * 快照,面板诊断可与之逐字段对账。
   */
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
    this.hdrDisplayRequest = options.hdrDisplay === undefined ? undefined : Object.freeze({ ...options.hdrDisplay });
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
    this.gizmoInteraction = new DeepGizmoInteraction(viewer, () => this.authorCanvas.getBoundingClientRect());
    prepareAuthorInputCanvas(this.authorCanvas);
  }

  get activeBackend(): RendererBackend { return this.activeBackendValue; }

  get diagnostics() {
    if (!this.deepBackend) return undefined;
    const backend = this.deepBackend.diagnostics;
    return { ...(backend ?? {}), ...(this.deepBackend.runtime.hdrDisplay ? { hdrDisplay: this.deepBackend.runtime.hdrDisplay } : {}), cameraFlow: { inFlight: this.cameraFramesInFlight,
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
    let candidateObserver: ReturnType<typeof observeRecoveryCandidate> | undefined;
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
          // 刀 C 首帧归因:作者包编译与 environment 并行的真实完成点(此前只有
          // environment-ready,包编译耗时长短无从归因)。
          if (authorRenderPacket) markSwitchPhase("deep-webgpu:packet-compiled");
          const pipelineBootstrap = t11PipelineBootstrap(authorRenderPacket !== undefined);
          this.independentPacketPath = authorRenderPacket !== undefined;
          this.pendingDeformationPacket = authorRenderPacket?.deformation ? authorRenderPacket : undefined;
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
          // 刀 C 首帧:独立包路径 create 与 prepare 用同一 view 构造器。此前
          // create 走 threeRenderView(不携带 editorOverlay),prepare 走
          // renderViewDirect(恒收集 Deep 原生辅助图形顶点),两条路径构造的
          // view 语义不同 → prepareView 的视图复用判定永不通过,每次切换都
          // 白付一次完整首帧验证(实测 ~270ms)。同源后,视口未变时 prepare
          // 直接复用 create 已验证的帧。
          const view = authorRenderPacket ? this.viewReader.renderViewDirect(canvas)
            : this.viewReader.renderView(module, canvas);
          shadowMapSize = view.lights?.directional?.[0]?.shadow?.mapSize
            ?? studioDeepShadowMapSize(this.viewer.scene, this.viewer.camera.layers.mask, shadowTierAllocation.shadowMapSize);
          frameCaptureSession = createRequestedStudioFrameCaptureSession();
          // A compiled SceneSnapshot packet is a complete Deep input. Keep the
          // Three projection bridge out of this path so geometry, materials,
          // hierarchy and transforms are never read from the author scene.
          // 仅当场景含激活的 clearcoat/sheen/iridescence/transmission lobe 时才启用 advancedMaterials 着色变体(按需编译,零开销默认)。
          const advancedMaterials = this.advancedMaterialsRequested || (authorRenderPacket
            ? packetUsesDeepAdvancedMaterials(authorRenderPacket) : sceneUsesDeepAdvancedMaterials(this.viewer.scene));
          // a2c 双模式判定与合同注释见 studioDeepAdvancedMaterials.resolveAlphaToCoverageCreateModes。
          const { alphaToCoverage, a2cMaskFallback } = resolveAlphaToCoverageCreateModes({
            requested: this.alphaToCoverageRequested, authorRenderPacket,
            scene: this.viewer.scene, maskFallbackActive: this.a2cMaskFallbackRequested });
          this.projectionBridge = authorRenderPacket ? undefined : new module.ThreeProjectionBridge({ hooks: threePrototypeHooks(),
            capabilities: { authorDeformation: true, authorLod: true, ...(advancedMaterials ? { advancedMaterials: true } : {}),
              ...(alphaToCoverage ? { alphaToCoverage: true } : {}),
              ...(a2cMaskFallback ? { alphaToCoverageMaskFallback: true } : {}) },
            authorTransformResolver: source => resolveAuthorWorldTransform(this.viewer, source),
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
          const backend = await module.DeepWebGpuBackend.create({
            canvas, gpu: navigator.gpu,
            ...(this.projectionBridge ? { projection: this.projectionBridge, root: this.projectionRoot() } : {}),
            view, authorChunks: true,
            ...(authorRenderPacket ? { renderPacket: authorRenderPacket } : {}),
            ...(authorHlodClusters?.length ? { hlodClusters: authorHlodClusters } : {}),
            ...(clusterLodStaging ? { clusterLodStaging } : {}),
            renderer: { environment: environment.source, deformation: true, meshlets: true,
              ...(advancedMaterials ? { advancedMaterials: true } : {}),
              ...(alphaToCoverage ? { msaaSampleCount: 4 } : {}),
              // F8 自动曝光零配置默认开（Z3.5 授权）：缺省参数由引擎 DEFAULT_PBR_AUTO_EXPOSURE 提供，
              // 无可靠亮度时 fail-closed 回退固定启发式并经 FrameMetrics.autoExposure 披露。
              autoExposure: {},
              ...(clusterLodEnabled ? { clusterLod: true } : {}),
              ...(resolutionScalePolicy ? { resolutionScalePolicy } : {}),
              ...(gpuPassTiming ? { gpuPassTiming: true } : {}),
              ...(virtualTextures ? { virtualTextures: { enabled: true } } : {}),
              ...(this.options.recovery && replacementBudget !== 0 ? { recovery: {
                ...this.options.recovery, ...(replacementBudget === undefined ? {} : { maxAttempts: replacementBudget }),
              } } : {}),
              ...(this.hdrDisplayRequest === undefined ? {} : { hdrDisplay: this.hdrDisplayRequest }),
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
              // features 只此一处：此前 F4 的条件 spread 与本字面量同名，后写覆盖前写，
              // temporalUpscale 从未真正进入渲染器；合并后 opt-in 才真正生效。
              // sdf-gi=1（Brief-GI M2/M3，opt-in 默认关）：开启后引擎构建 SDF GI 运行时，
              // 按包场景 revision 变化自动烘焙；关闭时不带该字段，帧逐位零变化。
              features: { ...(temporalUpscale ? { temporalUpscale: true } : {}),
                ...(debugFullRender ? { debugForceFullRender: true } : {}),
                ...(megaLights ? { megaLights: true } : {}),
                ...(rayTracedShadows ? { rayTracedShadows: true } : {}),
                ...(sdfGiEnabled() ? { sdfGi: true } : {}),
                environment: true, groundPlane: false,
                groundGrid: false, screenSpaceReflection: true, volumetricFog: true,
                toneMapping: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator },
              ...(frameCaptureSession ? { frameCapture: { session: frameCaptureSession,
                readbacks: { requests: [{ resourceId: "present-color" as const }, { resourceId: "linear-depth" as const }] },
                onReadbackResults: createStudioFrameReadbackListener() } } : {}) },
            cameraLayerMask: this.viewer.camera.layers.mask, signal,
          });
          markSwitchPhase("deep-webgpu:scene-uploaded");
          this.advancedMaterialsActive = advancedMaterials;
          this.alphaToCoverageActive = alphaToCoverage;
          this.a2cMaskFallbackActive = a2cMaskFallback;
          if (replacementBudget !== undefined && !signal.aborted) candidateObserver = observeRecoveryCandidate(backend, signal);
          return backend;
        },
        prepare: async (backend, signal) => {
          try {
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
          } catch (error) {
            const attempts = await candidateObserver?.retryAfter(error);
            if (attempts !== undefined && !signal.aborted && generation === this.generation) {
              this.recoveryCandidateFailure = { generation, attempts };
            }
            throw error;
          } finally { candidateObserver?.dispose(); }
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
      candidateObserver?.dispose();
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
    publishDeepPresentation(this as unknown as StudioDeepBridgePresentationHost, canvas, backend, environment, shadowMapSize, frameCaptureSession);
  }

  private publishWebGl(): void { publishWebGlPresentation(this as unknown as StudioDeepBridgePresentationHost); }

  private releaseDeep(): void { releaseDeepPresentation(this as unknown as StudioDeepBridgePresentationHost); }

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
      // Three AnimationMixer 已在作者帧推进;把骨骼/形变姿态读成 Deep 姿态。姿态变化即视为新画面,
      // 清除静置指纹以绕过 TAA 收敛背压,保证动画每帧都被绘制。
      if (this.deformationSync?.apply(backend)) this.settledViewKey = "";
      if (this.outlineSync?.apply(backend, this.viewer, () => {
        // 流送包的实例位异步落地:完成后补绘一帧。
        if (this.deepBackend !== backend) return;
        this.settledViewKey = ""; this.renderDeepFrame();
      })) this.settledViewKey = "";
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
        // A2C-P1 运行时降级决策点(渲染器只披露,决策在桥):探针判 a2c 掩码未生效、
        // 且当前 backend 是 a2c 门创建且未降级时,走与 restartWithAlphaToCoverage 同族的
        // 粘性事务重建。setTimeout(0) 逃出帧回调,不在渲染中重入切换事务。
        if (metrics.a2cProbe?.verdict === "ineffective" && this.alphaToCoverageActive
          && !this.a2cMaskFallbackActive && !this.a2cMaskFallbackRequested) {
          setTimeout(() => { if (!this.closed) this.restartWithAlphaToCoverageMaskFallback(); }, 0);
        }
      }
      this.shadowSession?.acknowledgeMapSize(metrics?.shadowMapSize);
      // F5-L4: 渲染帧之外仍可能欠捕获(初始填充/包 dirty/调度器 deferred),武装心跳泵。
      this.pumpProbeCapture();
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
    const state = this.viewer.getCameraState();
    if (!sameHostCameraPose(state, this.lastAppliedPose)) {
      // 宿主相机偏离控制器最后同步姿态 = 程序性变更(fitAll/标准视角/快照恢复):
      // 以宿主为准重设控制器,禁止把手势中的旧球坐标刷回覆盖程序性相机命令(与 WASM 桥同族)。
      this.controller.setPose([state.position.x, state.position.y, state.position.z],
        [state.target.x, state.target.y, state.target.z]);
      this.lastAppliedPose = this.controller.getPose();
      return;
    }
    if (stillConverging) {
      const pose = this.controller.getPose();
      this.viewer.applyViewportCameraPose?.(pose);
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
