import { validateClusterLodStagingShape, localizeClusterLodStaging } from "./deepWebGpuClusterStaging.js";
import { snapshotEnvironment, snapshotRendererOptions } from "./deepWebGpuOptions.js";
import { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
import { AuthorChunkStream, type AuthorChunkStreamRuntime } from "./authorChunkStream.js";
import { applyHlodPlanToInstances, hlodClusterStreamResources, hlodPlanSignature,
  HlodClusterDecisionEngine, type HlodClusterFramePlan, type HlodClusterStreamBinding,
  type HlodClusterStreamResources } from "./hlodClusterStream.js";
import type { ProjectionIssue, ProjectionResult, ThreeObjectSource } from "./types.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import type { DeformationPose } from "../deformation/types.js";
import { PbrRenderer, type FrameMetrics, type PbrRendererOptions, type RenderView } from "../webgpu/pbrRenderer.js";
import type { ClusterLodSceneStaging } from "../webgpu/clusterLodRenderSlot.js";
import { bakeClusterLodDag, type ClusterLodBakeInput, type ClusterLodBakeResult } from "../rayTracing/clusterLodBake.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import { snapshotShadows, shadowSelection, type DeepWebGpuShadowSelection } from "./deepWebGpuShadowPolicy.js";
import { ProbeClipmapPbrController, type ProbeClipmapPbrTarget } from "../webgpu/probeClipmapPbrController.js";
import { DeepWebGpuProbeClipmapSession, type DeepWebGpuProbeClipmapDiagnostics } from "./DeepWebGpuProbeClipmapSession.js";
import { CameraRelativeCoordinates, type CameraRelativeCoordinateSnapshot } from "./cameraRelativeCoordinates.js";
import { indexObjectBindings } from "./objectBindingIndex.js";
import { packetFirstFrameRendererOptions, projectionFirstFrameMainKeys } from "./firstFramePipelineKeys.js";
import type { DeviceEvent } from "../webgpu/deviceSession.js";
import { RendererDeviceEpoch } from "../webgpu/rendererDeviceEpoch.js";
export type { DeepWebGpuShadowSelection } from "./deepWebGpuShadowPolicy.js";

export type {
  DeepWebGpuBackendCreateRequest,
  DeepWebGpuBackendOptions,
  DeepWebGpuBackendRuntime,
  DeepWebGpuRenderRuntime,
  DeepWebGpuRuntimeFactory,
  DeepWebGpuSyncResult,
} from "./DeepWebGpuBackend.types.js";
import type {
  DeepWebGpuBackendCreateRequest,
  DeepWebGpuBackendOptions,
  DeepWebGpuRenderRuntime,
  DeepWebGpuRuntimeFactory,
  DeepWebGpuSyncResult,
} from "./DeepWebGpuBackend.types.js";

export class DeepWebGpuProjectionError extends Error {
  constructor(readonly issues: readonly ProjectionIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join("\n") || "Three scene projection failed.");
    this.name = "DeepWebGpuProjectionError";
  }
}

/**
 * 把作者侧 Three 层级投影到 Deep RenderPacket，并在 GPU 接受后确认快照。
 *
 * `sync` 的 full 路径等待真实 GPU validation 完成；仅变换变化时走 instances
 * 增量路径。投影 token 由 bridge 管理，新的投影会使迟到结果变为 superseded，
 * 从而避免旧场景在异步验证结束后抢回当前后端。
 */
export class DeepWebGpuBackend {
  readonly id = "deep-webgpu";
  private disposed = false;
  private syncGeneration = 0;
  private shadowSelectionValue: DeepWebGpuShadowSelection | undefined;
  private readonly expectedShadows: PbrRendererOptions["shadows"];
  private chunks: AuthorChunkStream | undefined;
  private packetViewInFlight = false;
  private packetPreparing = false;
  private packetViewRequested: RenderView | undefined;
  private packetViewStaged: RenderView | undefined;
  private packetViewFailure: unknown;
  private packetViewRetryAt = 0;
  private probeClipmap: DeepWebGpuProbeClipmapSession | undefined;
  private committedPacket: RenderPacket | undefined;
  /** 独立包路径最近一次整包发布的实例表(含簇计划);仅带变形姿态的包保留,供逐帧姿态更新复用。 */
  private publishedInstances: RenderPacket["instances"] | undefined;
  /** 宿主驱动描边集合最近一次落到 GPU 的实例表;缺省表示沿用整包编译时的 outline 位。 */
  private outlineInstances: RenderPacket["instances"] | undefined;
  /** 最近一次渲染的作者视图(流送包描边更新据此取相机闭包);dispose 清空。 */
  private latestView: RenderView | undefined;
  private modelByInstanceId = new Map<string, string>();
  /** B4 簇级决策引擎与代理 overlay 资源;仅在独立 RenderPacket 路径初始化。 */
  private clusterEngine: HlodClusterDecisionEngine | undefined;
  private clusterResources: HlodClusterStreamResources | undefined;
  private appliedClusterSignature = "";
  /** 最近一次通过整帧验证的视图指纹与结果；prepareView 视图未变时复用。 */
  private validatedView: { readonly view: RenderView; readonly shadowSelection: DeepWebGpuShadowSelection | undefined } | undefined;
  private validatedFrame: FrameMetrics | undefined;
  private readonly deviceEpoch: RendererDeviceEpoch | undefined;
  /** Set for the immutable author packet path; no Three hierarchy is retained. */
  private independentPacket = false;
  private readonly coordinates = new CameraRelativeCoordinates();
  private pendingCoordinate: CameraRelativeCoordinateSnapshot | undefined;
  /** G1 簇级槽位注入状态：恰一次守卫 + 最近一次失败诊断。 */
  private clusterLodStaged = false;
  private clusterLodStagingError: unknown = undefined;

  constructor(
    readonly runtime: DeepWebGpuRenderRuntime,
    readonly projection: ThreeProjectionBridge | undefined,
    private readonly options: DeepWebGpuBackendOptions = {},
  ) {
    if (runtime.session?.device) this.deviceEpoch = new RendererDeviceEpoch(runtime.session.device);
    if (runtime.id !== this.id) throw new Error(`Deep runtime id must be ${this.id}.`);
    if (options.authorChunks !== undefined && typeof options.authorChunks !== "boolean") throw new TypeError("authorChunks must be boolean.");
    if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("meshlets must be boolean.");
    if (options.hlodClusters !== undefined && !Array.isArray(options.hlodClusters)) throw new TypeError("hlodClusters must be an array.");
    if (options.hlodCollapseSuppressed !== undefined && typeof options.hlodCollapseSuppressed !== "function") {
      throw new TypeError("hlodCollapseSuppressed must be a function.");
    }
    if (options.clusterLodStaging !== undefined) validateClusterLodStagingShape(options.clusterLodStaging);
    this.expectedShadows = options.expectedShadows === undefined ? undefined : snapshotShadows(options.expectedShadows);
  }

  onDeviceRecreated(listener: (epoch: number) => void): () => void {
    return this.runtime.session?.onDeviceRecreated?.(listener) ?? (() => {});
  }
  onFatalLoss(listener: (reason: DeviceEvent) => void): () => void {
    return this.runtime.session?.onFatalLoss?.(listener) ?? (() => {});
  }
  async stageEnvironment(source: PbrEnvironmentSource, signal?: AbortSignal): Promise<"staged" | "superseded"> {
    if (this.disposed) throw new Error("Deep backend is disposed.");
    if (!this.runtime.stageEnvironment) throw new Error("Deep runtime cannot stage environment changes.");
    return this.runtime.stageEnvironment(snapshotEnvironment(source), signal);
  }

  async stageShadowMapSize(mapSize: number, signal?: AbortSignal): Promise<"staged" | "superseded"> {
    if (this.disposed) throw new Error("Deep backend is disposed.");
    if (!this.runtime.stageShadowMapSize) throw new Error("Deep runtime cannot stage shadow map changes.");
    if (!Number.isSafeInteger(mapSize) || mapSize < 64 || mapSize > 16_384) {
      throw new RangeError("Invalid exact shadow map size.");
    }
    return this.runtime.stageShadowMapSize(mapSize, signal);
  }

  /** Creates and validates an owned PBR runtime from an immutable settings snapshot. */
  static async create(request: DeepWebGpuBackendCreateRequest,
    factory: DeepWebGpuRuntimeFactory = PbrRenderer): Promise<DeepWebGpuBackend> {
    markBackendPhase("backend-create-start");
    const validated = validateCreateRequest(request);
    const signal = validated.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortError("Deep backend creation cancelled.");
    const rendererSettings = snapshotRendererOptions(validated.renderer ?? {});
    // 首帧最小集(T11 语义推广,首帧攻坚 2026-10-07):独立包路径直接推导;投影路径
    // 在 create 前做一次 CPU 预投影推导同形关键 main 键(预投影不 acknowledge,
    // epoch 守卫使其被 sync 的正式投影自然作废)。发布只等待首帧必需变体,其余
    // main/页/mask 阴影变体由既有分级门(首帧验证后 release)背景补齐 —— 与包路径
    // 生产语义同源。`pipelines.firstFrameSubset === false` 显式退出回全量等待。
    const firstFrameMainKeys = rendererSettings.pipelines?.firstFrameSubset === false ? undefined
      : !validated.renderPacket && validated.projection && validated.root
        ? projectionFirstFrameMainKeys(validated.projection, validated.root,
          validated.cameraLayerMask, validated.view, rendererSettings.advancedMaterials === true)
        : undefined;
    const renderer = validated.renderPacket ? packetFirstFrameRendererOptions(rendererSettings, validated.renderPacket) : firstFrameMainKeys
      ? Object.freeze({ ...rendererSettings, pipelines: Object.freeze({
          ...rendererSettings.pipelines,
          firstFrameSubset: true,
          firstFrameMainKeys: Object.freeze(firstFrameMainKeys),
        }) })
      : rendererSettings;
    const authorChunks = validated.authorChunks;
    markBackendPhase("runtime-create-start");
    const runtime = await factory.create(validated.canvas, validated.gpu, signal, renderer);
    markBackendPhase("runtime-ready");
    if (signal.aborted) {
      runtime.dispose();
      throw abortError("Deep backend creation cancelled.");
    }
    let backend: DeepWebGpuBackend;
    try {
      backend = new DeepWebGpuBackend(runtime, validated.projection, {
        ...(validated.cameraLayerMask === undefined ? {} : { cameraLayerMask: validated.cameraLayerMask }),
        ...(renderer.shadows === undefined ? {} : { expectedShadows: renderer.shadows }),
        ...(authorChunks === undefined ? {} : { authorChunks }),
        ...(renderer.meshlets === undefined ? {} : { meshlets: renderer.meshlets }),
        ...(validated.hlodClusters === undefined ? {} : { hlodClusters: validated.hlodClusters }),
        ...(validated.hlodCollapseSuppressed === undefined ? {} : { hlodCollapseSuppressed: validated.hlodCollapseSuppressed }),
        ...(validated.clusterLodStaging === undefined ? {} : { clusterLodStaging: validated.clusterLodStaging }),
        ...(renderer.recovery === undefined ? {} : { recovery: renderer.recovery }),
      });
    } catch (error) {
      runtime.dispose();
      throw error;
    }
    try {
      if (validated.renderPacket) {
        backend.independentPacket = true;
        await backend.prepareRenderPacket(validated.renderPacket, validated.view, signal);
        // 首帧验证已通过：此刻放行背景管线排队，发布不再被背景编译争抢。
        releaseBackgroundPipelineQueues(runtime);
        markBackendPhase("backend-create-ready");
        return backend;
      }
      if (!validated.projection || !validated.root) throw new TypeError("Deep backend requires projection/root when renderPacket is absent.");
      await backend.prepareScene(validated.root, validated.view, validated.cameraLayerMask, signal);
      releaseBackgroundPipelineQueues(runtime);
      markBackendPhase("backend-create-ready");
      return backend;
    } catch (error) { backend.dispose(); throw error; }
  }

  /** 接管已创建的 GPU runtime，并且只返回通过场景投影和首帧门禁的候选。 */
  static async prepare(
    runtime: DeepWebGpuRenderRuntime,
    projection: ThreeProjectionBridge,
    root: ThreeObjectSource,
    view: RenderView,
    options: DeepWebGpuBackendOptions & { readonly signal?: AbortSignal } = {},
  ): Promise<DeepWebGpuBackend> {
    let backend: DeepWebGpuBackend;
    try { backend = new DeepWebGpuBackend(runtime, projection, options); }
    catch (error) { runtime.dispose(); throw error; }
    try {
      await backend.prepareScene(root, view, options.cameraLayerMask, options.signal);
      releaseBackgroundPipelineQueues(runtime);
      return backend;
    } catch (error) {
      backend.dispose();
      throw error;
    }
  }

  async prepareScene(
    root: ThreeObjectSource,
    view: RenderView,
    cameraLayerMask = this.options.cameraLayerMask ?? 1,
    signal?: AbortSignal,
  ): Promise<FrameMetrics> {
    const synced = await this.sync(root, cameraLayerMask, signal, view);
    if (synced.status === "rejected") throw new DeepWebGpuProjectionError(synced.issues);
    if (synced.status !== "committed" || signal?.aborted) {
      throw abortError("Deep backend preparation cancelled or superseded.");
    }
    const frame = await this.runtime.validateFrame(view);
    this.shadowSelectionValue = shadowSelection(frame, this.expectedShadows);
    if (signal?.aborted) throw abortError("Deep backend preparation cancelled.");
    return frame;
  }

  /** Publish a packet compiled from SceneSnapshot without traversing a Three
   * hierarchy. This is the independent author path; the legacy scene path
   * remains available through prepareScene/sync. */
  async prepareRenderPacket(packet: RenderPacket, view: RenderView, signal?: AbortSignal): Promise<FrameMetrics> {
    this.packetPreparing = true;
    try { return await this.prepareRenderPacketTransaction(packet, view, signal); }
    finally { this.packetPreparing = false; }
  }
  /** Update world-space instances against resident resources, then validate the visible frame. */
  async prepareInstanceTransforms(instances: RenderPacket["instances"], poses: readonly DeformationPose[] | undefined,
    view: RenderView, signal?: AbortSignal): Promise<FrameMetrics | undefined> {
    const previous = this.committedPacket;
    if (!this.independentPacket || !previous || this.chunks || this.clusterEngine) return undefined;
    const packet = { ...previous, instances, ...(previous.deformation
      ? { deformation: { ...previous.deformation, poses: poses ?? previous.deformation.poses } } : {}) };
    this.packetPreparing = true;
    try { return await this.prepareRenderPacketTransaction(packet, view, signal, true); }
    finally { this.packetPreparing = false; }
  }
  private async prepareRenderPacketTransaction(packet: RenderPacket, view: RenderView, signal?: AbortSignal, instancesOnly = false): Promise<FrameMetrics> {
    this.assertOpen();
    signal?.throwIfAborted();
    markBackendPhase("packet-localize-start");
    if (this.options.hlodClusters?.length && !this.clusterEngine) {
      // 代理 overlay 资源(几何按 HLOD 前缀,材质按合成 id)必须来自原始包;
      // 编译层把簇代理几何随包分发,编目过程会丢弃未引用几何,此处先行提取。
      this.clusterResources = hlodClusterStreamResources(packet);
      this.clusterEngine = new HlodClusterDecisionEngine(this.options.hlodClusters,
        this.options.hlodCollapseSuppressed);
    }
    const candidate = this.coordinates.candidate(view.eye);
    const localPacket = this.coordinates.localizePacket(packet, candidate);
    markBackendPhase("packet-localized");
    const localView = this.coordinates.localizeView(view, candidate);
    const clusterPlan = this.clusterEngine?.decide(localView, candidate.origin);
    markBackendPhase("packet-upload-start");
    const staticPacket = localPacket.deformation === undefined
      && localPacket.instances.every(instance => instance.pose === undefined);
    const target = this.runtime as unknown as Partial<AuthorChunkStreamRuntime>;
    const canStream = !instancesOnly && this.options.authorChunks === true && staticPacket
      && target.session && target.stageResidentPacketValidated && target.cancelResidentPacketStage;
    if (canStream) {
      const chunks = this.chunks ?? new AuthorChunkStream(target as AuthorChunkStreamRuntime, this.options.meshlets,
        this.clusterResources);
      let streamed: boolean;
      try {
        streamed = await chunks.sync(localPacket, true, localView, signal, clusterPlan);
      } catch (error) {
        if (chunks !== this.chunks) chunks.dispose();
        throw error;
      }
      if (streamed === false) throw new Error("Independent packet streaming rejected its static scene.");
      this.chunks = chunks;
    } else {
      // 非流送路径:隐藏实例以合法仿射缩放到不可见,代理几何随发布包全量入包,
      // 否则后续相机激活的代理不在驻留闭包内(fail-closed 由打包层拦截)。
      const published = clusterPlan && this.clusterEngine
        ? { ...localPacket, instances: applyHlodPlanToInstances(localPacket.instances, clusterPlan,
            this.clusterEngine.allProxyDraws(candidate.origin)) }
        : localPacket;
      if (instancesOnly) this.runtime.updateInstances({ materials: published.materials, instances: published.instances,
        ...(published.deformation ? { poses: published.deformation.poses } : {}) });
      else await this.runtime.setPacketValidated(published, signal);
      this.publishedInstances = staticPacket ? undefined : published.instances;
      this.chunks?.fullPacketPublished(staticPacket ? "resident-stage-unavailable" : "deformation");
    }
    markBackendPhase("packet-uploaded");
    if (signal?.aborted) throw abortError("Deep backend packet preparation cancelled.");
    this.stageClusterLodOnce(candidate.origin, localPacket);
    this.packetViewStaged = canStream ? view : undefined;
    this.packetViewFailure = undefined;
    this.packetViewRetryAt = 0;
    this.appliedClusterSignature = clusterPlan ? hlodPlanSignature(clusterPlan) : "";
    let frame: FrameMetrics;
    try {
      frame = await this.runtime.validateFrame(localView);
      this.shadowSelectionValue = shadowSelection(frame, this.expectedShadows);
    } catch (error) {
      // A replacement cannot be acknowledged when its first visible GPU frame failed.
      this.chunks?.dispose(); this.chunks = undefined;
      this.packetViewStaged = undefined;
      throw error;
    }
    if (signal?.aborted) throw abortError("Deep backend packet frame cancelled.");
    this.coordinates.commit(candidate);
    this.committedPacket = localPacket;
    this.outlineInstances = undefined;
    // F5-GI-2:独立包路径提交后必须重同步 probe 会话(与 sync() 提交分支同一形态),
    // 否则包内容替换后探针继续用旧表面缓存,直到 GI 关/开重建会话。
    this.probeClipmap?.syncPacket(this.committedPacket);
    this.modelByInstanceId = indexObjectBindings(localPacket);
    markBackendPhase("packet-frame-validated");
    this.validatedView = { view: localView, shadowSelection: this.shadowSelectionValue };
    this.validatedFrame = frame;
    return frame;
  }

  /** Validate the already-published packet against the latest author camera.
   * Studio uses this after candidate creation so a slow full scene projection
   * is not repeated merely because the author viewport advanced one frame. */
  async prepareView(view: RenderView, signal?: AbortSignal, forceValidation = false): Promise<FrameMetrics> {
    this.assertOpen();
    signal?.throwIfAborted();
    const session = this.runtime.session;
    if (session?.state !== undefined && session.state !== "ready") throw new Error("GPU session is not ready for candidate admission.");
    if (session?.device) this.deviceEpoch?.assertCurrent(session.device);
    const localView = this.coordinates.localizeView(view, this.coordinates.current);
    // 候选创建期间视口未变化时，创建路径已验证过完全相同的视图；
    // 重复整帧验证只会重复同一份 GPU 工作，直接复用其结果。
    if (!forceValidation && this.validatedView && sameRenderView(localView, this.validatedView.view) && this.validatedFrame) {
      // 刀 C 首帧:复用生效标记(与 validate-start 互斥出现,供探针断言)。
      if (typeof performance !== "undefined" && typeof performance.mark === "function") {
        performance.mark("deep-webgpu:prepare-view-reused");
      }
      this.shadowSelectionValue = this.validatedView.shadowSelection ?? this.shadowSelectionValue;
      return this.validatedFrame;
    }
    const clusterPlan = this.clusterEngine?.decide(localView, this.coordinates.current.origin);
    if (clusterPlan && !(this.chunks?.hasCatalog)) {
      // 非流送路径:相机/抑制态变化时经 updateInstances 重排实例(簇决策刷新挂点)。
      const signature = hlodPlanSignature(clusterPlan);
      if (signature !== this.appliedClusterSignature && this.committedPacket) {
        this.runtime.updateInstances({ materials: this.committedPacket.materials,
          instances: applyHlodPlanToInstances(this.committedPacket.instances, clusterPlan,
            this.clusterEngine!.allProxyDraws(this.coordinates.current.origin)) });
        this.appliedClusterSignature = signature;
      }
    }
    if (this.independentPacket && this.chunks?.hasCatalog && (!this.packetViewStaged || !sameRenderView(view, this.packetViewStaged))) {
      await this.chunks.syncView(localView, signal, clusterPlan);
      if (signal?.aborted) throw abortError("Deep backend camera preparation cancelled.");
    }
    const frame = await this.runtime.validateFrame(localView);
    if (signal?.aborted) throw abortError("Deep backend preparation cancelled.");
    this.shadowSelectionValue = shadowSelection(frame, this.expectedShadows);
    if (this.independentPacket && this.chunks?.hasCatalog) this.packetViewStaged = view;
    return frame;
  }

  get shadowSelection(): DeepWebGpuShadowSelection | undefined { return this.shadowSelectionValue; }
  get usesIndependentPacket(): boolean { return this.independentPacket; }
  /** Hidden/idle hosts can drop scene residency while retaining device, shaders and environment. */
  evictSceneResources(): boolean {
    this.assertOpen();
    if (!this.independentPacket || this.packetPreparing || this.packetViewInFlight
      || this.clusterLodStaged || !this.runtime.setPacket) return false;
    const empty: RenderPacket = { geometries: [], materials: [], instances: [] };
    this.runtime.setPacket(empty);
    this.chunks?.dispose(); this.chunks = undefined;
    this.committedPacket = undefined; this.publishedInstances = undefined; this.outlineInstances = undefined;
    this.packetViewStaged = undefined; this.packetViewRequested = undefined;
    this.validatedView = undefined; this.validatedFrame = undefined;
    this.modelByInstanceId.clear(); this.probeClipmap?.syncPacket(empty);
    return true;
  }
  /** Resolves a packet instance to its author node without a Three object. */
  modelIdForInstanceId(instanceId: string): string | undefined {
    return this.modelByInstanceId.get(instanceId);
  }
  get chunkStreaming() { return this.chunks?.diagnostics; }
  get packetViewStreamFailure(): unknown { return this.packetViewFailure; }
  private schedulePacketView(view: RenderView): void {
    // Camera closure updates share the residency owner with author replacements.
    // Drawing the retained frame is safe; enqueueing a camera update would abort the replacement.
    if (this.packetPreparing || !this.independentPacket || !this.chunks?.hasCatalog || !this.committedPacket
      || this.packetViewStaged && sameRenderView(view, this.packetViewStaged) && !this.packetViewFailure) return;
    this.packetViewRequested = view;
    if (this.packetViewInFlight) return;
    this.packetViewInFlight = true;
    const chunks = this.chunks;
    const packet = this.committedPacket;
    const advance = async (): Promise<void> => {
      while (!this.disposed && this.chunks === chunks && this.committedPacket === packet) {
        const latest = this.packetViewRequested;
        this.packetViewRequested = undefined;
        if (!latest || this.packetViewStaged && sameRenderView(latest, this.packetViewStaged) && !this.packetViewFailure) break;
        try {
          const localView = this.coordinates.localizeView(latest, this.coordinates.current);
          const clusterPlan = this.clusterEngine?.decide(localView, this.coordinates.current.origin);
          if (this.packetViewFailure) await chunks.sync(packet, true, localView, undefined, clusterPlan);
          else await chunks.syncView(localView, undefined, clusterPlan);
          if (!this.disposed && this.chunks === chunks && this.committedPacket === packet) {
            this.packetViewStaged = latest;
            this.packetViewFailure = undefined;
            this.packetViewRetryAt = 0;
          }
        } catch (error) {
          // A replaced packet owns another stream generation; its stale failure cannot poison it.
          if (!this.packetPreparing && !this.disposed && this.chunks === chunks && this.committedPacket === packet) {
            // Keep the last published GPU frame; an invalid candidate never replaces it.
            this.packetViewFailure = error;
            this.packetViewRetryAt = performance.now() + 1000;
          }
          break;
        }
      }
      this.packetViewInFlight = false;
      if (this.packetViewRequested && !this.disposed && !this.packetViewFailure) this.schedulePacketView(this.packetViewRequested);
    };
    void advance();
  }
  get probeClipmapFailure(): unknown { return this.probeClipmap?.failure; }
  worldToRenderLocal(point: readonly [number, number, number]): readonly [number, number, number] {
    return this.coordinates.worldToLocal(point);
  }
  renderLocalToWorld(point: readonly [number, number, number]): readonly [number, number, number] {
    return this.coordinates.localToWorld(point);
  }
  setProbeClipmapEnabled(enabled: boolean): void {
    this.assertOpen();
    if (!enabled) {
      this.probeClipmap?.dispose();
      this.probeClipmap = undefined;
      return;
    }
    if (this.probeClipmap) return;
    const target = probeClipmapTarget(this.runtime);
    const createController = this.runtime.createProbeClipmapController?.bind(this.runtime);
    const session = new DeepWebGpuProbeClipmapSession(target, createController);
    if (this.committedPacket) session.syncPacket(this.committedPacket);
    session.setEnabled(true);
    this.probeClipmap = session;
  }
  /** Stable host-facing snapshot for Studio diagnostics and support reports. */
  get diagnostics(): { readonly backend: "deep-webgpu"; readonly chunkStreaming?: AuthorChunkStream["diagnostics"]; readonly shadowSelection?: DeepWebGpuShadowSelection; readonly probeClipmap?: DeepWebGpuProbeClipmapDiagnostics; readonly meshlets: boolean; readonly deformation: boolean; readonly coordinateFrame: CameraRelativeCoordinates["current"] } {
    return Object.freeze({ backend: "deep-webgpu" as const,
      ...(this.chunks === undefined ? {} : { chunkStreaming: { ...this.chunks.diagnostics } }),
      ...(this.shadowSelectionValue === undefined ? {} : { shadowSelection: this.shadowSelectionValue }),
      ...(this.probeClipmap === undefined ? {} : { probeClipmap: this.probeClipmap.diagnostics }),
      meshlets: this.options.meshlets === true, deformation: this.options.deformation === true,
      coordinateFrame: this.coordinates.current });
  }

  project(root: ThreeObjectSource, cameraLayerMask = this.options.cameraLayerMask ?? 1): ProjectionResult {
    this.assertOpen();
    if (!this.projection) throw new Error("Deep backend is running from an independent RenderPacket.");
    return this.projection.project(root, { cameraLayerMask });
  }

  async sync(
    root: ThreeObjectSource,
    cameraLayerMask = this.options.cameraLayerMask ?? 1,
    signal?: AbortSignal,
    view?: RenderView,
  ): Promise<DeepWebGpuSyncResult> {
    this.assertOpen();
    if (this.independentPacket) {
      const packet = this.committedPacket;
      if (!packet) return { status: "rejected", issues: [{ code: "invalid", objectId: "", path: "packet", feature: "packet", message: "Independent RenderPacket is not prepared." }] };
      return { status: "committed", update: "instances", packet };
    }
    if (!this.projection) throw new Error("Deep backend requires a projection for scene sync.");
    const generation = ++this.syncGeneration;
    const projected = this.projection.project(root, { cameraLayerMask, ...(view ? { view } : {}) });
    if (!projected.ok) return { status: "rejected", issues: projected.issues };
    const candidateFrame = view ? this.coordinates.candidate(view.eye) : this.coordinates.current;
    const rebased = candidateFrame !== this.coordinates.current;
    const localPacket = this.coordinates.localizePacket(projected.packet, candidateFrame);
    if (rebased) this.pendingCoordinate = candidateFrame;
    try {
      const localView = view ? this.coordinates.localizeView(view, candidateFrame) : undefined;
      const framePacket = localPacket;
      const staticPacket = projected.packet.deformation === undefined && projected.packet.instances.every(instance => instance.pose === undefined);
      if (this.options.authorChunks && view && staticPacket && !this.chunks) {
        const target = this.runtime as unknown as AuthorChunkStreamRuntime;
        if (!target.session || !target.stageResidentPacketValidated || !target.cancelResidentPacketStage) {
          throw new Error("Deep runtime cannot stage author chunks.");
        }
        this.chunks = new AuthorChunkStream(target, this.options.meshlets);
      }
      const streamed = this.chunks && localView ? await this.chunks.sync(framePacket, projected.update === "full" || rebased, localView, signal) : false;
      if (streamed) { /* The existing renderer publishes the single resident candidate at its frame boundary. */ }
      else if (projected.update === "full" || rebased || this.chunks?.hasCatalog) {
        await this.runtime.setPacketValidated(framePacket, signal);
        this.chunks?.fullPacketPublished(staticPacket ? "view-unavailable" : "deformation");
      }
      else this.runtime.updateInstances({ materials: framePacket.materials, instances: framePacket.instances,
        ...(framePacket.deformation ? { poses: framePacket.deformation.poses } : {}) });
    } catch (error) {
      if (this.pendingCoordinate === candidateFrame) this.pendingCoordinate = undefined;
      if (generation !== this.syncGeneration || this.disposed) {
        return { status: "superseded", update: projected.update, packet: projected.packet };
      }
      throw error;
    }
    if (generation !== this.syncGeneration || this.disposed) {
      if (this.pendingCoordinate === candidateFrame) this.pendingCoordinate = undefined;
      return { status: "superseded", update: projected.update, packet: projected.packet };
    }
    if (rebased) this.coordinates.commit(candidateFrame);
    if (this.pendingCoordinate === candidateFrame) this.pendingCoordinate = undefined;
    const status = projected.acknowledge() ? "committed" : "superseded";
    if (status === "committed") {
      if (this.committedPacket?.objectBindings !== localPacket.objectBindings) {
        this.modelByInstanceId = indexObjectBindings(localPacket);
      }
      this.committedPacket = localPacket;
      this.probeClipmap?.syncPacket(this.committedPacket);
    }
    return { status, update: projected.update, packet: projected.packet };
  }

  /** Replace live poses on the published independent deformation packet. */
  updateDeformationPoses(poses: readonly DeformationPose[]): void {
    this.assertOpen();
    const packet = this.committedPacket, instances = this.publishedInstances;
    if (!this.independentPacket || !packet?.deformation || !instances) {
      throw new Error("Deformation pose updates require a published independent deformation packet.");
    }
    this.runtime.updateInstances({ materials: packet.materials, instances, poses });
  }

  /** Update outline instance flags; deformation/HLOD packets require a full authored update. */
  async setOutlinedModels(modelIds: ReadonlySet<string>): Promise<"updated" | "unchanged" | "unsupported"> {
    this.assertOpen();
    const packet = this.committedPacket;
    if (!this.independentPacket || !packet || packet.deformation || this.publishedInstances || this.clusterEngine) return "unsupported";
    const chunks = this.chunks?.hasCatalog ? this.chunks : undefined;
    const current = this.outlineInstances ?? packet.instances;
    let changed = false;
    const next = current.map(instance => {
      const want = modelIds.has(this.modelByInstanceId.get(instance.id) ?? instance.id);
      if (want === (instance.outline === true)) return instance;
      changed = true;
      const { outline: _previous, ...rest } = instance;
      return want ? { ...rest, outline: true } : rest;
    });
    if (!changed) return "unchanged";
    if (!chunks) {
      this.runtime.updateInstances({ materials: packet.materials, instances: next });
      this.outlineInstances = next;
      return "updated";
    }
    const raw = this.latestView ?? undefined;
    const view = raw ? this.coordinates.localizeView(raw, this.coordinates.current) : this.validatedView?.view;
    if (!view) return "unsupported";
    // 同一流上的相机 syncView 可能抢占本次更新(superseded);实例位必须落地,有限重试。
    for (let attempt = 0; ; attempt++) {
      try { await chunks.sync({ ...packet, instances: next }, false, view); break; }
      catch (error) {
        if (this.disposed || this.chunks !== chunks || this.committedPacket !== packet || attempt >= 3) throw error;
      }
    }
    if (this.disposed || this.committedPacket !== packet) return "unchanged";
    this.outlineInstances = next;
    return "updated";
  }
  render(view: RenderView): FrameMetrics | undefined {
    this.assertOpen();
    this.latestView = view;
    const localView = this.coordinates.localizeView(view, this.pendingCoordinate ?? this.coordinates.current);
    const result = this.runtime.render(localView);
    if (result && performance.now() >= this.packetViewRetryAt) this.schedulePacketView(view);
    if (result) {
      if (result.adaptiveQuality) {
        const knobs = result.adaptiveQuality.knobs;
        this.probeClipmap?.setUpdateBudget(knobs.ddgiUpdateBudget);
      }
      this.probeClipmap?.beginFrame(localView);
    }
    return result;
  }

  /**
   * F5-L4 capture pump: one probe-capture batch without a rendered frame. Still scenes
   * stop rendering, which used to starve capture (incomplete initial fill → validity=0
   * texels → sampling falls back to full IBL). Read-only on the render path; the session
   * keeps its serialized-batch + updateBudget contract and latches failures (the host's
   * next rendered frame re-arms the pump once per frame — no idle retry loop).
   */
  probeCaptureTick(): "idle" | "busy" | "submitted" | "unavailable" {
    this.assertOpen();
    return this.probeClipmap?.captureTick() ?? "unavailable";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncGeneration++;
    this.shadowSelectionValue = undefined;
    this.committedPacket = undefined;
    this.outlineInstances = undefined;
    this.latestView = undefined;
    this.packetViewRequested = undefined;
    this.packetViewStaged = undefined;
    this.packetViewFailure = undefined;
    this.modelByInstanceId.clear();
    this.clusterEngine = undefined;
    this.clusterResources = undefined;
    this.appliedClusterSignature = "";
    this.clusterLodStaged = false;
    this.clusterLodStagingError = undefined;
    this.projection?.clear();
    try { this.probeClipmap?.dispose(); }
    finally {
      this.probeClipmap = undefined;
      try { this.chunks?.dispose(); } finally { this.runtime.dispose(); }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Deep WebGPU backend is disposed.");
  }

  /**
   * G1：簇级槽位恰注入一次（首个静态包发布成功后）。注入失败（运行时缺方法、
   * 渲染器槽位未开启、staging 合同校验、相机相对坐标精度超预算）只记
   * clusterLodStagingFailure 诊断，绝不打断渲染链——与 packetViewFailure 同风格。
   * 注入的几何顶点被平移到与已发布包一致的渲染局部坐标（candidate.origin）。
   */
  private stageClusterLodOnce(origin: readonly [number, number, number], packet: RenderPacket): void {
    const staging = this.options.clusterLodStaging;
    if (!staging || this.clusterLodStaged) return;
    this.clusterLodStaged = true;
    try {
      if (packet.deformation !== undefined) {
        throw new Error("Cluster LOD staging rejects deformation packets (G1 static-scene boundary).");
      }
      if (typeof this.runtime.stageClusterLodScene !== "function") {
        throw new Error("Deep runtime does not expose stageClusterLodScene.");
      }
      this.runtime.stageClusterLodScene(localizeClusterLodStaging(staging, origin));
    } catch (error) {
      this.clusterLodStagingError = error;
    }
  }

  /** G1 最近一次簇级槽位注入失败；undefined = 未注入或注入成功。 */
  get clusterLodStagingFailure(): unknown { return this.clusterLodStagingError; }

  /**
   * G1 宿主侧 bake 入口：透传包内 CPU 参考 bake（`src/rayTracing` 合同层一字未改）。
   * 挂在本类（three-bridge 既有公共导出）上，宿主经模块引用消费——bake 函数与
   * DAG 描述符当前无 deep-engine 公共出口，所有权纪律下以该代理弥合而非新增出口。
   */
  static bakeClusterLodAuthorGeometry(input: ClusterLodBakeInput): ClusterLodBakeResult {
    return bakeClusterLodDag(input);
  }
}

function probeClipmapTarget(runtime: DeepWebGpuRenderRuntime): ProbeClipmapPbrTarget {
  const candidate = runtime as unknown as Partial<ProbeClipmapPbrTarget>;
  if (!candidate.session || typeof candidate.setProbeClipmap !== "function") {
    throw new Error("Deep runtime cannot host probe clipmap GI.");
  }
  return candidate as ProbeClipmapPbrTarget;
}

function releaseBackgroundPipelineQueues(runtime: DeepWebGpuRenderRuntime): void {
  (runtime as { releaseBackgroundPipelines?: () => void }).releaseBackgroundPipelines?.();
}

/** 逐字段比较决定首帧内容的视图字段；未列出的字段变化会走完整验证，宁多勿漏。
 * lights/fog/postProcess 由同一构建器生成，键序确定，用 JSON 摘要比对身份无关的值。 */
const sameTuple = (x: ArrayLike<number> | undefined, y: ArrayLike<number> | undefined): boolean => {
  if (x === y) return true;
  if (!x || !y || x.length !== y.length) return false;
  for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return false;
  return true;
};
const sameJson = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
// 刀 C 首帧:overlay 比较按顶点内容而非 revision/字段有无 —— create 路径
// (threeRenderView)不携带 editorOverlay 字段,prepare 路径(renderViewDirect)
// 恒带快照,revision 逐次递增;按有无/revision 判等使 prepareView 的视图
// 复用永不生效,每次切换都白付一次完整首帧验证(实测 ~276ms)。空 overlay 与
// 无 overlay 渲染语义等价(引擎侧按 vertices.length 门控 overlay pass)。
const sameOverlay = (x: RenderView["editorOverlay"], y: RenderView["editorOverlay"]): boolean => {
  if (x === y) return true;
  const left = x?.vertices, right = y?.vertices;
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let offset = 0; offset < left.length; offset++) {
    if (left[offset] !== right[offset]) return false;
  }
  return true;
};
// 刀 C 首帧:authorGrid 按内容而非对象 identity —— grid.read 每次返回新外层
// 对象/新 model 数组(纹理 source 有缓存),identity 判等恒 false,同样使
// prepareView 复用永不生效。纹理 source 相同引用时快速通过;跨引用时按
// id/revision/尺寸/sampler 元数据 + 逐字节比较(仅纹理内容更新后首次付)。
const sameAuthorGrid = (x: RenderView["authorGrid"], y: RenderView["authorGrid"]): boolean => {
  if (x === y) return true;
  if (!x || !y) return false;
  const tx = x.texture, ty = y.texture;
  if (tx !== ty) {
    if (!tx || !ty || tx.id !== ty.id || tx.revision !== ty.revision || tx.semantic !== ty.semantic
      || tx.width !== ty.width || tx.height !== ty.height || tx.data.length !== ty.data.length) return false;
    for (let offset = 0; offset < tx.data.length; offset++) {
      if (tx.data[offset] !== ty.data[offset]) return false;
    }
    const sx = tx.sampler, sy = ty.sampler;
    if ((sx === undefined) !== (sy === undefined)) return false;
    if (sx && sy && (sx.minFilter !== sy.minFilter || sx.magFilter !== sy.magFilter
      || sx.mipmapFilter !== sy.mipmapFilter || sx.maxAnisotropy !== sy.maxAnisotropy)) return false;
  }
  return sameTuple(x.model, y.model) && sameTuple(x.color, y.color) && sameJson(x.fog, y.fog);
};
function sameRenderView(a: RenderView, b: RenderView): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio
    && sameTuple(a.eye, b.eye) && sameTuple(a.target, b.target) && sameTuple(a.up, b.up)
    && a.extent === b.extent && sameTuple(a.background, b.background) && sameTuple(a.floor, b.floor)
    && a.exposure === b.exposure && a.roughness === b.roughness
    && (a.globalIlluminationIntensity ?? 1) === (b.globalIlluminationIntensity ?? 1)
    && a.verticalFovRadians === b.verticalFovRadians && a.near === b.near && a.far === b.far
    && sameJson(a.lights, b.lights) && sameJson(a.fog, b.fog) && sameJson(a.postProcess, b.postProcess)
    // 刀 C 首帧:panoramaBackground 是 renderViewSource 每次新建的对象(环境会话
    // view()),identity 判等恒 false,是 prepareView 复用永不生效的第三处根因
    // (editorOverlay 有无、authorGrid identity 之后);按内容判等。
    && sameJson(a.panoramaBackground, b.panoramaBackground)
    && sameAuthorGrid(a.authorGrid, b.authorGrid)
    && sameOverlay(a.editorOverlay, b.editorOverlay);
}

function markBackendPhase(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(`deep-webgpu:${name}`);
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** G1 staging 形状浅校验；深度合同校验由 ClusterLodRenderSlot.create fail-closed 兜底。 */
function validateCreateRequest(request: DeepWebGpuBackendCreateRequest): DeepWebGpuBackendCreateRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Deep WebGPU backend create request must be an object.");
  }
  if (request.authorChunks !== undefined && typeof request.authorChunks !== "boolean") throw new TypeError("authorChunks must be boolean.");
  if (request.hlodClusters !== undefined && !Array.isArray(request.hlodClusters)) throw new TypeError("hlodClusters must be an array.");
  if (request.hlodCollapseSuppressed !== undefined && typeof request.hlodCollapseSuppressed !== "function") {
    throw new TypeError("hlodCollapseSuppressed must be a function.");
  }
  if (request.clusterLodStaging !== undefined) validateClusterLodStagingShape(request.clusterLodStaging);
  return request;
}
