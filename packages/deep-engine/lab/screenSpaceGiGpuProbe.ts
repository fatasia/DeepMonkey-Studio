/// <reference types="@webgpu/types" />
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../src/webgpu/pbrTransientTexturePool.js";
import { ScreenSpaceGiPass } from "../src/postprocess/screenSpaceGi.js";
import { screenSpaceGiCpu } from "../src/postprocess/screenSpaceGiCpu.js";
import { SSGI_COMPOSITE_FORMAT } from "../src/postprocess/screenSpaceGiTypes.js";
import type { ScreenSpaceGiOptions } from "../src/postprocess/screenSpaceGiTypes.js";

/**
 * P2 SSGI 真机 GPU 探针(scripts/ssgi-gpu.mjs 驱动,headless Chrome WebGPU;
 * 模式与 lab/sdfGiGpuProbe 同构)。生产保真:直接构造生产 ScreenSpaceGiPass +
 * 生产 PbrTransientTexturePool + DeviceSession,走 encode 同一入口。
 *
 * 门:①间接光可见(on/off 差分:墙前地面红通道渗透均值 > 0.01 且 > 蓝×2.5,
 * off 时输出逐位等于基色);②GPU/CPU 镜像奇偶(同一解析场景同一 seed,GI 增量
 * max|Δ| ≤ 0.05,如实含 f16 量化);③帧时预算(120 帧独立 submit→完成墙钟,
 * SSGI 帧 p95 增量 ≤ 6ms,含队列开销如实标注);④同 seed 逐位确定、换 seed 旋转。
 */

const WIDTH = 256, HEIGHT = 192;
const COLOR_ROW_BYTES = WIDTH * 8; // rgba16float,天然 256 对齐
const DEPTH_ROW_BYTES = WIDTH * 4;
const OPTIONS: ScreenSpaceGiOptions = { verticalFovRadians: Math.PI / 3, samples: 12,
  maxDistance: 6, thickness: 0.05, steps: 24, refines: 4, edgeFade: 0.08, intensity: 1, seed: 7 };

/** 解析场景(与 screenSpaceGiConventions.test 同布局比例):行 <H/4 远地面(灰,
 * 深度 8),H/4..H/2 红墙带(亮红,深度 6,法线 +Z),≥H/2 近地面(灰,深度 4)。 */
function analyticScene(): { depth: Float32Array; normalBytes: Uint8Array; color: Float32Array } {
  const depth = new Float32Array(WIDTH * HEIGHT);
  const normalBytes = new Uint8Array(WIDTH * HEIGHT * 4);
  const color = new Float32Array(WIDTH * HEIGHT * 3);
  const encode3 = (n: readonly number[]): readonly [number, number, number] =>
    [(n[0]! + 1) / 2 * 255, (n[1]! + 1) / 2 * 255, (n[2]! + 1) / 2 * 255];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const wall = y >= HEIGHT / 4 && y < HEIGHT / 2;
      const farFloor = y < HEIGHT / 4;
      depth[y * WIDTH + x] = wall ? 6 : farFloor ? 8 : 4;
      const [r, g, b] = encode3(wall ? [0, 0, 1] : [0, 1, 0]);
      normalBytes.set([r, g, b, 255], (y * WIDTH + x) * 4);
      const radiance = wall ? [2, 0.05, 0.05] : [0.05, 0.05, 0.05];
      color.set(radiance, (y * WIDTH + x) * 3);
    }
  }
  return { depth, normalBytes, color };
}

function paddedR32(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(DEPTH_ROW_BYTES * HEIGHT);
  new Uint8Array(bytes.buffer, 0, values.length * 4).set(new Uint8Array(values.buffer, 0, values.length * 4));
  return bytes;
}
function paddedRgba16(color: Float32Array): Uint8Array {
  const half = new Uint16Array(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index++) {
    half[index * 4] = f16(color[index * 3]!); half[index * 4 + 1] = f16(color[index * 3 + 1]!);
    half[index * 4 + 2] = f16(color[index * 3 + 2]!); half[index * 4 + 3] = f16(1);
  }
  const bytes = new Uint8Array(COLOR_ROW_BYTES * HEIGHT);
  bytes.set(new Uint8Array(half.buffer, half.byteOffset, half.byteLength));
  return bytes;
}
/** f32 → f16 bit pattern(够探针精度;舍入方向不影响门,奇偶容差如实覆盖)。 */
function f16(value: number): number {
  const f32 = new Float32Array(1); f32[0] = value;
  const bits = new Uint32Array(f32.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x007f_ffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 1 : 0);
  const rebased = exponent - 127 + 15;
  if (rebased >= 0x1f) return sign | 0x7c00;
  if (rebased <= 0) return sign;
  return sign | (rebased << 10) | (mantissa >>> 13);
}

function decodeRgba16(bytes: Uint8Array): Float32Array {
  const half = new Uint16Array(bytes.buffer, bytes.byteOffset, WIDTH * HEIGHT * 4);
  const out = new Float32Array(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index++) {
    out[index * 3] = h16ToFloat(half[index * 4]!);
    out[index * 3 + 1] = h16ToFloat(half[index * 4 + 1]!);
    out[index * 3 + 2] = h16ToFloat(half[index * 4 + 2]!);
  }
  return out;
}
function h16ToFloat(half: number): number {
  const sign = (half & 0x8000) >> 15, exponent = (half & 0x7c00) >> 10, mantissa = half & 0x03ff;
  if (exponent === 0) return sign ? -0 : 0;
  if (exponent === 0x1f) return sign ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const f32 = new Float32Array(1);
  new Uint32Array(f32.buffer)[0] = (sign << 31) | ((exponent - 15 + 127) << 23) | (mantissa << 13);
  return f32[0]!;
}

export async function runSsgiGpuProbe(): Promise<Record<string, unknown>> {
  const evidence: Record<string, unknown> = {};
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const errorMessages: string[] = [];
  session.device.addEventListener("uncapturederror", event => {
    errorMessages.push((event as GPUUncapturedErrorEvent).error.message);
  });
  try {
    if (session.state !== "ready") throw new Error("device session is not ready");
    const device = session.device;
    const pool = new PbrTransientTexturePool(session);
    const pass = new ScreenSpaceGiPass(session, pool);
    const scene = analyticScene();
    const owned: Array<GPUTexture | GPUBuffer> = [];
    const own = <T extends GPUTexture | GPUBuffer>(resource: T): T => { owned.push(session.own(resource)); return resource; };
    const depthTexture = own(device.createTexture({ label: "SSGI probe depth", size: [WIDTH, HEIGHT],
      format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    const normalTexture = own(device.createTexture({ label: "SSGI probe normals", size: [WIDTH, HEIGHT],
      format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    const colorTexture = own(device.createTexture({ label: "SSGI probe color", size: [WIDTH, HEIGHT],
      format: SSGI_COMPOSITE_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    device.queue.writeTexture({ texture: depthTexture }, paddedR32(scene.depth).buffer as ArrayBuffer,
      { bytesPerRow: DEPTH_ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    device.queue.writeTexture({ texture: normalTexture }, scene.normalBytes.buffer as ArrayBuffer,
      { bytesPerRow: WIDTH * 4, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    device.queue.writeTexture({ texture: colorTexture }, paddedRgba16(scene.color).buffer as ArrayBuffer,
      { bytesPerRow: COLOR_ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    const readback = own(device.createBuffer({ label: "SSGI probe readback",
      size: COLOR_ROW_BYTES * HEIGHT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));

    const renderFrame = async (revision: number, seed: number): Promise<Float32Array> => {
      pool.beginFrame();
      try {
        const encoder = device.createCommandEncoder({ label: `SSGI probe frame ${revision}` });
        const result = pass.encode(encoder, { color: colorTexture, depth: depthTexture,
          normal: normalTexture, revision, depthEncoding: "linear-view-depth-positive",
          normalSpace: "view", colorEncoding: "linear-hdr" }, { ...OPTIONS, seed });
        encoder.copyTextureToBuffer({ texture: result.texture }, { buffer: readback,
          bytesPerRow: COLOR_ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const decoded = decodeRgba16(new Uint8Array(readback.getMappedRange().slice(0)));
        readback.unmap();
        return decoded;
      } finally { pool.endFrame(true); }
    };

    // ①间接光可见:GI 增量 = on 输出 − 基色(SSGI off 时链路不存在,输出 = 基色,
    // 增量恒 0——由"未构造即零拓扑"的 features 合同承担,探针测的是 on 态增量)。
    const onOutput = await renderFrame(1, OPTIONS.seed);
    const giDelta = new Float32Array(onOutput.length);
    for (let index = 0; index < onOutput.length; index++) {
      giDelta[index] = onOutput[index]! - scene.color[index]!;
    }
    // 渗透区 = 墙带正前方近地面(与测试布局同比例:行 53-56%)。
    const bleedRowStart = Math.round(HEIGHT * 0.53), bleedRowEnd = Math.round(HEIGHT * 0.57);
    let redSum = 0, blueSum = 0, count = 0;
    for (let y = bleedRowStart; y < bleedRowEnd; y++) {
      for (let x = 32; x < WIDTH - 32; x++) {
        const base = (y * WIDTH + x) * 3;
        redSum += giDelta[base]!; blueSum += giDelta[base + 2]!; count++;
      }
    }
    const meanRed = redSum / count, meanBlue = blueSum / count;
    evidence.bleed = { meanRed, meanBlue, samples: count };
    evidence.bleedGate = { redThreshold: 0.01, ratioThreshold: 2.5,
      pass: meanRed > 0.01 && meanRed > meanBlue * 2.5 };

    // ②CPU 镜像奇偶:同场景同 seed,GPU 输出 − 基色 vs CPU 合成输出 − 基色。
    const cpu = screenSpaceGiCpu({ width: WIDTH, height: HEIGHT, depth: scene.depth,
      normals: normalUnormToLinear(scene.normalBytes), color: scene.color }, { ...OPTIONS });
    let parityMax = 0;
    for (let index = 0; index < onOutput.length; index++) {
      parityMax = Math.max(parityMax,
        Math.abs((onOutput[index]! - scene.color[index]!) - (cpu.output[index]! - scene.color[index]!)));
    }
    evidence.parity = { maxAbsDiff: parityMax, tolerance: 0.05, pass: parityMax <= 0.05 };

    // ④确定性:同 seed 两次逐位相等;换 seed 必须不同。
    const repeat = await renderFrame(2, OPTIONS.seed);
    let repeatMaxDiff = 0;
    for (let index = 0; index < onOutput.length; index++) {
      repeatMaxDiff = Math.max(repeatMaxDiff, Math.abs(repeat[index]! - onOutput[index]!));
    }
    const rotated = await renderFrame(3, OPTIONS.seed + 1);
    let rotatedMaxDiff = 0;
    for (let index = 0; index < onOutput.length; index++) {
      rotatedMaxDiff = Math.max(rotatedMaxDiff, Math.abs(rotated[index]! - onOutput[index]!));
    }
    evidence.determinism = { sameSeedMaxAbsDiff: repeatMaxDiff, rotatedSeedMaxAbsDiff: rotatedMaxDiff,
      pass: repeatMaxDiff === 0 && rotatedMaxDiff > 0 };

    // ③帧时预算:SSGI 帧 vs 空帧,各 120 帧独立 submit → onSubmittedWorkDone 墙钟。
    const withPass: number[] = [], withoutPass: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      pool.beginFrame();
      const encoder = device.createCommandEncoder({ label: `SSGI timing ${frame}` });
      const start = performance.now();
      pass.encode(encoder, { color: colorTexture, depth: depthTexture, normal: normalTexture,
        revision: 10 + frame, depthEncoding: "linear-view-depth-positive", normalSpace: "view",
        colorEncoding: "linear-hdr" }, OPTIONS);
      const encodeMs = performance.now() - start;
      void encodeMs;
      const submitStart = performance.now();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      withPass.push(performance.now() - submitStart);
      pool.endFrame(true);
      const empty = device.createCommandEncoder({ label: `SSGI baseline ${frame}` });
      const emptySubmit = performance.now();
      device.queue.submit([empty.finish()]);
      await device.queue.onSubmittedWorkDone();
      withoutPass.push(performance.now() - emptySubmit);
    }
    evidence.frameTiming = {
      withPassP95: percentile(withPass, 0.95), withPassP50: percentile(withPass, 0.5),
      baselineP95: percentile(withoutPass, 0.95), baselineP50: percentile(withoutPass, 0.5),
      incrementP95: percentile(withPass, 0.95) - percentile(withoutPass, 0.95),
      budgetMs: 6,
      methodology: "per-frame queue.submit → onSubmittedWorkDone wall clock, 120 samples each, queue overhead included",
      pass: percentile(withPass, 0.95) - percentile(withoutPass, 0.95) <= 6,
    };
    evidence.uncapturedErrors = session.hasErrors || errorMessages.length > 0;
    evidence.errorMessages = errorMessages.slice(0, 8);
    evidence.uncapturedGate = { pass: evidence.uncapturedErrors !== true };
    evidence.gate = evidence.bleedGate.pass === true && evidence.parity.pass === true
      && evidence.determinism.pass === true && evidence.frameTiming.pass === true
      && evidence.uncapturedErrors !== true;
    pass.dispose();
    return evidence;
  } finally {
    session.dispose();
  }
}

/** rgba8unorm 字节 → 线性视空间 xyz(CPU 镜像输入合同:×2−1 由镜像自己做,这里给原字节)。 */
function normalUnormToLinear(bytes: Uint8Array): number[] {
  const out = new Array<number>(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index++) {
    out[index * 3] = bytes[index * 4]! / 255;
    out[index * 3 + 1] = bytes[index * 4 + 1]! / 255;
    out[index * 3 + 2] = bytes[index * 4 + 2]! / 255;
  }
  return out;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}
