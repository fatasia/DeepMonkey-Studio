/// <reference types="@webgpu/types" />
/**
 * RT specular GI GPU 探针(scripts/rtSpecularGiGpuTest.mjs 驱动,headless Chrome +
 * WebGPU;harness 同 reflectionRayGpuProbe 惯例:Node 仲裁腿与浏览器腿共用同一
 * esbuild bundle,场景/相机/CPU 参考/WGSL 单一来源)。
 *
 * == 浏览器腿(真实帧通道路径) ==
 * 深度 pass → RayTraceClosestFramePass(真机 closest-hit 命中记录)→ GBuffer 合成
 * (线性视深度换算核 + CPU 生成的视法线 upload)→ DFG LUT 生成核 → indirection
 * dispatch → fill dispatch(SSR 合成物 upload:trace mask 矩形区 + composite 输出)→
 * 读回。对照腿:全零 indirection(模拟特性关)的 fill 输出。
 *
 * == 门(Node 仲裁) ==
 * G1 开关零变化:全零 indirection fill 输出 == SSR 合成物上传(逐位);
 * G2 SSR 优先:mask>0 像素 on-case 输出 == SSR 合成物(逐位);
 * G3 RT 屏外替换:mask==0 且 RT 命中像素 == CPU 镜像(rtSpecularFillCompositeCpu),
 *    且 changedPixels ≥ 哨兵(屏外反射可见 = 真实收益);
 * G4 indirection 语义:fraction/radiance == CPU 镜像(容差 = DFG LUT 量化,fraction
 *    ≤ 2e-2、预乘 rgb 相对 ≤ 2%),miss 记录全零;
 * perf:evidence-only(wall-clock p50/p95,on/off 与 SSR-only 三组,不作门——与
 * reflection 探针同口径,帧通道无 timestamp 写入支持)。
 */

import { RayTraceClosestFramePass } from "../src/rayTracing/rayTraceClosestFramePass.js";
import { RtSpecularFillPass, RtSpecularIndirectionPass } from "../src/rayTracing/rtSpecularFramePasses.js";
import { RT_SPECULAR_BOUNCE_ALBEDO } from "../src/rayTracing/rtSpecularIndirectionKernel.js";
import { rtSpecularFillCompositeCpu, rtSpecularIndirectionRecordCpu } from "../src/rayTracing/rtSpecularIndirectionCpu.js";
import { invertColumnMajor4x4 } from "../src/webgpu/rtShadowFrame.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import { buildReflectionScene, referenceReflectionRecords, hitNormalWorld, REFLECTION_BIAS,
  REFLECTION_EYE, REFLECTION_RESOLUTION, REFLECTION_TARGET, REFLECTION_T_MAX,
  type ReflectionScene } from "./reflectionRayGpuCases.js";
import { buildTlas, traceTlasClosest } from "../src/rayTracing/tlas.js";

export { buildReflectionScene, referenceReflectionRecords, REFLECTION_BIAS, REFLECTION_EYE,
  REFLECTION_RESOLUTION, REFLECTION_TARGET, REFLECTION_T_MAX, rtSpecularFillCompositeCpu,
  rtSpecularIndirectionRecordCpu, RT_SPECULAR_BOUNCE_ALBEDO };

export const RT_SPECULAR_PROBE_FRESNEL_F0 = 0.05;
export const RT_SPECULAR_PROBE_ROUGHNESS = 0.25;
/** 探针光照/环境参数(megaLights Lambert N·L shade 语义的解析一次反弹档)。 */
export const RT_SPECULAR_PROBE_LIGHT = {
  surfaceToLightWorld: [0.5, 0.8, -0.3] as const,
  lightColor: [1.0, 0.96, 0.9] as const,
  lightIntensity: 3.0,
  envRadiance: [0.06, 0.07, 0.09] as const,
};
/** SSR 合成物上传的矩形命中区(trace mask=1,模拟屏内 SSR 命中区域)。 */
export const SSR_TRACE_REGION = { x0: 0, y0: 0, x1: 64, y1: 64 } as const;
/** 屏外反射可见哨兵下限(on/off 差分像素数;低于此值视为特性未产生真实收益)。 */
export const RT_SPECULAR_CHANGED_PIXEL_GATE = 40;
const RES = REFLECTION_RESOLUTION;
const DFG_LUT_EDGE = 128, DFG_SAMPLES = 256;
/** 容差(G4):DFG LUT f16 量化 + GPU 积分 vs CPU f64 解析的差吸收带。 */
const FRACTION_TOLERANCE = 2e-2;
const RADIANCE_RELATIVE_TOLERANCE = 2e-2;

export interface RtSpecularGpuProbeResult {
  readonly hitRecordsBase64: string;
  readonly linearDepthBase64: string;
  /** 视法线 GBuffer 上传字节(rgba8unorm 行主序;CPU 仲裁腿同源消费)。 */
  readonly viewNormalBase64: string;
  readonly indirectionBase64: string;
  readonly fillOnBase64: string;
  readonly fillOffBase64: string;
  readonly ssrOutputBase64: string;
  readonly traceBase64: string;
  readonly wallMs: { readonly indirection: number; readonly fillOn: number; readonly ssrOnly: number };
  /** 诊断:命中记录 t>0 数 / 线性深度>0 数 / 深度读回 min-max(证据与失败归因)。 */
  readonly diagnostics?: { readonly hitRecords: number; readonly positiveLinear: number;
    readonly depthMin: number; readonly depthMax: number };
  readonly stackOverflows: number;
  readonly adapter: string | null;
  readonly features: readonly string[];
  readonly errors: readonly string[];
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function f32ToF16Bits(value: number): number {
  const f32 = new Float32Array(1); f32[0] = value;
  const u32 = new Uint32Array(f32.buffer)[0]!;
  const sign = (u32 >>> 16) & 0x8000;
  const exp = (u32 >>> 23) & 0xff;
  const mantissa = u32 & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mantissa ? 1 : 0);
  const reordered = exp - 127 + 15;
  if (reordered >= 0x1f) return sign | 0x7c00;
  if (reordered <= 0) {
    if (reordered < -10) return sign;
    const shifted = mantissa | 0x800000;
    return sign | (shifted >> (14 - reordered));
  }
  return sign | (reordered << 10) | (mantissa >> 13);
}

function f16BitsToF32(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exp === 0) return sign * mantissa * 2 ** -24;
  if (exp === 0x1f) return sign * (mantissa ? NaN : Infinity);
  return sign * (1 + mantissa / 1024) * 2 ** (exp - 15);
}

/** rgba16float 像素缓冲(f64 值入 f16 位型;探针 upload 单源)。 */
export function packRgba16Float(pixels: ArrayLike<readonly [number, number, number, number]>): ArrayBuffer {
  const out = new Uint16Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    out[i * 4] = f32ToF16Bits(pixels[i]![0]!); out[i * 4 + 1] = f32ToF16Bits(pixels[i]![1]!);
    out[i * 4 + 2] = f32ToF16Bits(pixels[i]![2]!); out[i * 4 + 3] = f32ToF16Bits(pixels[i]![3]!);
  }
  return out.buffer;
}

/** rgba16float 读回解码(f16 位型 → f64;行填充剥离同 reflection 探针)。 */
export function unpackRgba16Float(buffer: ArrayBuffer, pixels: number): Float64Array {
  const bits = new Uint16Array(buffer, 0, pixels * 4);
  const out = new Float64Array(pixels * 4);
  for (let i = 0; i < pixels * 4; i++) out[i] = f16BitsToF32(bits[i]!);
  return out;
}

/** SSR 合成物上传单源(trace 矩形 mask + composite 输出;CPU/GPU 两腿共用)。 */
export function buildSsrSynthetic(): { readonly trace: ArrayBuffer; readonly output: ArrayBuffer } {
  const tracePixels: Array<readonly [number, number, number, number]> = [];
  const outputPixels: Array<readonly [number, number, number, number]> = [];
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const inRegion = x >= SSR_TRACE_REGION.x0 && x < SSR_TRACE_REGION.x1
        && y >= SSR_TRACE_REGION.y0 && y < SSR_TRACE_REGION.y1;
      const mask = inRegion ? 1 : 0;
      const radiance: readonly [number, number, number] = inRegion ? [0.9, 0.5, 0.2] : [0, 0, 0];
      tracePixels.push([radiance[0] * mask, radiance[1] * mask, radiance[2] * mask, mask]);
      // SSR composite 合同:out = color*(1-a) + radiance(a 预乘);源色为确定性梯度。
      const colorX = 0.25 + (x / RES) * 0.5;
      outputPixels.push([colorX * (1 - mask) + radiance[0], 0.3 * (1 - mask) + radiance[1],
        0.35 * (1 - mask) + radiance[2], 1]);
    }
  }
  return { trace: packRgba16Float(tracePixels), output: packRgba16Float(outputPixels) };
}

/** 视法线 GBuffer 单源:相机主射线命中表面 → 世界法线 → 视空间(rgba8unorm 编码)。 */
export function buildReceiverViewNormals(scene: ReflectionScene, depth: Float32Array,
  invViewProjection: ArrayLike<number>, worldToViewBasis: readonly [number[], number[], number[]]):
  { readonly bytes: Uint8Array<ArrayBuffer>; readonly hits: number } {
  const tlas = buildTlas(scene.instances);
  const bytes = new Uint8Array(RES * RES * 4);
  let hits = 0;
  const worldOf = (x: number, y: number, d: number): [number, number, number] => {
    const uvX = (x + 0.5) / RES, uvY = (y + 0.5) / RES;
    const ndc = [uvX * 2 - 1, 1 - uvY * 2, d, 1];
    const w = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) w[row]! += invViewProjection[k * 4 + row]! * ndc[k]!;
    }
    return [w[0]! / w[3]!, w[1]! / w[3]!, w[2]! / w[3]!];
  };
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const d = depth[y * RES + x]!;
      let world: readonly [number, number, number] = [0, 0, 1];
      if (d < 1) {
        const p = worldOf(x, y, d);
        const dir = [p[0] - REFLECTION_EYE[0], p[1] - REFLECTION_EYE[1], p[2] - REFLECTION_EYE[2]];
        const len = Math.hypot(...dir);
        const hit = len > 0 ? traceTlasClosest(tlas, { ox: REFLECTION_EYE[0], oy: REFLECTION_EYE[1],
          oz: REFLECTION_EYE[2], dx: dir[0]! / len, dy: dir[1]! / len, dz: dir[2]! / len, tMax: REFLECTION_T_MAX }, 0xff)
          : undefined;
        if (hit !== undefined) {
          world = hitNormalWorld(scene, hit.instanceId, hit.primitiveIndex,
            [dir[0]! / len, dir[1]! / len, dir[2]! / len]);
          hits++;
        }
      }
      const viewX = world[0] * worldToViewBasis[0][0]! + world[1] * worldToViewBasis[0][1]! + world[2] * worldToViewBasis[0][2]!;
      const viewY = world[0] * worldToViewBasis[1][0]! + world[1] * worldToViewBasis[1][1]! + world[2] * worldToViewBasis[1][2]!;
      const viewZ = world[0] * worldToViewBasis[2][0]! + world[1] * worldToViewBasis[2][1]! + world[2] * worldToViewBasis[2][2]!;
      const base = (y * RES + x) * 4;
      bytes[base] = Math.round((viewX * 0.5 + 0.5) * 255);
      bytes[base + 1] = Math.round((viewY * 0.5 + 0.5) * 255);
      bytes[base + 2] = Math.round((viewZ * 0.5 + 0.5) * 255);
      bytes[base + 3] = Math.round(RT_SPECULAR_PROBE_ROUGHNESS * 255);
    }
  }
  return { bytes, hits };
}

/**
 * CPU 仲裁单源:逐像素 indirection 记录与 fill 输出期望(与 GPU 同输入:GPU 读回的
 * 命中记录/线性深度 + CPU 生成的视法线上传)。
 */
export function buildRtSpecularCpuReference(hitRecords: Float32Array, linearDepth: Float32Array,
  viewNormalBytes: Uint8Array, ssrOutput: Float64Array, trace: Float64Array):
  { readonly indirection: Float64Array; readonly fill: Float64Array; readonly hits: number } {
  const pixels = RES * RES;
  const indirection = new Float64Array(pixels * 4);
  const fill = new Float64Array(pixels * 4);
  let hits = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const p = y * RES + x, base = p * 4;
      const record: readonly [number, number, number, number] = [hitRecords[base]!, hitRecords[base + 1]!,
        hitRecords[base + 2]!, hitRecords[base + 3]!];
      const nx = (viewNormalBytes[base]! / 255) * 2 - 1;
      const ny = (viewNormalBytes[base + 1]! / 255) * 2 - 1;
      const nz = (viewNormalBytes[base + 2]! / 255) * 2 - 1;
      const roughness = viewNormalBytes[base + 3]! / 255;
      const record2 = rtSpecularIndirectionRecordCpu(record, [nx, ny, nz], roughness, linearDepth[p]!,
        x, y, RES, RES, { tanHalfFov: Math.tan(50 * Math.PI / 360), aspect: 1,
          ...RT_SPECULAR_PROBE_LIGHT, fresnelF0: RT_SPECULAR_PROBE_FRESNEL_F0 });
      indirection.set(record2, base);
      if (record2[3] > 0) hits++;
      const outRgb: readonly [number, number, number] = [ssrOutput[base]!, ssrOutput[base + 1]!, ssrOutput[base + 2]!];
      fill.set(rtSpecularFillCompositeCpu(outRgb, trace[base + 3]!, record2), base);
    }
  }
  return { indirection, fill, hits };
}

/** 深度 pass(同 reflection 探针)与换算/DFG 生成核(探针私有,与生产合同同式)。 */
const DEPTH_PASS_WGSL = /* wgsl */ `
struct Vp { viewProjection: mat4x4f };
@group(0) @binding(0) var<uniform> vp: Vp;
@vertex fn vs(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return vp.viewProjection * vec4f(position, 1.0);
}
@fragment fn fs() {}
`;

const LINEAR_DEPTH_WGSL = /* wgsl */ `
struct Ld { invViewProjection: mat4x4f, worldToView: mat4x4f };
@group(0) @binding(0) var sourceDepth: texture_depth_2d;
@group(0) @binding(1) var<uniform> ld: Ld;
@group(0) @binding(2) var linearTarget: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn toLinearDepth(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(linearTarget);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let d = textureLoad(sourceDepth, vec2<i32>(gid.xy), 0);
  let uv = (vec2f(gid.xy) + vec2f(0.5)) / vec2f(size);
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let world = ld.invViewProjection * ndc;
  let view = ld.worldToView * vec4f(world.xyz / world.w, 1.0);
  // r32float 存储纹理的 textureStore 在 Dawn 侧要求 vec4f 值(单分量格式仅取 .x)。
  textureStore(linearTarget, vec2<i32>(gid.xy), vec4f(-view.z, 0.0, 0.0, 0.0));
}
`;

// split-sum DFG 生成:与 postprocess/ssrBrdfFraction.ts 同式(GGX 采样 + 高度相关
// Smith 可见性 + Schlick),LUT 供 indirection 内核采样(CPU 仲裁用同函数)。
const DFG_LUT_WGSL = /* wgsl */ `
@group(0) @binding(0) var dfgTarget: texture_storage_2d<rgba16float, write>;
fn radicalInverse(v0: u32) -> f32 {
  var v = v0;
  v = (v << 16u) | (v >> 16u);
  v = ((v & 0x55555555u) << 1u) | ((v & 0xAAAAAAAAu) >> 1u);
  v = ((v & 0x33333333u) << 2u) | ((v & 0xCCCCCCCCu) >> 2u);
  v = ((v & 0x0F0F0F0Fu) << 4u) | ((v & 0xF0F0F0F0u) >> 4u);
  v = ((v & 0x00FF00FFu) << 8u) | ((v & 0xFF00FF00u) >> 8u);
  return f32(v) * 2.3283064365386963e-10;
}
fn ggxHalf(xi: vec2f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let cosine = sqrt((1.0 - xi.y) / max(1.0 + (a * a - 1.0) * xi.y, 0.00001));
  let sine = sqrt(max(1.0 - cosine * cosine, 0.0));
  let phi = 6.283185307179586 * xi.x;
  return vec3f(cos(phi) * sine, sin(phi) * sine, cosine);
}
@compute @workgroup_size(8, 8)
fn generateDfg(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dfgTarget);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let nv = (f32(gid.x) + 0.5) / f32(size.x);
  let roughness = (f32(gid.y) + 0.5) / f32(size.y);
  let sinV = sqrt(max(0.0, 1.0 - nv * nv));
  let view = vec3f(sinV, 0.0, nv);
  var dfgX = 0.0; var dfgY = 0.0;
  let alpha = roughness * roughness; let a2 = alpha * alpha;
  for (var i = 0u; i < ${DFG_SAMPLES}u; i++) {
    let xi = vec2f(f32(i) / ${DFG_SAMPLES}.0, radicalInverse(i));
    let half2 = ggxHalf(xi, roughness);
    let vh = dot(view, half2);
    let lightZ = -view.z + 2.0 * vh * half2.z;
    let nl = max(lightZ, 0.0); let nh = max(half2.z, 0.0); let vhd = max(vh, 0.0);
    if (nl > 0.0) {
      let gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv);
      let gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
      let visibility = 4.0 * nl * (0.5 / max(gv + gl, 0.000001)) * vhd / max(nh, 0.0001);
      let fresnel = pow(1.0 - vhd, 5.0);
      dfgX += (1.0 - fresnel) * visibility;
      dfgY += fresnel * visibility;
    }
  }
  textureStore(dfgTarget, vec2<i32>(gid.xy), vec4f(dfgX / ${DFG_SAMPLES}.0, dfgY / ${DFG_SAMPLES}.0, 0.0, 1.0));
}
`;

function renderPassPipelineWgsl(): string { return DEPTH_PASS_WGSL; }

async function renderSceneDepth(device: GPUDevice, scene: ReflectionScene,
  viewProjection: Float32Array<ArrayBuffer>): Promise<GPUTexture> {
  const vertices: number[] = [];
  for (const blas of scene.blasList) {
    for (let i = 0; i < blas.indices.length; i++) {
      const v = blas.indices[i]! * 3;
      vertices.push(blas.vertices[v]!, blas.vertices[v + 1]!, blas.vertices[v + 2]!);
    }
  }
  const vertexBuffer = device.createBuffer({ size: vertices.length * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(vertices));
  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniform, 0, viewProjection);
  const module = device.createShaderModule({ code: renderPassPipelineWgsl() });
  const pipeline = device.createRenderPipeline({ layout: "auto",
    vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0,
      offset: 0, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fs", targets: [] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
  const depthTexture = device.createTexture({ size: [RES, RES], format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [],
    depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: 1.0,
      depthLoadOp: "clear", depthStoreOp: "store" } });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniform } }] }));
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(vertices.length / 3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return depthTexture;
}

async function readbackF32(device: GPUDevice, texture: GPUTexture, bytesPerPixel: number): Promise<ArrayBuffer> {
  const bytesPerRow = RES * bytesPerPixel;
  const padded = Math.ceil(bytesPerRow / 256) * 256;
  const staging = device.createBuffer({ size: padded * RES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: padded,
    rowsPerImage: RES }, [RES, RES]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const paddedView = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap(); staging.destroy();
  const rowWords = bytesPerRow, padWords = padded;
  const out = new Uint8Array(bytesPerRow * RES);
  for (let y = 0; y < RES; y++) {
    out.set(paddedView.subarray(y * padWords, y * padWords + rowWords), y * rowWords);
  }
  return out.buffer;
}

/** 浏览器探针主入口(page.evaluate 调用)。 */
export async function runRtSpecularGiGpuProbe(): Promise<RtSpecularGpuProbeResult> {
  const errors: string[] = [];
  const empty: RtSpecularGpuProbeResult = { hitRecordsBase64: "", linearDepthBase64: "",
    viewNormalBase64: "", indirectionBase64: "", fillOnBase64: "", fillOffBase64: "",
    ssrOutputBase64: "", traceBase64: "",
    wallMs: { indirection: 0, fillOn: 0, ssrOnly: 0 }, stackOverflows: -1, adapter: null, features: [], errors };
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    return { ...empty, errors: ["WebGPU is not available in this context."] };
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) return { ...empty, errors: ["navigator.gpu.requestAdapter() returned null."] };
  const device = await adapter.requestDevice();
  device.addEventListener?.("uncapturederror", (event: Event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const adapterInfo = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string } }).info;
  try {
    const aspect = RES / RES;
    const viewProjection = multiply(perspective(50 * Math.PI / 180, aspect, 0.1, 200),
      lookAt(REFLECTION_EYE, REFLECTION_TARGET, [0, 1, 0]));
    const worldToView = lookAt(REFLECTION_EYE, REFLECTION_TARGET, [0, 1, 0]);
    const invViewProjection = invertColumnMajor4x4(viewProjection);
    // RayTraceClosestFramePass 合同要 16 元组(与 pbrRendererFrames 同式展开;源保证 16 长)。
    const invViewProjectionTuple = [invViewProjection[0]!, invViewProjection[1]!, invViewProjection[2]!,
      invViewProjection[3]!, invViewProjection[4]!, invViewProjection[5]!, invViewProjection[6]!,
      invViewProjection[7]!, invViewProjection[8]!, invViewProjection[9]!, invViewProjection[10]!,
      invViewProjection[11]!, invViewProjection[12]!, invViewProjection[13]!, invViewProjection[14]!,
      invViewProjection[15]!] as const;
    const scene = buildReflectionScene(false);
    const depthTexture = await renderSceneDepth(device, scene, viewProjection);
    // 线性视深度换算(探针 GBuffer;SSR reconstruct 合同输入)。
    const linearTexture = device.createTexture({ size: [RES, RES], format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    {
      const module = device.createShaderModule({ code: LINEAR_DEPTH_WGSL });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "toLinearDepth" } });
      const uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const packed = new Float32Array(32);
      packed.set(invViewProjection, 0); packed.set(worldToView, 16);
      device.queue.writeBuffer(uniform, 0, packed);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: depthTexture.createView() },
        { binding: 1, resource: { buffer: uniform } },
        { binding: 2, resource: linearTexture.createView() }] }));
      pass.dispatchWorkgroups(Math.ceil(RES / 8), Math.ceil(RES / 8)); pass.end();
      device.queue.submit([encoder.finish()]);
    }
    // DFG LUT 生成(indirection 内核 brdfLut 输入;CPU 仲裁用 ssrBrdfSpecularFractionCpu)。
    const dfgTexture = device.createTexture({ size: [DFG_LUT_EDGE, DFG_LUT_EDGE], format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    {
      const module = device.createShaderModule({ code: DFG_LUT_WGSL });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "generateDfg" } });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: dfgTexture.createView() }] }));
      pass.dispatchWorkgroups(Math.ceil(DFG_LUT_EDGE / 8), Math.ceil(DFG_LUT_EDGE / 8)); pass.end();
      device.queue.submit([encoder.finish()]);
    }
    // closest-hit 命中记录(真机帧通道)。
    const closest = new RayTraceClosestFramePass(device, scene.tlas.packed);
    const hitTexture = device.createTexture({ size: [RES, RES], format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const depthReadback = new Float32Array(await readbackF32(device, depthTexture, 4));
    // 视法线 GBuffer(CPU 单源生成后 upload;仲裁腿复用同一函数与字节)。
    const basis = worldToView;
    const worldToViewBasis: readonly [number[], number[], number[]] = [
      [basis[0]!, basis[4]!, basis[8]!], [basis[1]!, basis[5]!, basis[9]!], [basis[2]!, basis[6]!, basis[10]!]];
    const normals = buildReceiverViewNormals(scene, depthReadback, invViewProjection, worldToViewBasis);
    const normalTexture = device.createTexture({ size: [RES, RES], format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    device.queue.writeTexture({ texture: normalTexture }, normals.bytes, { bytesPerRow: RES * 4,
      rowsPerImage: RES }, [RES, RES, 1]);
    // SSR 合成物 upload(单源 buildSsrSynthetic)。
    const synthetic = buildSsrSynthetic();
    const ssrOutputTexture = device.createTexture({ size: [RES, RES], format: "rgba16float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    const traceTexture = device.createTexture({ size: [RES, RES], format: "rgba16float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    device.queue.writeTexture({ texture: ssrOutputTexture }, new Uint16Array(synthetic.output),
      { bytesPerRow: RES * 8, rowsPerImage: RES }, [RES, RES, 1]);
    device.queue.writeTexture({ texture: traceTexture }, new Uint16Array(synthetic.trace),
      { bytesPerRow: RES * 8, rowsPerImage: RES }, [RES, RES, 1]);
    // indirection(两份:on 用真实记录;off 用全零,模拟特性关)。
    const makeStorageTexture = (format: GPUTextureFormat): GPUTexture =>
      device.createTexture({ size: [RES, RES], format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    const indirectionOn = makeStorageTexture("rgba16float");
    const indirectionOff = makeStorageTexture("rgba16float");
    device.queue.writeTexture({ texture: indirectionOff }, new Uint16Array(RES * RES * 4),
      { bytesPerRow: RES * 8, rowsPerImage: RES }, [RES, RES, 1]);
    const fillOn = makeStorageTexture("rgba16float");
    const fillOff = makeStorageTexture("rgba16float");
    const indirectionPass = new RtSpecularIndirectionPass(device);
    const fillPass = new RtSpecularFillPass(device);
    // 帧编码:on = closest → indirection → fill;计时取 warmup 后最小值链(evidence-only)。
    const encodeFrame = async (indirection: GPUTexture, fill: GPUTexture,
      dispatchIndirection: boolean): Promise<void> => {
      const encoder = device.createCommandEncoder();
      await closest.encode(encoder, { depthView: depthTexture.createView(), hitView: hitTexture.createView(),
        width: RES, height: RES, invViewProjection: invViewProjectionTuple, eye: REFLECTION_EYE, tMax: REFLECTION_T_MAX,
        bias: REFLECTION_BIAS, rayMask: 0xff });
      // 特性关 = 无 indirection dispatch(零纹理保持零;fill 双 miss 逐位透传)。
      if (dispatchIndirection) { indirectionPass.encode(encoder, {
        linearDepthView: linearTexture.createView(), viewNormalView: normalTexture.createView(),
        brdfLutView: dfgTexture.createView(), rtHitView: hitTexture.createView(),
        bounceShadingView: hitTexture.createView(),
        indirectionView: indirection.createView(), width: RES, height: RES,
        params: { width: RES, height: RES, tanHalfFov: Math.tan(50 * Math.PI / 360), aspect: 1,
          surfaceToLightWorld: [...RT_SPECULAR_PROBE_LIGHT.surfaceToLightWorld],
          lightColor: [...RT_SPECULAR_PROBE_LIGHT.lightColor],
          lightIntensity: RT_SPECULAR_PROBE_LIGHT.lightIntensity,
          envRadiance: [...RT_SPECULAR_PROBE_LIGHT.envRadiance],
          fresnelF0: RT_SPECULAR_PROBE_FRESNEL_F0 } }); }
      fillPass.encode(encoder, { ssrOutputView: ssrOutputTexture.createView(),
        ssrTraceView: traceTexture.createView(), indirectionView: indirection.createView(),
        outputView: fill.createView(), width: RES, height: RES });
      device.queue.submit([encoder.finish()]);
    };
    // 计时含 onSubmittedWorkDone(GPU 完成墙钟;纯 enqueue 墙钟在 128² 上 <0.05ms 无意义)。
    const timed = async (run: () => Promise<void>, warmups: number, iterations: number): Promise<number> => {
      for (let i = 0; i < warmups; i++) await run();
      const samples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await run();
        await device.queue.onSubmittedWorkDone();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const p = (q: number): number => samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!;
      return p(0.95);
    };
    await encodeFrame(indirectionOn, fillOn, true);
    await encodeFrame(indirectionOff, fillOff, false);
    const wallIndirection = await timed(async () => {
      const encoder = device.createCommandEncoder();
      await closest.encode(encoder, { depthView: depthTexture.createView(), hitView: hitTexture.createView(),
        width: RES, height: RES, invViewProjection: invViewProjectionTuple, eye: REFLECTION_EYE, tMax: REFLECTION_T_MAX,
        bias: REFLECTION_BIAS, rayMask: 0xff });
      indirectionPass.encode(encoder, {
        linearDepthView: linearTexture.createView(), viewNormalView: normalTexture.createView(),
        brdfLutView: dfgTexture.createView(), rtHitView: hitTexture.createView(),
        bounceShadingView: hitTexture.createView(),
        indirectionView: indirectionOn.createView(), width: RES, height: RES,
        params: { width: RES, height: RES, tanHalfFov: Math.tan(50 * Math.PI / 360), aspect: 1,
          surfaceToLightWorld: [...RT_SPECULAR_PROBE_LIGHT.surfaceToLightWorld],
          lightColor: [...RT_SPECULAR_PROBE_LIGHT.lightColor],
          lightIntensity: RT_SPECULAR_PROBE_LIGHT.lightIntensity,
          envRadiance: [...RT_SPECULAR_PROBE_LIGHT.envRadiance],
          fresnelF0: RT_SPECULAR_PROBE_FRESNEL_F0 } });
      device.queue.submit([encoder.finish()]);
    }, 3, 20);
    const wallFillOn = await timed(() => encodeFrame(indirectionOn, fillOn, true), 3, 20);
    const wallSsrOnly = await timed(async () => {
      const encoder = device.createCommandEncoder();
      await closest.encode(encoder, { depthView: depthTexture.createView(), hitView: hitTexture.createView(),
        width: RES, height: RES, invViewProjection: invViewProjectionTuple, eye: REFLECTION_EYE, tMax: REFLECTION_T_MAX,
        bias: REFLECTION_BIAS, rayMask: 0xff });
      device.queue.submit([encoder.finish()]);
    }, 3, 20);
    const [hitRecords, linearDepth, indirectionReadback, fillOnReadback, fillOffReadback] = await Promise.all([
      readbackF32(device, hitTexture, 16), readbackF32(device, linearTexture, 4),
      readbackF32(device, indirectionOn, 8), readbackF32(device, fillOn, 8), readbackF32(device, fillOff, 8)]);
    const hitF32 = new Float32Array(hitRecords), linearF32 = new Float32Array(linearDepth);
    let hitCount = 0, positiveLinear = 0, depthMin = Infinity, depthMax = -Infinity;
    for (let p = 0; p < RES * RES; p++) {
      if (hitF32[p * 4]! > 0) hitCount++;
      if (linearF32[p]! > 0) positiveLinear++;
    }
    for (let p = 0; p < RES * RES; p++) {
      const d = depthReadback[p]!;
      if (d < depthMin) depthMin = d;
      if (d > depthMax) depthMax = d;
    }
    const diagnostics = { hitRecords: hitCount, positiveLinear, depthMin, depthMax };
    const sentinel = new Uint32Array(4);
    const sentinelStaging = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const readEncoder = device.createCommandEncoder();
    closest.readbackStackOverflows(readEncoder, sentinelStaging);
    device.queue.submit([readEncoder.finish()]);
    await sentinelStaging.mapAsync(GPUMapMode.READ);
    sentinel.set(new Uint32Array(sentinelStaging.getMappedRange()));
    sentinelStaging.unmap(); sentinelStaging.destroy();
    for (const pass of [closest, indirectionPass, fillPass]) pass.destroy();
    for (const texture of [depthTexture, linearTexture, dfgTexture, hitTexture, normalTexture,
      ssrOutputTexture, traceTexture, indirectionOn, indirectionOff, fillOn, fillOff]) texture.destroy();
    device.destroy();
    return { hitRecordsBase64: toBase64(hitRecords), linearDepthBase64: toBase64(linearDepth),
      viewNormalBase64: toBase64(normals.bytes.buffer as ArrayBuffer),
      indirectionBase64: toBase64(indirectionReadback), fillOnBase64: toBase64(fillOnReadback),
      fillOffBase64: toBase64(fillOffReadback), ssrOutputBase64: toBase64(synthetic.output),
      traceBase64: toBase64(synthetic.trace),
      wallMs: { indirection: wallIndirection, fillOn: wallFillOn, ssrOnly: wallSsrOnly },
      diagnostics, stackOverflows: sentinel[0]!, adapter: adapterInfo === undefined ? "unknown"
        : `${adapterInfo.vendor ?? "unknown"}/${adapterInfo.architecture ?? ""}`,
      features: [...adapter.features], errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    device.destroy();
    return { ...empty, errors };
  }
}
