/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
import { DEEP_IES_SAMPLING_WGSL } from "./iesSamplingWgsl.js";
import { packIesShading, type PackedIesShading } from "./iesShading.js";
import { packMegaLights, MEGA_LIGHT_ABI_VERSION, MAX_MEGA_LIGHTS,
  MEGALIGHTS_RIS_CANDIDATES, type PackedMegaLights } from "./megaLights.js";
import { MEGA_LIGHTS_ABI_VERSION, MEGA_LIGHTS_BIND_GROUP, MEGA_LIGHTS_COLOR_BINDING,
  MEGA_LIGHTS_COLOR_HISTORY_BINDING, MEGA_LIGHTS_IES_BINDING, MEGA_LIGHTS_MOTION_BINDING,
  MEGA_LIGHTS_PARAMS_BYTES, MEGA_LIGHTS_PARAMS_BINDING, MEGA_LIGHTS_POOL_BINDING,
  MEGA_LIGHTS_RESERVOIRS_A_BINDING, MEGA_LIGHTS_RESERVOIRS_B_BINDING, MEGA_LIGHTS_SURFACES_BINDING,
  MEGA_LIGHTS_SURFACES_STRIDE_VEC4 } from "./megaLightsAbi.js";
import { MEGA_LIGHTS_RIS_WGSL } from "./megaLightsRisWgsl.js";

/**
 * B2 MegaLights M1 compute 运行时:两趟 RIS 直接光(buildReservoirs → reuseAndShade)。
 * 领地纪律:不触碰 webgpu/pbrOpaquePass|renderTargets|pipelines|pbrRendererFrames|
 * virtualShadow*|pbrDepthResolve|pbrMsaaCapability(MSAA/VSM 并行)——本通路自持
 * storage 资源(1x,无 MSAA 附件),主 pass 接入(wiring)属 M2,由 pbrRendererFrames
 * 单点最小 diff 完成。
 *
 * 组合顺序(WGSL 声明先于使用):storage 声明 + E02 IES 单源 → RIS 库(引用上述
 * 符号)→ uniform var + 两个 @compute 入口。DeepMegaParams 结构由库定义。
 */

/** 趟一入口(buildReservoirs:K 候选 + 时域合并 → A)。 */
export const MEGA_LIGHTS_ENTRY_BUILD = "deepMegaBuildReservoirsFrame";
/** 趟二入口(reuseAndShade:5×5 空间合并 + 胜者着色 → B + color)。 */
export const MEGA_LIGHTS_ENTRY_SHADE = "deepMegaReuseAndShadeFrame";
export const MEGA_LIGHTS_WORKGROUP_SIZE = 8;

/** 宿主模板:绑定声明(槽位与 megaLightsAbi.ts 互钉)+ IES 单源 + RIS 库 + 入口。 */
export function composeMegaLightsShader(): string {
  return /* wgsl */ `
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_PARAMS_BINDING}) var<uniform> deepMegaFrame: DeepMegaParams;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_POOL_BINDING}) var<storage, read> deepMegaLights: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_SURFACES_BINDING}) var<storage, read> deepMegaSurfaces: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_MOTION_BINDING}) var<storage, read> deepMegaMotion: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_RESERVOIRS_A_BINDING}) var<storage, read_write> deepMegaReservoirsA: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_RESERVOIRS_B_BINDING}) var<storage, read_write> deepMegaReservoirsB: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_COLOR_BINDING}) var<storage, read_write> deepMegaColor: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_COLOR_HISTORY_BINDING}) var<storage, read_write> deepMegaColorHistory: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_IES_BINDING}) var<storage, read> deepIesShading: array<vec4<f32>>;
${DEEP_IES_SAMPLING_WGSL}${MEGA_LIGHTS_RIS_WGSL}
@compute @workgroup_size(${MEGA_LIGHTS_WORKGROUP_SIZE}, ${MEGA_LIGHTS_WORKGROUP_SIZE})
fn ${MEGA_LIGHTS_ENTRY_BUILD}(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) { return; }
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u];
  let surfaceB = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 2u];
  deepMegaReservoirsA[pixelIndex] = deepMegaBuildReservoir(deepMegaFrame, pixelIndex,
    surfaceA, surfaceB, surfaceC, deepMegaReservoirsB[pixelIndex], deepMegaMotion[pixelIndex].xy);
}

@compute @workgroup_size(${MEGA_LIGHTS_WORKGROUP_SIZE}, ${MEGA_LIGHTS_WORKGROUP_SIZE})
fn ${MEGA_LIGHTS_ENTRY_SHADE}(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) { return; }
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u];
  let surfaceB = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 2u];
  var center = deepMegaReservoirUnpack(deepMegaReservoirsA[pixelIndex]);
  let color = deepMegaReuseAndShade(deepMegaFrame, pixelIndex, surfaceA, surfaceB, surfaceC, &center);
  // 颜色时域 EMA(temporalEnabled 时按 alphaBlend 混合;首帧宿主传 1 全量替换):
  // M1 噪声下限控制——单帧 K=32 RIS 的方差由帧间指数窗口收敛,与生产 TAA/TSR 组合同职责。
  var blended = color;
  if (deepMegaFrame.temporalEnabled != 0u) {
    blended = mix(deepMegaColorHistory[pixelIndex].rgb, color, vec3f(deepMegaFrame.alphaBlend));
  }
  deepMegaColor[pixelIndex] = vec4f(blended, 0.0);
  deepMegaColorHistory[pixelIndex] = vec4f(blended, 0.0);
  deepMegaReservoirsB[pixelIndex] = deepMegaReservoirPack(center, surfaceA.w);
}
`;
}

export interface MegaLightsFrameFlags {
  readonly temporalEnabled: boolean;
  readonly spatialEnabled: boolean;
  /** 穷举对拍模式(K≥N 遍历全灯,输出恒等于精确和;⑤ 退化一致性腿专用)。 */
  readonly exhaustive?: boolean;
}

export interface MegaLightsPrepareInput extends MegaLightsFrameFlags {
  readonly width: number;
  readonly height: number;
  readonly lights: PackedMegaLights;
  /** 表面 storage 字节(像素 × 3 vec4,布局见 megaLightsAbi.ts)。 */
  readonly surfaces: Float32Array;
  /** 逐像素运动(motionUv.xy,像素 × 1 vec4);缺省全零 + 关时域。 */
  readonly motion?: Float32Array | undefined;
  /** E02 IES 载荷(packIesShading 输出);缺省最小 -1 行(因子恒 1)。 */
  readonly ies?: PackedIesShading | undefined;
  /** 帧种子(缺省递增;静态场景传固定值 → 逐位稳定,③ 闪烁门腿用)。 */
  readonly frameSeed?: number | undefined;
  /** 颜色 EMA 系数(temporalEnabled 时生效;首帧传 1 全量替换;缺省 1/32)。 */
  readonly alphaBlend?: number | undefined;
}

export interface MegaLightsFrameResources {
  readonly lightCount: number;
  readonly width: number;
  readonly height: number;
}

interface MegaLightsAllocation {
  readonly width: number;
  readonly height: number;
  readonly lightVec4s: number;
  readonly iesVec4s: number;
  readonly params: GPUBuffer;
  readonly lights: GPUBuffer;
  readonly surfaces: GPUBuffer;
  readonly motion: GPUBuffer;
  readonly reservoirsA: GPUBuffer;
  readonly reservoirsB: GPUBuffer;
  readonly color: GPUBuffer;
  readonly colorHistory: GPUBuffer;
  readonly ies: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
}

const PIXEL_VEC4S = 16 / 4;
const SURFACE_VEC4S = MEGA_LIGHTS_SURFACES_STRIDE_VEC4;

/**
 * MegaLights compute 运行时(资源按 2 的幂扩容;rollback-safe,沿 clusterCompute 纪律)。
 * encode 一帧 = 趟一 pass(读 prev/写 A)+ 趟二 pass(读 A/写 B+color),pass 边界内存序
 * 为 WebGPU 规范强保证;固定角色双蓄水池(A=本帧构建,B=本帧收束+下帧历史),无 ping-pong。
 */
export class MegaLightsRuntime {
  readonly layout: GPUBindGroupLayout;
  private readonly buildPipeline: GPUComputePipeline;
  private readonly shadePipeline: GPUComputePipeline;
  private resources: MegaLightsAllocation | undefined;
  private frameIndex = 0;
  private disposed = false;
  /** 表面上传跳过:同一 Float32Array 引用 + 同一分配 → 内容不变的 GBuffer 不重传
   * (1080p 表面 = 100MB/帧,逐帧重传是帧时主项;灯池每帧照传——动态灯是常态)。 */
  private uploadedSurfaces?: { readonly allocation: MegaLightsAllocation; readonly surfaces: Float32Array };

  /** 诊断面:shader 模块句柄(真机探针用 getCompilationInfo 抓 Tint 编译消息)。 */
  readonly shaderModule: GPUShaderModule;

  constructor(private readonly session: Pick<DeviceSession, "device" | "state" | "own" | "release">) {
    this.assertReady();
    const device = session.device;
    if (device.limits.maxStorageBuffersPerShaderStage < 8) {
      throw new Error("MegaLights requires eight storage buffers per shader stage.");
    }
    const module = device.createShaderModule({ label: "Deep MegaLights RIS compute",
      code: composeMegaLightsShader() });
    this.shaderModule = module;
    const entries: GPUBindGroupLayoutEntry[] = [{ binding: MEGA_LIGHTS_PARAMS_BINDING,
      visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }];
    for (const binding of [MEGA_LIGHTS_POOL_BINDING, MEGA_LIGHTS_SURFACES_BINDING, MEGA_LIGHTS_MOTION_BINDING,
      MEGA_LIGHTS_IES_BINDING]) {
      entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } });
    }
    for (const binding of [MEGA_LIGHTS_RESERVOIRS_A_BINDING, MEGA_LIGHTS_RESERVOIRS_B_BINDING,
      MEGA_LIGHTS_COLOR_BINDING, MEGA_LIGHTS_COLOR_HISTORY_BINDING]) {
      entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
    }
    this.layout = device.createBindGroupLayout({ label: "Deep MegaLights layout", entries });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep MegaLights pipeline layout",
      bindGroupLayouts: [this.layout] });
    this.buildPipeline = device.createComputePipeline({ label: "Deep MegaLights build reservoirs",
      layout: pipelineLayout, compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_BUILD } });
    this.shadePipeline = device.createComputePipeline({ label: "Deep MegaLights reuse and shade",
      layout: pipelineLayout, compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_SHADE } });
  }

  /** 上传输入并按需扩容;不编码(与 clusterCompute prepare/encode 两段同纪律)。 */
  prepare(input: MegaLightsPrepareInput): MegaLightsFrameResources {
    this.assertReady();
    const { width, height } = input;
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new Error("MegaLights viewport must be positive integers.");
    }
    const pixelCount = width * height;
    if (input.surfaces.length !== pixelCount * SURFACE_VEC4S * 4) {
      throw new Error(`MegaLights surfaces must hold ${pixelCount * SURFACE_VEC4S * 4} floats (3 vec4 per pixel).`);
    }
    if (input.motion !== undefined && input.motion.length !== pixelCount * PIXEL_VEC4S * 4) {
      throw new Error(`MegaLights motion must hold ${pixelCount * PIXEL_VEC4S * 4} floats (1 vec4 per pixel).`);
    }
    const lightCount = input.lights.count;
    if (lightCount > MAX_MEGA_LIGHTS) throw new Error(`MegaLights light count exceeds ${MAX_MEGA_LIGHTS}.`);
    const iesVec4s = Math.max(input.ies?.vec4Count ?? 1, 1);
    const desired = { width, height, lightVec4s: Math.max(lightCount, 1) * 4, iesVec4s };
    const candidate = this.resources && this.sameCapacity(this.resources, desired) ? this.resources : this.allocate(desired);
    const replace = candidate !== this.resources;
    try {
      this.write(candidate, input);
    } catch (error) {
      if (replace) this.release(candidate);
      throw error;
    }
    if (replace) { const previous = this.resources; this.resources = candidate; if (previous) this.release(previous); }
    return { lightCount, width, height };
  }

  /** 编码一帧(两趟;pass 边界括夹,同 clusterLightCulling 真机定案纪律)。 */
  encode(encoder: GPUCommandEncoder, resources: MegaLightsFrameResources): void {
    this.assertReady();
    const allocation = this.resources;
    if (!allocation || allocation.width !== resources.width || allocation.height !== resources.height) {
      throw new Error("MegaLights encode requires a matching prepare call.");
    }
    this.frameIndex += 1;
    const groupsX = Math.ceil(resources.width / MEGA_LIGHTS_WORKGROUP_SIZE);
    const groupsY = Math.ceil(resources.height / MEGA_LIGHTS_WORKGROUP_SIZE);
    const pass = encoder.beginComputePass({ label: "Deep MegaLights RIS direct lighting" });
    pass.setPipeline(this.buildPipeline);
    pass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, allocation.bindGroup);
    pass.dispatchWorkgroups(groupsX, groupsY);
    pass.end();
    const shadePass = encoder.beginComputePass({ label: "Deep MegaLights reuse and shade" });
    shadePass.setPipeline(this.shadePipeline);
    shadePass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, allocation.bindGroup);
    shadePass.dispatchWorkgroups(groupsX, groupsY);
    shadePass.end();
  }

  /** 颜色输出缓冲(探针 COPY_SRC 回读;生产 M2 由主 pass 消费)。 */
  get colorBuffer(): GPUBuffer {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.color;
  }

  /** 蓄水池 B(下一帧历史;诊断读回用)。 */
  get reservoirsBuffer(): GPUBuffer {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.reservoirsB;
  }

  get pixelCount(): number {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.width * this.resources.height;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resources) { this.release(this.resources); this.resources = undefined; }
  }

  private sameCapacity(current: MegaLightsAllocation,
    desired: { width: number; height: number; lightVec4s: number; iesVec4s: number }): boolean {
    return current.width === desired.width && current.height === desired.height
      && current.lightVec4s >= desired.lightVec4s && current.iesVec4s >= desired.iesVec4s;
  }

  private allocate(desired: { width: number; height: number; lightVec4s: number; iesVec4s: number }): MegaLightsAllocation {
    this.assertReady();
    const device = this.session.device;
    const pixelCount = desired.width * desired.height;
    const owned: GPUBuffer[] = [];
    const allocate = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ size, usage, label }));
      owned.push(buffer);
      return buffer;
    };
    try {
      const params = allocate(MEGA_LIGHTS_PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "Deep MegaLights params");
      // COPY_SRC:灯池诊断读回(pool drift 门);STORAGE 消费不受影响。
      const lights = allocate(desired.lightVec4s * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep MegaLights pool");
      const surfaces = allocate(pixelCount * SURFACE_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep MegaLights surfaces");
      const motion = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep MegaLights motion");
      const reservoirsA = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE, "Deep MegaLights reservoirs A");
      const reservoirsB = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep MegaLights reservoirs B");
      const color = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep MegaLights color");
      const colorHistory = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE, "Deep MegaLights color history");
      const ies = allocate(desired.iesVec4s * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep MegaLights IES shading");
      const bindGroup = device.createBindGroup({ label: "Deep MegaLights bindings", layout: this.layout,
        entries: [
          { binding: MEGA_LIGHTS_PARAMS_BINDING, resource: { buffer: params } },
          { binding: MEGA_LIGHTS_POOL_BINDING, resource: { buffer: lights } },
          { binding: MEGA_LIGHTS_SURFACES_BINDING, resource: { buffer: surfaces } },
          { binding: MEGA_LIGHTS_MOTION_BINDING, resource: { buffer: motion } },
          { binding: MEGA_LIGHTS_RESERVOIRS_A_BINDING, resource: { buffer: reservoirsA } },
          { binding: MEGA_LIGHTS_RESERVOIRS_B_BINDING, resource: { buffer: reservoirsB } },
          { binding: MEGA_LIGHTS_COLOR_BINDING, resource: { buffer: color } },
          { binding: MEGA_LIGHTS_COLOR_HISTORY_BINDING, resource: { buffer: colorHistory } },
          { binding: MEGA_LIGHTS_IES_BINDING, resource: { buffer: ies } },
        ] });
      return { ...desired, params, lights, surfaces, motion, reservoirsA, reservoirsB, color, colorHistory, ies, bindGroup };
    } catch (error) {
      failWithResourceCleanup(error, "MegaLights allocation rollback failed.", owned.map(buffer => () => this.session.release(buffer)));
      throw error;
    }
  }

  private write(allocation: MegaLightsAllocation, input: MegaLightsPrepareInput): void {
    const queue = this.session.device.queue;
    const surfacesUnchanged = this.uploadedSurfaces !== undefined
      && this.uploadedSurfaces.allocation === allocation && this.uploadedSurfaces.surfaces === input.surfaces;
    const frameSeed = input.frameSeed ?? this.frameIndex + 1;
    const words = new Float32Array(MEGA_LIGHTS_PARAMS_BYTES / 4);
    const flags = new Uint32Array(words.buffer);
    flags.set([allocation.width, allocation.height], 0);
    flags.set([input.lights.count, frameSeed >>> 0], 2);
    flags.set([input.spatialEnabled ? 1 : 0, input.temporalEnabled ? 1 : 0, input.exhaustive ? 1 : 0], 4);
    words.set([1.0], 7);
    words.set([input.alphaBlend ?? (1 / 32)], 8);
    queue.writeBuffer(allocation.params, 0, words.buffer as ArrayBuffer);
    queue.writeBuffer(allocation.lights, 0, input.lights.data.buffer as ArrayBuffer, 0, input.lights.data.length * 4);
    if (!surfacesUnchanged) {
      queue.writeBuffer(allocation.surfaces, 0, input.surfaces.buffer as ArrayBuffer, 0, input.surfaces.length * 4);
      this.uploadedSurfaces = { allocation, surfaces: input.surfaces };
    }
    if (input.motion) {
      queue.writeBuffer(allocation.motion, 0, input.motion.buffer as ArrayBuffer, 0, input.motion.length * 4);
    }
    const ies = input.ies?.data ?? new Float32Array([-1, 0, 0, 0]);
    queue.writeBuffer(allocation.ies, 0, ies.buffer as ArrayBuffer, 0, ies.length * 4);
  }

  private release(allocation: MegaLightsAllocation): void {
    for (const buffer of [allocation.params, allocation.lights, allocation.surfaces, allocation.motion,
      allocation.reservoirsA, allocation.reservoirsB, allocation.color, allocation.colorHistory, allocation.ies]) {
      this.session.release(buffer);
    }
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("MegaLights runtime is disposed.");
    if (this.session.state !== "ready") throw new Error(`MegaLights runtime cannot use a ${this.session.state} GPU session.`);
  }
}

/** Pipeline key(遥测/缓存;ABI 或候选预算变化时递增)。 */
export const MEGA_LIGHTS_PIPELINE_KEY = `deep.megalights-ris.v${MEGA_LIGHTS_ABI_VERSION}.k${MEGALIGHTS_RIS_CANDIDATES}`;
