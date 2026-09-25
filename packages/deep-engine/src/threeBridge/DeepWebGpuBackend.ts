import { snapshotEnvironment, snapshotRendererOptions } from "./deepWebGpuOptions.js";
import { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
import { AuthorChunkStream, type AuthorChunkStreamRuntime } from "./authorChunkStream.js";
import type { ProjectionIssue, ProjectionResult, ThreeObjectSource } from "./types.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { PbrRenderer, type FrameMetrics, type PbrRendererOptions, type RenderView } from "../webgpu/pbrRenderer.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import { snapshotShadows, shadowSelection, type DeepWebGpuShadowSelection } from "./deepWebGpuShadowPolicy.js";
import { ProbeClipmapPbrController, type ProbeClipmapPbrTarget } from "../webgpu/probeClipmapPbrController.js";
import { DeepWebGpuProbeClipmapSession, type DeepWebGpuProbeClipmapDiagnostics } from "./DeepWebGpuProbeClipmapSession.js";
import { CameraRelativeCoordinates, type CameraRelativeCoordinateSnapshot } from "./cameraRelativeCoordinates.js";
export type { DeepWebGpuShadowSelection } from "./deepWebGpuShadowPolicy.js";

type DeepWebGpuCanvas = Parameters<typeof PbrRenderer.create>[0];

/** 可被宿主切换的自研浏览器后端；不持有作者场景，也不依赖 Three 运行时。 */
export interface DeepWebGpuRenderRuntime {
  readonly id: string;
  setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void>;
  updateInstances(update: InstanceUpdate): void;
  render(view: RenderView): FrameMetrics | undefined;
  validateFrame(view: RenderView): Promise<FrameMetrics>;
  stageEnvironment?(source: PbrEnvironmentSource, signal?: AbortSignal): Promise<"staged" | "superseded">;
  stageShadowMapSize?(mapSize: number, signal?: AbortSignal): Promise<"staged" | "superseded">;
  /**
   * Optional production GI source. Implementations must return a controller
   * configured with real scene-radiance capture; omission keeps Studio IBL and
   * fails closed instead of publishing the probe runtime's test fallback.
   */
  createProbeClipmapController?(target: ProbeClipmapPbrTarget, deviceEpoch: string): ProbeClipmapPbrController;
  dispose(): void;
}

export interface DeepWebGpuBackendOptions {
  readonly authorChunks?: boolean;
  readonly meshlets?: boolean;
  readonly deformation?: boolean;
  /** Three 相机图层掩码；未传时使用默认图层 1。 */
  readonly cameraLayerMask?: number;
  /** Allocation evidence expected when preparing an existing runtime. */
  readonly expectedShadows?: NonNullable<PbrRendererOptions["shadows"]>;
}

export interface DeepWebGpuRuntimeFactory {
  create(canvas: DeepWebGpuCanvas, gpu: GPU | undefined, signal: AbortSignal,
    options?: PbrRendererOptions): Promise<DeepWebGpuRenderRuntime>;
}

export interface DeepWebGpuBackendCreateRequest extends DeepWebGpuBackendOptions {
  readonly canvas: DeepWebGpuCanvas;
  readonly gpu: GPU | undefined;
  readonly projection: ThreeProjectionBridge;
  readonly root: ThreeObjectSource;
  readonly view: RenderView;
  /** Optional immutable packet compiled from SceneSnapshot. When present the
   * backend bypasses ThreeProjectionBridge for initial publication. */
  readonly renderPacket?: RenderPacket;
  readonly renderer?: PbrRendererOptions;
  readonly signal?: AbortSignal;
}

export class DeepWebGpuProjectionError extends Error {
  constructor(readonly issues: readonly ProjectionIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join("\n") || "Three scene projection failed.");
    this.name = "DeepWebGpuProjectionError";
  }
}

export type DeepWebGpuSyncResult =
  | { readonly status: "committed"; readonly update: "full" | "instances"; readonly packet: RenderPacket }
  | { readonly status: "superseded"; readonly update: "full" | "instances"; readonly packet: RenderPacket }
  | { readonly status: "rejected"; readonly issues: readonly ProjectionIssue[] };

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
  private probeClipmap: DeepWebGpuProbeClipmapSession | undefined;
  private committedPacket: RenderPacket | undefined;
  private readonly coordinates = new CameraRelativeCoordinates();
  private pendingCoordinate: CameraRelativeCoordinateSnapshot | undefined;

  constructor(
    readonly runtime: DeepWebGpuRenderRuntime,
    readonly projection: ThreeProjectionBridge,
    private readonly options: DeepWebGpuBackendOptions = {},
  ) {
    if (runtime.id !== this.id) throw new Error(`Deep runtime id must be ${this.id}.`);
    if (options.authorChunks !== undefined && typeof options.authorChunks !== "boolean") throw new TypeError("authorChunks must be boolean.");
    if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("meshlets must be boolean.");
    this.expectedShadows = options.expectedShadows === undefined ? undefined : snapshotShadows(options.expectedShadows);
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
    const validated = validateCreateRequest(request);
    const signal = validated.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortError("Deep backend creation cancelled.");
    const renderer = snapshotRendererOptions(validated.renderer ?? {});
    const authorChunks = validated.authorChunks;
    const runtime = await factory.create(validated.canvas, validated.gpu, signal, renderer);
    if (signal.aborted) {
      runtime.dispose();
      throw abortError("Deep backend creation cancelled.");
    }
    const backend = new DeepWebGpuBackend(runtime, validated.projection, {
      ...(validated.cameraLayerMask === undefined ? {} : { cameraLayerMask: validated.cameraLayerMask }),
      ...(renderer.shadows === undefined ? {} : { expectedShadows: renderer.shadows }),
      ...(authorChunks === undefined ? {} : { authorChunks }),
      ...(renderer.meshlets === undefined ? {} : { meshlets: renderer.meshlets }),
    });
    try {
      if (validated.renderPacket) {
        await backend.prepareRenderPacket(validated.renderPacket, validated.view, signal);
        return backend;
      }
      await backend.prepareScene(validated.root, validated.view, validated.cameraLayerMask, signal);
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
    this.assertOpen();
    signal?.throwIfAborted();
    const candidate = this.coordinates.candidate(view.eye);
    const localPacket = this.coordinates.localizePacket(packet, candidate);
    await this.runtime.setPacketValidated(localPacket, signal);
    if (signal?.aborted) throw abortError("Deep backend packet preparation cancelled.");
    this.coordinates.commit(candidate);
    this.committedPacket = localPacket;
    const frame = await this.runtime.validateFrame(this.coordinates.localizeView(view, candidate));
    this.shadowSelectionValue = shadowSelection(frame, this.expectedShadows);
    return frame;
  }

  /** Validate the already-published packet against the latest author camera.
   * Studio uses this after candidate creation so a slow full scene projection
   * is not repeated merely because the author viewport advanced one frame. */
  async prepareView(view: RenderView, signal?: AbortSignal): Promise<FrameMetrics> {
    this.assertOpen();
    signal?.throwIfAborted();
    const localView = this.coordinates.localizeView(view, this.coordinates.current);
    const frame = await this.runtime.validateFrame(localView);
    if (signal?.aborted) throw abortError("Deep backend preparation cancelled.");
    this.shadowSelectionValue = shadowSelection(frame, this.expectedShadows);
    return frame;
  }

  get shadowSelection(): DeepWebGpuShadowSelection | undefined { return this.shadowSelectionValue; }
  get chunkStreaming() { return this.chunks?.diagnostics; }
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
    return this.projection.project(root, { cameraLayerMask });
  }

  async sync(
    root: ThreeObjectSource,
    cameraLayerMask = this.options.cameraLayerMask ?? 1,
    signal?: AbortSignal,
    view?: RenderView,
  ): Promise<DeepWebGpuSyncResult> {
    this.assertOpen();
    const generation = ++this.syncGeneration;
    const projected = this.projection.project(root, { cameraLayerMask });
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
      this.committedPacket = localPacket;
      this.probeClipmap?.syncPacket(this.committedPacket);
    }
    return { status, update: projected.update, packet: projected.packet };
  }

  render(view: RenderView): FrameMetrics | undefined {
    this.assertOpen();
    const localView = this.coordinates.localizeView(view, this.pendingCoordinate ?? this.coordinates.current);
    const result = this.runtime.render(localView);
    if (result) {
      if (result.adaptiveQuality) {
        const knobs = result.adaptiveQuality.knobs;
        this.probeClipmap?.setUpdateBudget(knobs.ddgiUpdateBudget);
      }
      this.probeClipmap?.beginFrame(localView);
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncGeneration++;
    this.shadowSelectionValue = undefined;
    this.committedPacket = undefined;
    this.projection.clear();
    try { this.probeClipmap?.dispose(); }
    finally {
      this.probeClipmap = undefined;
      try { this.chunks?.dispose(); } finally { this.runtime.dispose(); }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Deep WebGPU backend is disposed.");
  }
}

function probeClipmapTarget(runtime: DeepWebGpuRenderRuntime): ProbeClipmapPbrTarget {
  const candidate = runtime as Partial<ProbeClipmapPbrTarget>;
  if (!candidate.session || typeof candidate.setProbeClipmap !== "function") {
    throw new Error("Deep runtime cannot host probe clipmap GI.");
  }
  return candidate as ProbeClipmapPbrTarget;
}

export type DeepWebGpuBackendRuntime = PbrRenderer;
function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function validateCreateRequest(request: DeepWebGpuBackendCreateRequest): DeepWebGpuBackendCreateRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Deep WebGPU backend create request must be an object.");
  }
  if (request.authorChunks !== undefined && typeof request.authorChunks !== "boolean") throw new TypeError("authorChunks must be boolean.");
  return request;
}
