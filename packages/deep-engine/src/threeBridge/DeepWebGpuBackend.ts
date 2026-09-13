import { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
import type { ProjectionIssue, ProjectionResult, ThreeObjectSource } from "./types.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { PbrRenderer, type FrameMetrics, type PbrRendererOptions, type RenderView } from "../webgpu/pbrRenderer.js";
import { resolvePbrRendererFeatures } from "../webgpu/pbrRendererFeatures.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import { CASCADED_SHADOW_QUALITY_PROFILES,
  type CascadedShadowQualityTier } from "../shadows/shadowQuality.js";

type DeepWebGpuCanvas = Parameters<typeof PbrRenderer.create>[0];

/** 可被宿主切换的自研浏览器后端；不持有作者场景，也不依赖 Three 运行时。 */
export interface DeepWebGpuRenderRuntime {
  readonly id: string;
  setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void>;
  updateInstances(update: InstanceUpdate): void;
  render(view: RenderView): FrameMetrics | undefined;
  validateFrame(view: RenderView): Promise<FrameMetrics>;
  dispose(): void;
}

export interface DeepWebGpuBackendOptions {
  /** Three 相机图层掩码；未传时使用默认图层 1。 */
  readonly cameraLayerMask?: number;
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

export interface DeepWebGpuShadowSelection {
  readonly selectedTier: CascadedShadowQualityTier;
  readonly estimatedDepthTextureBytes: number;
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

  constructor(
    readonly runtime: DeepWebGpuRenderRuntime,
    readonly projection: ThreeProjectionBridge,
    private readonly options: DeepWebGpuBackendOptions = {},
  ) {
    if (runtime.id !== this.id) throw new Error(`Deep runtime id must be ${this.id}.`);
  }

  /** Creates and validates an owned PBR runtime from an immutable settings snapshot. */
  static async create(request: DeepWebGpuBackendCreateRequest,
    factory: DeepWebGpuRuntimeFactory = PbrRenderer): Promise<DeepWebGpuBackend> {
    const validated = validateCreateRequest(request);
    const signal = validated.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortError("Deep backend creation cancelled.");
    const renderer = snapshotRendererOptions(validated.renderer ?? {});
    const runtime = await factory.create(validated.canvas, validated.gpu, signal, renderer);
    if (signal.aborted) {
      runtime.dispose();
      throw abortError("Deep backend creation cancelled.");
    }
    return DeepWebGpuBackend.prepare(runtime, validated.projection, validated.root, validated.view, {
      ...(validated.cameraLayerMask === undefined ? {} : { cameraLayerMask: validated.cameraLayerMask }), signal,
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
    const synced = await this.sync(root, cameraLayerMask, signal);
    if (synced.status === "rejected") throw new DeepWebGpuProjectionError(synced.issues);
    if (synced.status !== "committed" || signal?.aborted) {
      throw abortError("Deep backend preparation cancelled or superseded.");
    }
    const frame = await this.runtime.validateFrame(view);
    this.shadowSelectionValue = shadowSelection(frame);
    if (signal?.aborted) throw abortError("Deep backend preparation cancelled.");
    return frame;
  }

  get shadowSelection(): DeepWebGpuShadowSelection | undefined { return this.shadowSelectionValue; }

  project(root: ThreeObjectSource, cameraLayerMask = this.options.cameraLayerMask ?? 1): ProjectionResult {
    this.assertOpen();
    return this.projection.project(root, { cameraLayerMask });
  }

  async sync(
    root: ThreeObjectSource,
    cameraLayerMask = this.options.cameraLayerMask ?? 1,
    signal?: AbortSignal,
  ): Promise<DeepWebGpuSyncResult> {
    this.assertOpen();
    const generation = ++this.syncGeneration;
    const projected = this.projection.project(root, { cameraLayerMask });
    if (!projected.ok) return { status: "rejected", issues: projected.issues };
    try {
      if (projected.update === "full") await this.runtime.setPacketValidated(projected.packet, signal);
      else this.runtime.updateInstances({ materials: projected.packet.materials, instances: projected.packet.instances });
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
    this.runtime.dispose();
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
  return request;
}

function snapshotRendererOptions(options: PbrRendererOptions): PbrRendererOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Deep WebGPU renderer options must be an object.");
  }
  if (Object.keys(options).some(key => !["shadows", "features", "environment"].includes(key))) {
    throw new TypeError("Unknown Deep WebGPU renderer option.");
  }
  return Object.freeze({
    ...(options.shadows === undefined ? {} : { shadows: snapshotShadows(options.shadows) }),
    ...(options.features === undefined ? {} : { features: resolvePbrRendererFeatures(options.features) }),
    ...(options.environment === undefined ? {} : { environment: snapshotEnvironment(options.environment) }),
  });
}

function snapshotShadows(shadows: NonNullable<PbrRendererOptions["shadows"]>) {
  if (!shadows || typeof shadows !== "object" || Array.isArray(shadows)) {
    throw new TypeError("Deep WebGPU shadow options must be an object.");
  }
  if (Object.keys(shadows).some(key => key !== "requestedTier" && key !== "maxDepthTextureBytes")) {
    throw new TypeError("Unknown Deep WebGPU shadow option.");
  }
  if (shadows.requestedTier !== undefined
    && !Object.hasOwn(CASCADED_SHADOW_QUALITY_PROFILES, shadows.requestedTier)) {
    throw new RangeError(`Unknown cascaded shadow quality tier: ${String(shadows.requestedTier)}.`);
  }
  if (shadows.maxDepthTextureBytes !== undefined
    && (!Number.isSafeInteger(shadows.maxDepthTextureBytes) || shadows.maxDepthTextureBytes < 1)) {
    throw new RangeError("Invalid maximum shadow depth bytes.");
  }
  return Object.freeze({ ...shadows });
}

function snapshotEnvironment(source: PbrEnvironmentSource): PbrEnvironmentSource {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Deep WebGPU environment source must be an object.");
  }
  if (source.kind === "studio") return Object.freeze({ kind: "studio" });
  if (source.kind !== "radiance-hdr") throw new RangeError("Unknown Deep WebGPU environment source.");
  const image = source.image;
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || !(image.data instanceof Float32Array)
    || image.data.length !== image.width * image.height * 3) {
    throw new TypeError("Deep WebGPU HDR environment image must be an owned RGB32F image.");
  }
  const options = source.options;
  if (options !== undefined) {
    const allowed = ["specularSize", "diffuseSize", "sampleCount", "maxUploadBytes", "maxRadiance"];
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => !allowed.includes(key))) {
      throw new TypeError("Unknown Deep WebGPU HDR environment option.");
    }
  }
  return Object.freeze({ kind: "radiance-hdr", image, ...(options === undefined ? {} : { options: Object.freeze({ ...options }) }) });
}

function shadowSelection(frame: FrameMetrics): DeepWebGpuShadowSelection {
  if (!Object.hasOwn(CASCADED_SHADOW_QUALITY_PROFILES, frame.shadowTier)) {
    throw new Error(`Deep runtime reported an unknown shadow tier: ${String(frame.shadowTier)}.`);
  }
  const selectedTier = frame.shadowTier as CascadedShadowQualityTier;
  const expectedBytes = CASCADED_SHADOW_QUALITY_PROFILES[selectedTier].estimatedDepthTextureBytes;
  if (frame.shadowDepthBytes !== expectedBytes) {
    throw new Error(`Deep runtime reported ${frame.shadowDepthBytes} shadow bytes for ${selectedTier}; expected ${expectedBytes}.`);
  }
  return Object.freeze({ selectedTier, estimatedDepthTextureBytes: expectedBytes });
}
