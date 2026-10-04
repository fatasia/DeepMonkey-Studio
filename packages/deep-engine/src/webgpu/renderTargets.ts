import type { DeviceSession } from "./deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool,
  PbrTransientTexturePoolStats } from "./pbrTransientTexturePool.js";
import type { SurfaceSize } from "./surfaceSize.js";

/**
 * AA-M1 主 pass 请求采样数(默认 4):bootstrap 经 probePbrMainSampleCount 按设备能力
 * 解析(fail-closed 回 1),运行期常量只表达"请求值"。设备/驱动不支持 MSAA4 时渲染器
 * 以 1x 构建(RenderTargets/pipelines 全部回退),原因经 FrameMetrics.msaa 披露。
 */
export const PBR_MAIN_SAMPLE_COUNT = 4;

/** MSAA 档位解析:undefined = 默认 4;仅 1/4 合法(WebGPU 核心多采样档),其余 fail-closed 拒绝。 */
export function resolvePbrMsaaSampleCount(requested: number | undefined): 1 | 4 {
  if (requested === undefined) return PBR_MAIN_SAMPLE_COUNT;
  if (requested === 1 || requested === 4) return requested;
  throw new RangeError(`PBR main MSAA sample count must be 1 or 4; got ${String(requested)}.`);
}

/**
 * A2C-P1 A/B 实验钩子(2026-10-05):主 pass target0 格式的编译期外唯一注入口。
 * 仅取证脚本(scripts/a2c-format-ab.mjs)经 addInitScript 在**任何模块求值之前**写
 * `globalThis.__deepEngineExperimentHdrFormat`,使本模块及全部 load-time 消费方
 * (PBR_OPAQUE_ATTACHMENT_FORMATS、pbrFramePlanResources 静态目录)与逐帧 claim 的
 * 运行时读取读到同一格式 —— plan/actual 对拍因此天然一致,零运行时突变。
 * 生产代码从不写该全局,缺省路径逐位不变(常量仍为 rgba16float)。
 *
 * 兼容性自查(任务硬要求):白名单只有 rgba8unorm ——
 * - rgba8unorm:RENDER_ATTACHMENT/blend/MSAA resolve/STORAGE_BINDING(pbrFullHdrTransientUsage)
 *   全部核心支持,读回编码器(frameCaptureReadback 4B/px)支持;
 * - bgra8unorm:**无 storage 档**(需 bgra8unorm-storage 特性),与既有
 *   STORAGE_BINDING usage 冲突,拒入白名单(fail-closed,不静默)。
 * 已知实验档限制:8-bit UNORM 在进入后处理链(tone mapping/bloom/AO/SSR)之前截断
 * HDR 动态范围到 [0,1] —— 属实验取证语义,见 A2C-P1-HANDOFF.md 画质影响评估。
 */
const EXPERIMENT_HDR_FORMAT_KEY = "__deepEngineExperimentHdrFormat";
function resolveExperimentHdrFormat(): "rgba16float" | "rgba8unorm" {
  const requested = (globalThis as Record<string, unknown>)[EXPERIMENT_HDR_FORMAT_KEY];
  if (requested === undefined) return "rgba16float";
  if (requested === "rgba8unorm") return "rgba8unorm";
  throw new Error(`Unsupported experiment HDR format override: ${String(requested)}. Only "rgba8unorm" is allowlisted `
    + "(bgra8unorm lacks a storage tier and conflicts with pbrFullHdrTransientUsage).");
}
export const PBR_HDR_FORMAT = resolveExperimentHdrFormat();
export const PBR_LINEAR_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
// rgba8snorm is not renderable on all WebGPU adapters (notably Vulkan/ANGLE).
// Store view normals in a renderable UNORM target and decode them in GTAO.
export const PBR_VIEW_NORMAL_FORMAT = "rgba8unorm" as const satisfies GPUTextureFormat;
export const PBR_MOTION_FORMAT = "rg16float" as const satisfies GPUTextureFormat;
export const PBR_DEPTH_FORMAT = "depth32float" as const satisfies GPUTextureFormat;
export const PBR_OPAQUE_ATTACHMENT_FORMATS = Object.freeze([
  PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_VIEW_NORMAL_FORMAT, PBR_MOTION_FORMAT,
] as const);

/** Superset used by full-resolution HDR nodes that may occupy one render-graph alias slot. */
export function pbrFullHdrTransientUsage(): GPUTextureUsageFlags {
  return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
}

/** Single-sample, shader-readable main-frame attachments for AO and temporal reconstruction. */
export class RenderTargets {
  private handles: PbrTransientTextureHandle[] = [];
  private dimensions: SurfaceSize | undefined;
  private disposed = false;
  private readonly sampler: GPUSampler;
  /**
   * 单采样、可着色读的主帧附件(AA-M1 起 = MSAA 的 resolve 产物):后处理链、输出
   * bind group、读回与全部次级 pass(粒子/样条/网格/OIT/描边/背景)消费方均绑定此层,
   * MSAA 开关对它们零可见变化。附属目标(linear-depth/view-normal/motion)默认保持 1x
   * —— 渲染 pass 采样数一致性要求其 MSAA 附件存在,但内容只经 resolve 产出。
   */
  hdrTexture!: GPUTexture; linearDepthTexture!: GPUTexture; normalTexture!: GPUTexture; motionTexture!: GPUTexture; depthTexture!: GPUTexture;
  hdr!: GPUTextureView; linearDepth!: GPUTextureView; normal!: GPUTextureView; motion!: GPUTextureView;
  /** Compatibility alias during the renderer migration; direct rendering uses hdr without resolveTarget. */
  color!: GPUTextureView;
  depth!: GPUTextureView;
  outputBindGroup!: GPUBindGroup;
  /** AA-M1:主 pass 的 MSAA 附件(仅 RENDER_ATTACHMENT 语义;1x 渲染器恒 undefined)。 */
  hdrMsaaTexture: GPUTexture | undefined;
  hdrMsaa: GPUTextureView | undefined;
  linearDepthMsaaTexture: GPUTexture | undefined; linearDepthMsaa: GPUTextureView | undefined;
  normalMsaaTexture: GPUTexture | undefined; normalMsaa: GPUTextureView | undefined;
  motionMsaaTexture: GPUTexture | undefined; motionMsaa: GPUTextureView | undefined;
  /** MSAA 硬件深度附件;TEXTURE_BINDING 供深度 resolve pass 采样(sample-0)。 */
  depthMsaaTexture: GPUTexture | undefined;
  depthMsaa: GPUTextureView | undefined;

  constructor(private readonly session: DeviceSession, private readonly layout: GPUBindGroupLayout,
    private readonly settings: GPUBuffer, private readonly pool: PbrTransientTexturePool,
    readonly mainSampleCount: 1 | 4 = PBR_MAIN_SAMPLE_COUNT) {
    this.sampler = session.device.createSampler({ minFilter: "linear", magFilter: "linear" });
    void session.device.lost.then(() => this.invalidateDeviceLoss(), () => this.invalidateDeviceLoss());
  }

  get transientStats(): PbrTransientTexturePoolStats { return this.pool.stats; }
  /** MSAA 主通路激活(4x 渲染器)。directDisplay 帧不使用,见 beginFrame 的 msaaMainAttachments。 */
  get msaaActive(): boolean { return this.mainSampleCount > 1; }

  /** Opens the real frame allocation scope. Resources return to the pool only after commitFrame(queue.submit). */
  beginFrame(size: SurfaceSize,
    resourceLifetimes?: readonly import("../renderGraph.js").RenderResourceLifetime[],
    requireGeometryBuffers = false, msaaMainAttachments = true): void {
    if (this.disposed) throw new Error("PBR render targets are disposed.");
    if (this.handles.length || this.pool.frameOpen) throw new Error("PBR render target frame is already open.");
    const resized = this.dimensions !== undefined
      && (size.width !== this.dimensions.width || size.height !== this.dimensions.height);
    if (resized) this.pool.invalidateAll("surface-resize");
    this.pool.beginFrame(resourceLifetimes ?? []);
    const device = this.session.device;
    const attachmentUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    // MSAA 附件内容只在 pass 内消费(color 走 resolveTarget,深度由 resolve pass 采样),
    // 因此 RENDER_ATTACHMENT 之外零 usage —— 池侧命中 TRANSIENT_ATTACHMENT 驱动内存别名。
    const msaaAttachmentUsage = GPUTextureUsage.RENDER_ATTACHMENT;
    try {
      const planned = resourceLifetimes === undefined ? undefined : new Set(resourceLifetimes.map(resource => resource.id));
      // The opaque MRT pipeline has a fixed four-target signature. A graph may
      // prune later consumers, but WebGPU still requires every declared color
      // attachment when that pipeline is encoded.
      const needs = (resourceId: string): boolean => requireGeometryBuffers
        || planned === undefined || planned.has(resourceId);
      const acquire = (resourceId: string, format: GPUTextureFormat, usage = attachmentUsage) => this.pool.acquire({
        resourceId, format, width: size.width, height: size.height, sampleCount: 1, usage,
      });
      const acquireMsaa = (resourceId: string, format: GPUTextureFormat, usage: GPUTextureUsageFlags): PbrTransientTextureHandle | undefined =>
        this.msaaActive && msaaMainAttachments
          ? this.pool.acquire({ resourceId, format, width: size.width, height: size.height,
            sampleCount: this.mainSampleCount, usage })
          : undefined;
      // HDR remains available for the stable output bind group. Optional MRTs follow the compiled live-resource set.
      const hdrHandle = acquire("opaque-hdr", PBR_HDR_FORMAT, pbrFullHdrTransientUsage());
      // linear-depth 额外 COPY_SRC：R12 白名单诊断快照（planned 合同已声明，见 pbrFramePlanResources）。
      // STORAGE_BINDING:AA-M1 MSAA 主通路下 1x linear-depth 由 compute resolve 写出
      // (r32float 无硬件 resolve);1x 渲染器该位闲置无害。
      const linearDepthHandle = needs("linear-depth")
        ? acquire("linear-depth", PBR_LINEAR_DEPTH_FORMAT, attachmentUsage | GPUTextureUsage.COPY_SRC
          | GPUTextureUsage.STORAGE_BINDING)
        : undefined;
      const normalHandle = needs("view-normal") ? acquire("view-normal", PBR_VIEW_NORMAL_FORMAT) : undefined;
      const motionHandle = needs("motion") ? acquire("motion", PBR_MOTION_FORMAT) : undefined;
      const depthHandle = acquire("hardware-depth", PBR_DEPTH_FORMAT);
      const hdrMsaaHandle = acquireMsaa("opaque-hdr-msaa", PBR_HDR_FORMAT, msaaAttachmentUsage);
      // linear-depth(r32float)不支持硬件 resolve(WebGPU 32 位格式无 resolve 能力),
      // MSAA 附件内容经 compute 采样还原,需要 TEXTURE_BINDING;也因此不能带
      // TRANSIENT 标记(usage != RENDER_ATTACHMENT 恰好命中池侧判定)。
      const linearDepthMsaaHandle = linearDepthHandle ? acquireMsaa("linear-depth-msaa", PBR_LINEAR_DEPTH_FORMAT,
        msaaAttachmentUsage | GPUTextureUsage.TEXTURE_BINDING) : undefined;
      const normalMsaaHandle = normalHandle ? acquireMsaa("view-normal-msaa", PBR_VIEW_NORMAL_FORMAT, msaaAttachmentUsage) : undefined;
      const motionMsaaHandle = motionHandle ? acquireMsaa("motion-msaa", PBR_MOTION_FORMAT, msaaAttachmentUsage) : undefined;
      const depthMsaaHandle = acquireMsaa("hardware-depth-msaa", PBR_DEPTH_FORMAT, msaaAttachmentUsage | GPUTextureUsage.TEXTURE_BINDING);
      const handles = [hdrHandle, linearDepthHandle, normalHandle, motionHandle, depthHandle,
        hdrMsaaHandle, linearDepthMsaaHandle, normalMsaaHandle, motionMsaaHandle, depthMsaaHandle]
        .filter((handle): handle is PbrTransientTextureHandle => handle !== undefined);
      const outputBindGroup = device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: hdrHandle.view }, { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.settings } },
      ] });
      this.handles = handles;
      this.hdrTexture = hdrHandle.texture; this.linearDepthTexture = linearDepthHandle?.texture as GPUTexture;
      this.normalTexture = normalHandle?.texture as GPUTexture; this.motionTexture = motionHandle?.texture as GPUTexture;
      this.depthTexture = depthHandle.texture;
      this.hdr = hdrHandle.view; this.color = this.hdr; this.linearDepth = linearDepthHandle?.view as GPUTextureView;
      this.normal = normalHandle?.view as GPUTextureView; this.motion = motionHandle?.view as GPUTextureView;
      this.depth = depthHandle.view;
      this.hdrMsaaTexture = hdrMsaaHandle?.texture; this.hdrMsaa = hdrMsaaHandle?.view;
      this.linearDepthMsaaTexture = linearDepthMsaaHandle?.texture; this.linearDepthMsaa = linearDepthMsaaHandle?.view;
      this.normalMsaaTexture = normalMsaaHandle?.texture; this.normalMsaa = normalMsaaHandle?.view;
      this.motionMsaaTexture = motionMsaaHandle?.texture; this.motionMsaa = motionMsaaHandle?.view;
      this.depthMsaaTexture = depthMsaaHandle?.texture; this.depthMsaa = depthMsaaHandle?.view;
      this.outputBindGroup = outputBindGroup; this.dimensions = Object.freeze({ width: size.width, height: size.height });
    } catch (error) {
      this.pool.endFrame(false); throw error;
    }
  }

  commitFrame(): void {
    if (!this.handles.length) throw new Error("PBR render target commit requires an open frame.");
    for (const handle of this.handles) this.pool.release(handle);
    this.handles = []; this.pool.endFrame(true);
  }

  failFrame(): void {
    if (!this.pool.frameOpen) return;
    this.handles = []; this.pool.endFrame(false);
  }

  invalidateDeviceEpoch(): void {
    this.handles = []; this.dimensions = undefined; this.pool.invalidateAll("epoch-advance");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.failFrame(); this.pool.dispose(); this.handles = []; this.dimensions = undefined;
  }

  private invalidateDeviceLoss(): void {
    if (this.disposed) return;
    this.handles = []; this.dimensions = undefined; this.pool.invalidateAll("device-lost");
  }
}
