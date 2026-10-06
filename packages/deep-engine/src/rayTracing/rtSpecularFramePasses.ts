/// <reference types="@webgpu/types" />
/**
 * RT specular GI 帧执行器(两个小 pass,消费点在同步帧链内——链内 fill 后紧跟 TAA,
 * 禁异步括夹):**同步 encode**(postprocess 家族合同,同 SSR/SSGI;WGSL 正确性由
 * sha256 钉死测试 + 真机门承担,编译错误走 device uncapturederror),帧循环只写自有
 * uniform、无 readback、无 mapAsync、bind group 按纹理视图对象身份 LRU 缓存(与
 * RayTraceClosestFramePass.frameBindingsFor 同法;label 不是身份,禁止做缓存键)。
 *
 * - RtSpecularIndirectionPass:消费反射 closest-hit 命中记录 + 遮蔽记录
 *   ([albedo.rgb, visibility])+ GBuffer(linearDepth/viewNormal)+ 环境 brdfLut,
 *   写 rgba16float indirection(见 rtSpecularIndirectionKernel)。
 * - RtSpecularFillPass:SSR 合成之后读 [ssrOutput, ssrTrace, rtIndirection],屏内
 *   miss 像素做 RT 替换,写 rgba16float 填充输出供 TAA(见 rtSpecularFillKernel)。
 *
 * 直收 GPUDevice(非 DeviceSession):与 RayTraceClosestFramePass 同合同,探针
 * (scripts/rtSpecularGiGpuTest.mjs)可在裸 device 上复用同一执行路径,生产/验收
 * 单源。生命周期由持有方(pbrPostProcessChain/pbrRendererFrames)destroy。
 */

import { emitRtSpecularIndirectionKernelWgsl, packRtSpecularIndirectionUniform,
  RT_SPECULAR_INDIRECTION_BINDINGS, RT_SPECULAR_INDIRECTION_ENTRY_POINT,
  RT_SPECULAR_INDIRECTION_PARAMS_BYTES, type RtSpecularIndirectionParams } from "./rtSpecularIndirectionKernel.js";
import { emitRtSpecularFillKernelWgsl, packRtSpecularFillUniform,
  RT_SPECULAR_FILL_BINDINGS, RT_SPECULAR_FILL_ENTRY_POINT,
  RT_SPECULAR_FILL_PARAMS_BYTES } from "./rtSpecularFillKernel.js";

const MAX_CACHED_BINDINGS = 4;
// 数值 usage 位(同 RayTraceClosestFramePass:不触运行时 GPUBufferUsage 全局,
// mock/Node 测试环境与真机同路径)。
const USAGE_UNIFORM = 0x40, USAGE_COPY_DST = 0x8;

export interface RtSpecularIndirectionFrameInput {
  /** SSR 同源 GBuffer:线性视深度(r32float)与视法线(rgba8unorm,xyz 法线 w roughness)。 */
  readonly linearDepthView: GPUTextureView;
  readonly viewNormalView: GPUTextureView;
  /** split-sum DFG(environment.brdf;与 SSR 同一 LUT)。 */
  readonly brdfLutView: GPUTextureView;
  /** 反射 closest-hit 帧通道命中记录(rgba32float storage view,本帧已写入)。 */
  readonly rtHitView: GPUTextureView;
  /** 反射 closest-hit 帧通道遮蔽记录 [albedo.rgb, visibility](rgba32float,本帧已写入)。 */
  readonly bounceShadingView: GPUTextureView;
  /** indirection 输出(rgba16float storage view)。 */
  readonly indirectionView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  /** 打包参数(光照/环境/f0 由调用方按帧合同解析)。 */
  readonly params: RtSpecularIndirectionParams;
}

export interface RtSpecularFillFrameInput {
  readonly ssrOutputView: GPUTextureView;
  readonly ssrTraceView: GPUTextureView;
  readonly indirectionView: GPUTextureView;
  readonly outputView: GPUTextureView;
  readonly width: number;
  readonly height: number;
}

export class RtSpecularIndirectionPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly uniform: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly layout: GPUBindGroupLayout;
  private cached: Array<{
    readonly views: readonly GPUTextureView[];
    readonly binding: GPUBindGroup;
  }> = [];

  constructor(private readonly device: GPUDevice) {
    // 显式绑定布局:auto 布局把 texture_2d<f32> 推成可过滤采样,而 linearDepth 是
    // r32float(只 textureLoad,不可过滤)——显式 unfilterable-float 才能绑定(同 SSR
    // traceLayout 惯例);storage 读/写纹理与 uniform 同布局逐槽显式。
    this.layout = device.createBindGroupLayout({ label: "rt-specular-indirection-layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "read-only", format: "rgba32float" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "read-only", format: "rgba32float" } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "rt-specular-indirection",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "rt-specular-indirection",
        code: emitRtSpecularIndirectionKernelWgsl() }),
        entryPoint: RT_SPECULAR_INDIRECTION_ENTRY_POINT } });
    this.uniform = device.createBuffer({ label: "rt-specular-indirection-params",
      size: RT_SPECULAR_INDIRECTION_PARAMS_BYTES,
      usage: USAGE_UNIFORM | USAGE_COPY_DST });
    this.sampler = device.createSampler({ label: "rt-specular-indirection",
      magFilter: "linear", minFilter: "linear" });
  }

  /**
   * 帧内联 dispatch:写 96B uniform → 单 compute pass 写 indirection 纹理。必须在
   * 反射 closest-hit dispatch 之后(同一 encoder 即有序);提交由调用方 encoder 统一 finish。
   */
  encode(encoder: GPUCommandEncoder, input: RtSpecularIndirectionFrameInput): { dispatchX: number; dispatchY: number } {
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
      throw new Error("RtSpecularIndirectionPass requires positive integer indirection dimensions.");
    }
    if (input.params.width !== input.width || input.params.height !== input.height) {
      throw new Error("RtSpecularIndirectionPass params must match the indirection dimensions.");
    }
    const scalars = [input.params.tanHalfFov, input.params.aspect, ...input.params.surfaceToLightWorld,
      ...input.params.lightColor, input.params.lightIntensity, ...input.params.envRadiance, input.params.fresnelF0];
    if (!scalars.every(Number.isFinite)) {
      throw new Error("RtSpecularIndirectionPass requires finite light/env/f0 params.");
    }
    this.device.queue.writeBuffer(this.uniform, 0, packRtSpecularIndirectionUniform(input.params));
    const views = [input.linearDepthView, input.viewNormalView, input.brdfLutView,
      input.rtHitView, input.indirectionView, input.bounceShadingView];
    let binding = this.cached.find((entry) => entry.views.length === views.length
      && entry.views.every((view, index) => view === views[index]))?.binding;
    if (!binding) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: input.linearDepthView },
        { binding: 1, resource: input.viewNormalView },
        { binding: 2, resource: input.brdfLutView },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.uniform } },
        { binding: 5, resource: input.rtHitView },
        { binding: 6, resource: input.indirectionView },
        { binding: 7, resource: input.bounceShadingView },
      ];
      if (entries.length !== RT_SPECULAR_INDIRECTION_BINDINGS.length) {
        throw new Error(`RtSpecularIndirectionPass bind group expects ${RT_SPECULAR_INDIRECTION_BINDINGS.length} entries.`);
      }
      binding = this.device.createBindGroup({ label: "rt-specular-indirection",
        layout: this.layout, entries });
      this.cached.push({ views, binding });
      if (this.cached.length > MAX_CACHED_BINDINGS) this.cached.shift();
    }
    const pass = encoder.beginComputePass({ label: "rt-specular-indirection" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, binding);
    const dispatchX = Math.ceil(input.width / 8);
    const dispatchY = Math.ceil(input.height / 8);
    pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
    pass.end();
    return { dispatchX, dispatchY };
  }

  destroy(): void {
    this.uniform.destroy();
    this.cached = [];
  }
}

export class RtSpecularFillPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly uniform: GPUBuffer;
  private readonly sampler: GPUSampler;
  private cached: Array<{
    readonly views: readonly GPUTextureView[];
    readonly binding: GPUBindGroup;
  }> = [];

  constructor(private readonly device: GPUDevice) {
    this.pipeline = device.createComputePipeline({ label: "rt-specular-fill", layout: "auto",
      compute: { module: device.createShaderModule({ label: "rt-specular-fill",
        code: emitRtSpecularFillKernelWgsl() }),
        entryPoint: RT_SPECULAR_FILL_ENTRY_POINT } });
    this.uniform = device.createBuffer({ label: "rt-specular-fill-params", size: RT_SPECULAR_FILL_PARAMS_BYTES,
      usage: USAGE_UNIFORM | USAGE_COPY_DST });
    this.sampler = device.createSampler({ label: "rt-specular-fill", magFilter: "linear", minFilter: "linear" });
  }

  /** SSR 合成之后同 encoder 编码;输出 rgba16float(TAA 输入)。 */
  encode(encoder: GPUCommandEncoder, input: RtSpecularFillFrameInput): { dispatchX: number; dispatchY: number } {
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
      throw new Error("RtSpecularFillPass requires positive integer fill dimensions.");
    }
    this.device.queue.writeBuffer(this.uniform, 0, packRtSpecularFillUniform({ width: input.width, height: input.height }));
    const views = [input.ssrOutputView, input.ssrTraceView, input.indirectionView, input.outputView];
    let binding = this.cached.find((entry) => entry.views.length === views.length
      && entry.views.every((view, index) => view === views[index]))?.binding;
    if (!binding) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: input.ssrOutputView },
        { binding: 1, resource: input.ssrTraceView },
        { binding: 2, resource: input.indirectionView },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.uniform } },
        { binding: 5, resource: input.outputView },
      ];
      if (entries.length !== RT_SPECULAR_FILL_BINDINGS.length) {
        throw new Error(`RtSpecularFillPass bind group expects ${RT_SPECULAR_FILL_BINDINGS.length} entries.`);
      }
      binding = this.device.createBindGroup({ label: "rt-specular-fill",
        layout: this.pipeline.getBindGroupLayout(0), entries });
      this.cached.push({ views, binding });
      if (this.cached.length > MAX_CACHED_BINDINGS) this.cached.shift();
    }
    const pass = encoder.beginComputePass({ label: "rt-specular-fill" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, binding);
    const dispatchX = Math.ceil(input.width / 8);
    const dispatchY = Math.ceil(input.height / 8);
    pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
    pass.end();
    return { dispatchX, dispatchY };
  }

  destroy(): void {
    this.uniform.destroy();
    this.cached = [];
  }
}
