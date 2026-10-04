/// <reference types="@webgpu/types" />
import { createAdmittedTexture, createAdmittedBuffer } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { temporalAaJitter, validateTemporalAaJitter, validateTemporalAaOptions } from "./temporalAaCpu.js";
import { TEMPORAL_REACTIVE_MASK_FORMAT } from "./temporalAaTypes.js";
import { type TemporalUpscaleOptions, type TemporalUpscaleResult, type TemporalUpscaleSource,
  TEMPORAL_UPSCALE_COLOR_FORMAT, TEMPORAL_UPSCALE_DEPTH_FORMAT, TEMPORAL_UPSCALE_MOTION_FORMAT } from "./temporalUpscaleTypes.js";
import { TEMPORAL_UPSCALE_WGSL, TEMPORAL_UPSCALE_WORKGROUP_SIZE } from "./temporalUpscaleWgsl.js";
import { enableTemporalGhostGuardWgsl } from "./temporalReprojection.js";

/** encode source = TAA 同族合同 + 显示/内部尺寸映射与相机切换标记。 */
export interface TemporalUpscalePassSource extends TemporalUpscaleSource {
  /** 显示画布宽 ÷ 内部渲染宽(>1);上采样输出尺寸 = round(internal × displayScale)。 */
  readonly displayScale: number;
  readonly cameraCut?: boolean;
}

/** TemporalUpscalePass 构造选项(编译期特性载体,features 表外;与 TemporalAaPassOptions 同族)。 */
export interface TemporalUpscalePassOptions {
  /** AA-M2 GHOST_GUARD 决策层(残影修复):开启时经 enableTemporalGhostGuardWgsl 把
   * 编译期常量翻到 1 再建 shader module(与 temporalAa 同一决策式,box 邻域取内部
   * texel 网格,reactive 门在 decay 之前)。默认 false:模块代码 = TEMPORAL_UPSCALE_WGSL
   * 原文,输出与历史生产逐位一致。 */
  readonly ghostGuard?: boolean;
}

const PARAMETER_BYTES = 64;
interface UpscaleAllocation {
  displayWidth: number; displayHeight: number; internalWidth: number; internalHeight: number;
  colors: readonly [GPUTexture, GPUTexture]; depths: readonly [GPUTexture, GPUTexture];
  parameters: readonly [GPUBuffer, GPUBuffer];
}

/**
 * F4 时域上采样 pass:内部渲染分辨率主帧 → 全分辨率(显示画布)输出,全分辨率
 * color/depth 双缓冲 ping-pong 历史。历史失效(first-frame/resize/camera-cut/
 * revision-gap)输出退化为纯 Catmull-Rom 空间核(fail-closed,不残留陈旧历史)。
 * reactive 供给(可选,内部分辨率 r8unorm):透明/粒子覆盖区历史按 (1-reactive)
 * 降权(与 TAA binding 8 同式);缺省绑 1×1 零 fallback 且 flags.y=0,零行为变化。
 * 参数打包与 temporalUpscaleWgsl.UpscaleParams 逐字段对齐;抖动差按 displayScale
 * 从内部像素映射为显示像素(与 temporalUpscaleCpu 同式)。
 */
export class TemporalUpscalePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly zeroMask: GPUTexture;
  private readonly zeroMaskView: GPUTextureView;
  private allocation: UpscaleAllocation | undefined;
  private historyIndex = 0;
  private lastRevision: number | undefined;
  private lastJitter: readonly [number, number] = [0, 0];
  private disposed = false;
  constructor(private readonly session: DeviceSession, options: TemporalUpscalePassOptions = {}) {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for temporal upscale.");
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep temporal upscale WGSL",
      code: options.ghostGuard ? enableTemporalGhostGuardWgsl(TEMPORAL_UPSCALE_WGSL) : TEMPORAL_UPSCALE_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep temporal upscale layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: TEMPORAL_UPSCALE_COLOR_FORMAT } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: TEMPORAL_UPSCALE_DEPTH_FORMAT } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep temporal upscale pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "upscaleTemporal" } });
    // 无 reactive 供给时的 binding 满足:WebGPU 纹理零初始化保证内容恒 0,配合
    // flags.y=0 门,WGSL 读到的 reactive 恒 0 —— fail-closed 双保险(与 TAA 同模式)。
    this.zeroMask = createAdmittedTexture(session, { label: "Deep temporal upscale reactive mask fallback",
      size: [1, 1], format: TEMPORAL_REACTIVE_MASK_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.zeroMaskView = this.zeroMask.createView();
  }

  encode(encoder: GPUCommandEncoder, source: TemporalUpscalePassSource, options: TemporalUpscaleOptions): TemporalUpscaleResult {
    this.assertUsable();
    validateSource(this.session.device, source);
    validateTemporalAaOptions(options);
    const displayWidth = Math.max(1, Math.round(source.color.width * source.displayScale));
    const displayHeight = Math.max(1, Math.round(source.color.height * source.displayScale));
    const previous = this.allocation;
    const resized = !previous || previous.displayWidth !== displayWidth || previous.displayHeight !== displayHeight
      || previous.internalWidth !== source.color.width || previous.internalHeight !== source.color.height;
    let candidate: UpscaleAllocation | undefined;
    try {
      candidate = resized
        ? this.allocate(displayWidth, displayHeight, source.color.width, source.color.height)
        : previous;
      const invalidation = !previous ? "first-frame" : resized ? "resize" : source.cameraCut ? "camera-cut"
        : this.lastRevision === undefined || source.revision !== this.lastRevision + 1 ? "revision-gap" : null;
      const historyUsed = invalidation === null;
      const writeIndex: 0 | 1 = historyUsed ? (1 - this.historyIndex) as 0 | 1 : 0;
      const readIndex: 0 | 1 = historyUsed ? this.historyIndex as 0 | 1 : 1;
      const reactiveEnabled = source.reactiveMask !== undefined;
      const currentJitter = source.currentJitter ? jitterSnapshot(source.currentJitter) : temporalAaJitter(source.revision);
      const previousJitter = source.previousJitter ? jitterSnapshot(source.previousJitter)
        : historyUsed ? this.lastJitter : currentJitter;
      const bindGroup = this.session.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: source.color.createView() },
        { binding: 1, resource: source.depth.createView() },
        { binding: 2, resource: source.motion.createView() },
        { binding: 3, resource: candidate!.colors[readIndex].createView() },
        { binding: 4, resource: candidate!.depths[readIndex].createView() },
        { binding: 5, resource: { buffer: candidate!.parameters[writeIndex] } },
        { binding: 6, resource: candidate!.colors[writeIndex].createView() },
        { binding: 7, resource: candidate!.depths[writeIndex].createView() },
        { binding: 8, resource: source.reactiveMask ? source.reactiveMask.createView() : this.zeroMaskView },
      ] });
      this.session.device.queue.writeBuffer(candidate!.parameters[writeIndex], 0,
        packTemporalUpscaleParameters(candidate!, historyUsed, currentJitter, previousJitter, options, reactiveEnabled));
      const pass = encoder.beginComputePass({ label: "Deep temporal upscale" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(candidate!.displayWidth / TEMPORAL_UPSCALE_WORKGROUP_SIZE),
        Math.ceil(candidate!.displayHeight / TEMPORAL_UPSCALE_WORKGROUP_SIZE));
      pass.end();
      if (resized) { this.allocation = candidate; if (previous) this.release(previous); }
      this.historyIndex = writeIndex; this.lastRevision = source.revision; this.lastJitter = currentJitter;
      return Object.freeze({ texture: candidate!.colors[writeIndex], format: TEMPORAL_UPSCALE_COLOR_FORMAT,
        width: candidate!.displayWidth, height: candidate!.displayHeight, revision: source.revision,
        historyUsed, historyInvalidation: invalidation });
    } catch (error) {
      if (candidate && candidate !== previous) this.release(candidate);
      throw error;
    }
  }

  reset(): void { this.lastRevision = undefined; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.allocation) this.release(this.allocation);
    this.allocation = undefined; this.lastRevision = undefined;
    this.session.release(this.zeroMask);
  }

  private allocate(displayWidth: number, displayHeight: number, internalWidth: number,
    internalHeight: number): UpscaleAllocation {
    const owned: Array<GPUTexture | GPUBuffer> = [];
    const texture = (format: GPUTextureFormat, label: string) => {
      const value = createAdmittedTexture(this.session, { label, size: [displayWidth, displayHeight], format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
      owned.push(value); return value;
    };
    const buffer = (label: string) => {
      const value = createAdmittedBuffer(this.session, { label, size: PARAMETER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      owned.push(value); return value;
    };
    try {
      return { displayWidth, displayHeight, internalWidth, internalHeight,
        colors: [texture(TEMPORAL_UPSCALE_COLOR_FORMAT, "Deep upscale history color A"),
          texture(TEMPORAL_UPSCALE_COLOR_FORMAT, "Deep upscale history color B")],
        depths: [texture(TEMPORAL_UPSCALE_DEPTH_FORMAT, "Deep upscale history depth A"),
          texture(TEMPORAL_UPSCALE_DEPTH_FORMAT, "Deep upscale history depth B")],
        parameters: [buffer("Deep upscale parameters A"), buffer("Deep upscale parameters B")] };
    } catch (error) {
      for (const resource of owned) this.session.release(resource);
      throw error;
    }
  }

  private release(value: UpscaleAllocation): void {
    for (const resource of [...value.colors, ...value.depths, ...value.parameters]) this.session.release(resource);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Temporal upscale pass is disposed.");
    if (this.session.state !== "ready") {
      if (this.allocation) this.release(this.allocation);
      this.allocation = undefined;
      throw new Error("GPU session is not ready for temporal upscale.");
    }
  }
}

function validateSource(device: GPUDevice, source: TemporalUpscalePassSource): void {
  if (source.colorEncoding !== "linear-hdr" || source.depthEncoding !== "linear-view-depth-positive"
    || source.motionEncoding !== "current-to-previous-uv") {
    throw new Error("Upscale requires explicit linear HDR, positive linear view depth, and current-to-previous UV motion.");
  }
  if (!Number.isSafeInteger(source.revision) || source.revision < 0
    || (source.cameraCut !== undefined && typeof source.cameraCut !== "boolean")) {
    throw new Error("Invalid upscale revision or cameraCut.");
  }
  if (!Number.isFinite(source.displayScale) || source.displayScale <= 1) {
    throw new Error("Upscale displayScale must be finite and greater than 1 (the input is the internal render).");
  }
  const hasCurrentJitter = source.currentJitter !== undefined, hasPreviousJitter = source.previousJitter !== undefined;
  if (hasCurrentJitter !== hasPreviousJitter) throw new Error("Upscale currentJitter and previousJitter must be supplied together.");
  if (hasCurrentJitter) {
    validateTemporalAaJitter(source.currentJitter!, "Upscale currentJitter");
    validateTemporalAaJitter(source.previousJitter!, "Upscale previousJitter");
  }
  const specs = [[source.color, TEMPORAL_UPSCALE_COLOR_FORMAT, "color"],
    [source.depth, TEMPORAL_UPSCALE_DEPTH_FORMAT, "depth"], [source.motion, TEMPORAL_UPSCALE_MOTION_FORMAT, "motion"]] as const;
  for (const [texture, format, name] of specs) {
    if (texture.format !== format || texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1
      || texture.sampleCount !== 1 || (texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) {
      throw new Error(`Invalid upscale ${name} texture; expected ${format} single-sample 2D TEXTURE_BINDING.`);
    }
    if (texture.width !== source.color.width || texture.height !== source.color.height) {
      throw new Error("Upscale input dimensions must match.");
    }
  }
  const reactiveMask = source.reactiveMask;
  if (reactiveMask !== undefined) {
    if (reactiveMask.format !== TEMPORAL_REACTIVE_MASK_FORMAT || reactiveMask.dimension !== "2d"
      || reactiveMask.depthOrArrayLayers !== 1 || reactiveMask.sampleCount !== 1
      || (reactiveMask.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) {
      throw new Error(`Invalid upscale reactive mask; expected ${TEMPORAL_REACTIVE_MASK_FORMAT} single-sample 2D TEXTURE_BINDING.`);
    }
    if (reactiveMask.width !== source.color.width || reactiveMask.height !== source.color.height) {
      throw new Error("Upscale reactive mask dimensions must match the internal render.");
    }
  }
  const displayWidth = Math.max(1, Math.round(source.color.width * source.displayScale));
  const displayHeight = Math.max(1, Math.round(source.color.height * source.displayScale));
  if (displayWidth > device.limits.maxTextureDimension2D || displayHeight > device.limits.maxTextureDimension2D
    || Math.ceil(displayWidth / TEMPORAL_UPSCALE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(displayHeight / TEMPORAL_UPSCALE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Upscale display dimensions exceed device limits.");
  }
}

/** 布局 = temporalUpscaleWgsl.UpscaleParams(64B):尺寸 u32×4 | flags u32×4(valid,reactive 门,0,0) | tuning f32×4 | jitterΔ f32×4。导出仅供单测布局对拍。 */
export function packTemporalUpscaleParameters(allocation: { displayWidth: number; displayHeight: number;
    internalWidth: number; internalHeight: number }, valid: boolean,
  current: readonly [number, number], previous: readonly [number, number],
  options: TemporalUpscaleOptions, reactiveMask: boolean): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES);
  const uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  const displayScale = allocation.displayWidth / allocation.internalWidth;
  uints.set([allocation.displayWidth, allocation.displayHeight, allocation.internalWidth, allocation.internalHeight], 0);
  uints.set([valid ? 1 : 0, reactiveMask ? 1 : 0, 0, 0], 4);
  floats.set([options.feedback, options.depthThreshold, options.relativeDepthThreshold, displayScale], 8);
  floats.set([(previous[0] - current[0]) * displayScale, (previous[1] - current[1]) * displayScale, 0, 0], 12);
  return buffer;
}

function jitterSnapshot(value: readonly [number, number]): readonly [number, number] {
  return Object.freeze([value[0], value[1]]);
}
