import { snapshotEnvironment, snapshotRendererOptions } from "./deepWebGpuOptions.js";
import { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
import { AuthorChunkStream, type AuthorChunkStreamRuntime } from "./authorChunkStream.js";
import type { ProjectionIssue, ProjectionResult, ThreeObjectSource } from "./types.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { PbrRenderer, type FrameMetrics, type PbrRendererOptions, type RenderView } from "../webgpu/pbrRenderer.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import { snapshotShadows, shadowSelection, type DeepWebGpuShadowSelection } from "./deepWebGpuShadowPolicy.js";
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
    return DeepWebGpuBackend.prepare(runtime, validated.projection, validated.root, validated.view, {
      ...(validated.cameraLayerMask === undefined ? {} : { cameraLayerMask: validated.cameraLayerMask }), signal,
      ...(renderer.shadows === undefined ? {} : { expectedShadows: renderer.shadows }),
      ...(authorChunks === undefined ? {} : { authorChunks }),
      ...(renderer.meshlets === undefined ? {} : { meshlets: renderer.meshlets }),
    });
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

  get shadowSelection(): DeepWebGpuShadowSelection | undefined { return this.shadowSelectionValue; }
  get chunkStreaming() { return this.chunks?.diagnostics; }
  /** Stable host-facing snapshot for Studio diagnostics and support reports. */
  get diagnostics(): { readonly backend: "deep-webgpu"; readonly chunkStreaming?: AuthorChunkStream["diagnostics"]; readonly shadowSelection?: DeepWebGpuShadowSelection; readonly meshlets: boolean; readonly deformation: boolean } {
    return Object.freeze({ backend: "deep-webgpu" as const,
      ...(this.chunks === undefined ? {} : { chunkStreaming: { ...this.chunks.diagnostics } }),
      ...(this.shadowSelectionValue === undefined ? {} : { shadowSelection: this.shadowSelectionValue }),
      meshlets: this.options.meshlets === true, deformation: this.options.deformation === true });
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
    try {
      const staticPacket = projected.packet.deformation === undefined && projected.packet.instances.every(instance => instance.pose === undefined);
      if (this.options.authorChunks && view && staticPacket && !this.chunks) {
        const target = this.runtime as unknown as AuthorChunkStreamRuntime;
        if (!target.session || !target.stageResidentPacketValidated || !target.cancelResidentPacketStage) {
          throw new Error("Deep runtime cannot stage author chunks.");
        }
        this.chunks = new AuthorChunkStream(target, this.options.meshlets);
      }
      const streamed = this.chunks && view ? await this.chunks.sync(projected.packet, projected.update === "full", view, signal) : false;
      if (streamed) { /* The existing renderer publishes the single resident candidate at its frame boundary. */ }
      else if (projected.update === "full" || this.chunks?.hasCatalog) {
        await this.runtime.setPacketValidated(projected.packet, signal);
        this.chunks?.fullPacketPublished(staticPacket ? "view-unavailable" : "deformation");
      }
      else this.runtime.updateInstances({ materials: projected.packet.materials, instances: projected.packet.instances,
        ...(projected.packet.deformation ? { poses: projected.packet.deformation.poses } : {}) });
    } catch (error) {
      if (generation !== this.syncGeneration || this.disposed) {
        return { status: "superseded", update: projected.update, packet: projected.packet };
      }
      throw error;
    }
    if (generation !== this.syncGeneration || this.disposed) {
      return { status: "superseded", update: projected.update, packet: projected.packet };
    }
    const status = projected.acknowledge() ? "committed" : "superseded";
    return { status, update: projected.update, packet: projected.packet };
  }

  render(view: RenderView): FrameMetrics | undefined {
    this.assertOpen();
    return this.runtime.render(view);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncGeneration++;
    this.shadowSelectionValue = undefined;
    this.projection.clear();
    try { this.chunks?.dispose(); } finally { this.runtime.dispose(); }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Deep WebGPU backend is disposed.");
  }
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
