import {
  DEFAULT_EXTENDED_HEADROOM, DEFAULT_PQ_PEAK_NITS, HDR_REFERENCE_WHITE_NITS,
  type HdrDisplayStrategy,
} from "../src/webgpu/hdrDisplayOutput.js";
import { hdrSettingsUniform } from "../src/webgpu/pbrHdrDisplay.js";
import { createHdrDisplayPipeline, createHdrDisplayAuthorLayout } from "../src/webgpu/pbrHdrDisplayPipeline.js";
import { WHITE_FURNACE_ENVIRONMENT_RADIANCE } from "../src/webgpu/whiteFurnace.js";
import { outputShader } from "../src/webgpu/pbrOutputShader.js";

/**
 * I-C21 真机探针 —— GPU 会话与数据面(从 hdrDisplayGpuProbe 按职责拆出):
 * f16 编解码、斜坡/灰度源、离屏读回、共享 ProbeSession(单 device + SDR/HDR 管线组,
 * author 布局单例复用)。策略与判据在 hdrDisplayGpuProbe.ts。
 */

export const WIDTH = 128, HEIGHT = 128;
export const STRATEGIES: readonly Exclude<HdrDisplayStrategy, "aces-sdr">[] =
  ["extended-linear", "pq-2020", "hlg-2020"];

// ---- f16 编码(经典 toHalfFloat 算法;与 rayTracing/probeGridBakeMath decodeHalfFloat 对偶) ----
const halfScratch = new ArrayBuffer(4);
const halfFloatView = new Float32Array(halfScratch);
const halfIntView = new Int32Array(halfScratch);
function encodeHalfFloat(value: number): number {
  halfFloatView[0] = value;
  const x = halfIntView[0]!;
  let bits = (x >> 16) & 0x8000;
  let mantissa = (x >> 12) & 0x07ff;
  const exponent = (x >> 23) & 0xff;
  if (exponent < 103) return bits;
  if (exponent > 142) {
    bits |= 0x7c00;
    bits |= ((exponent === 255 ? 1 : 0) && (x & 0x007fffff));
    return bits;
  }
  if (exponent < 113) {
    mantissa |= 0x0800;
    bits |= (mantissa >> (114 - exponent)) + ((mantissa >> (113 - exponent)) & 1);
    return bits;
  }
  bits |= ((exponent - 112) << 10) | (mantissa >> 1);
  bits += mantissa & 1;
  return bits;
}

/** 斜坡源:0..8 线性(含超白高光);返回行主序 f16 RGBA 字节与线性参考。 */
export function rampSource(): { readonly bytes: Uint8Array<ArrayBuffer>; readonly linear: Float32Array } {
  const linear = new Float32Array(WIDTH * HEIGHT * 3);
  const bytes = new Uint8Array(WIDTH * HEIGHT * 8);
  const words = new Uint16Array(bytes.buffer);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = (x / (WIDTH - 1)) * 8;
      const offset = (y * WIDTH + x) * 4;
      words[offset] = encodeHalfFloat(value);
      words[offset + 1] = encodeHalfFloat(value * 0.8);
      words[offset + 2] = encodeHalfFloat(value * 1.2);
      words[offset + 3] = encodeHalfFloat(1);
      linear[(y * WIDTH + x) * 3] = value;
      linear[(y * WIDTH + x) * 3 + 1] = value * 0.8;
      linear[(y * WIDTH + x) * 3 + 2] = value * 1.2;
    }
  }
  return { bytes, linear };
}

export function graySourceBytes(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(WIDTH * HEIGHT * 8);
  const words = new Uint16Array(bytes.buffer);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    words[pixel * 4] = encodeHalfFloat(value);
    words[pixel * 4 + 1] = encodeHalfFloat(value);
    words[pixel * 4 + 2] = encodeHalfFloat(value);
    words[pixel * 4 + 3] = encodeHalfFloat(1);
  }
  return bytes;
}

export function decodeRgba16float(snapshot: { readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly bytes: Uint8Array }): Float32Array {
  const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength / 2);
  const stride = snapshot.bytesPerRow / 2;
  const pixels = new Float32Array(snapshot.width * snapshot.height * 4);
  const decode = (half: number): number => {
    const sign = (half & 0x8000) >> 15, e = (half & 0x7c00) >> 10, mantissa = half & 0x03ff;
    if (e === 0) return 0;
    if (e === 0x1f) return Number.NaN;
    const value = Math.pow(2, e - 15) * (1 + mantissa / 1024);
    return sign === 0 ? value : -value;
  };
  for (let y = 0; y < snapshot.height; y += 1) {
    for (let x = 0; x < snapshot.width; x += 1) {
      const source = y * stride + x * 4, target = (y * snapshot.width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[target + channel] = decode(words[source + channel]!);
      }
    }
  }
  return pixels;
}

export async function copyTextureReadback(device: GPUDevice, texture: GPUTexture,
  bytesPerRow: number, height = HEIGHT): Promise<Uint8Array<ArrayBuffer>> {
  const staging = device.createBuffer({ size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width: WIDTH, height });
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return bytes;
}

// ---- 共享会话:一个 device + 离屏目标 + SDR/HDR 管线组(author 布局单例复用) ----

export interface ProbeSession {
  readonly device: GPUDevice;
  readonly sdrPipeline: GPURenderPipeline;
  readonly hdrPipelines: ReadonlyMap<HdrDisplayStrategy, Awaited<ReturnType<typeof createHdrDisplayPipeline>>>;
  readonly sourceRamp: GPUTexture;
  readonly sourceGray: GPUTexture;
  readonly sdrTarget: GPUTexture;
  readonly hdrTarget: GPUTexture;
  readonly settingsBuffer: GPUBuffer;
  readonly authorBuffer: GPUBuffer;
  readonly authorLayout: GPUBindGroupLayout;
}

let session: ProbeSession | undefined;

export async function ensureSession(): Promise<ProbeSession> {
  if (session) return session;
  if (!navigator.gpu) throw new Error("WebGPU is unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice({ label: "hdr-display-probe" });
  device.addEventListener("uncapturederror", event => {
    console.log(`[hdr-probe] gpu-error: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const module = device.createShaderModule({ label: "hdr probe sdr output", code: outputShader });
  const sdrPipeline = await device.createRenderPipelineAsync({ label: "hdr probe sdr", layout: "auto",
    vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format: "bgra8unorm" }] },
    primitive: { topology: "triangle-list" } });
  const authorLayout = createHdrDisplayAuthorLayout(device);
  const hdrPipelines = new Map<HdrDisplayStrategy, Awaited<ReturnType<typeof createHdrDisplayPipeline>>>();
  for (const strategy of STRATEGIES) {
    hdrPipelines.set(strategy, await createHdrDisplayPipeline(device, "rgba16float", authorLayout));
  }
  const { bytes: rampBytes } = rampSource();
  const sourceRamp = device.createTexture({ label: "hdr probe ramp", size: [WIDTH, HEIGHT],
    format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: sourceRamp }, rampBytes,
    { bytesPerRow: WIDTH * 8, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT });
  const sourceGray = device.createTexture({ label: "hdr probe gray", size: [WIDTH, HEIGHT],
    format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: sourceGray }, graySourceBytes(WHITE_FURNACE_ENVIRONMENT_RADIANCE),
    { bytesPerRow: WIDTH * 8, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT });
  const sdrTarget = device.createTexture({ label: "hdr probe sdr target", size: [WIDTH, HEIGHT],
    format: "bgra8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const hdrTarget = device.createTexture({ label: "hdr probe hdr target", size: [WIDTH, HEIGHT],
    format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const settingsBuffer = device.createBuffer({ label: "hdr probe settings",
    size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // settings: exposure 1,vignette 0,toneMapping 0(deep-aces),grading 中性 —— 纯编码对照。
  device.queue.writeBuffer(settingsBuffer, 0, new Float32Array([1, 0, 0, 0, 0, 0, 1, 1]));
  const authorBuffer = device.createBuffer({ label: "hdr probe author",
    size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(authorBuffer, 0, new Float32Array(12));
  session = { device, sdrPipeline, hdrPipelines, sourceRamp, sourceGray, sdrTarget, hdrTarget,
    settingsBuffer, authorBuffer, authorLayout };
  return session;
}

export function authorBindGroup(probe: ProbeSession): GPUBindGroup {
  return probe.device.createBindGroup({ layout: probe.authorLayout,
    entries: [{ binding: 0, resource: { buffer: probe.authorBuffer } }] });
}

export function writeStrategySettings(probe: ProbeSession, strategy: HdrDisplayStrategy): void {
  const policy = {
    mode: "hdr" as const, strategy, failClosed: false, reason: "hdr-active" as const,
    ...(strategy === "pq-2020" ? { pqPeakNits: DEFAULT_PQ_PEAK_NITS } : {}),
  };
  probe.device.queue.writeBuffer(probe.hdrPipelines.get(strategy)!.hdrSettingsBuffer, 0,
    hdrSettingsUniform(policy, HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM));
}
