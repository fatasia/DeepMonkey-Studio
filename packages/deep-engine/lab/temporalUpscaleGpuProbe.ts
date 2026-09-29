import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import type { FrameMetrics } from "../src/webgpu/pbrRendererTypes.js";

/**
 * F4 时域超分真机对拍探针(headless Chrome WebGPU),完整 PbrRenderer 路径,三腿同
 * 相机轨迹:truth(1.0 真值)/upscale(0.75+时域上采样核)/stretched(0.75 无核,现状
 * 浏览器拉伸语义)。证据:
 *  - present-color HDR 读回(rgba16float)逐帧 PSNR:upscale/stretched 相对 truth;
 *  - FrameMetrics.temporalUpscale 遥测(historyUsed/invalidation,默认关闭腿不得出现);
 *  - gpuPassTimings 逐 pass:opaque 真实光栅节省 vs temporal-upscale 开销,净收益判据;
 *  - ghost 衰减:运动停止后残差(PRELIM:逐帧 PSNR 曲线)。
 */

export const WIDTH = 512, HEIGHT = 384;
export const SCALE = 0.75;
export const MOVE_FRAMES = 8, SETTLE_FRAMES = 4;

export type LegMode = "truth" | "upscale" | "stretched";

interface UpscaleProbeFrame {
  readonly frame: number;
  readonly psnrToTruth: number | null;
  /** 梯度能量比(对 truth 的边缘 Laplacian 能量保持,1=完全保持;锐度感知代理)。 */
  readonly edgeEnergyRatio: number | null;
  readonly temporalUpscale: FrameMetrics["temporalUpscale"] | null;
  readonly resolutionScaleRevision: number | null;
  readonly opaquePassMs: number | null;
  readonly upscalePassMs: number | null;
}

interface ActiveLeg {
  readonly mode: LegMode;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly frames: UpscaleProbeFrame[];
  frameCount: number;
}

let active: ActiveLeg | undefined;
/** truth 腿逐帧 HDR(跨腿共享:后续腿按帧索引对拍)。 */
const truthSnapshots: Array<{ readonly width: number; readonly height: number; readonly rgb: Float32Array }> = [];
const completed: Array<{ readonly mode: LegMode; readonly frames: readonly UpscaleProbeFrame[] }> = [];

/** 中性灰度等距柱状环境(与场景对比中性,PSNR 由几何边缘主导)。 */
function uniformEquirect(gray: number) {
  const width = 64, height = 32, data = new Float32Array(width * height * 3);
  for (let index = 0; index < width * height; index++) {
    data[index * 3] = gray; data[index * 3 + 1] = gray; data[index * 3 + 2] = gray;
  }
  return { width, height, data };
}

/** 高频对抗场景:7×5 棋盘球(中频) + 12 根细栅栏条(奈奎斯特附近,上采样核的判别点)。 */
function gridInstances(): Float32Array {
  const floats: number[] = [];
  for (let row = 0; row < 5; row++) for (let column = 0; column < 7; column++) {
    const x = (column - 3) * 0.52, z = (row - 2) * 0.52;
    const bright = (row + column) % 2 === 0;
    const c = bright ? 0.85 : 0.06;
    floats.push(x, 0.18, z, 0.18, c, c, bright ? 0.9 : 0.05, 0, 0.5, 0, 0, 0);
  }
  // 细栅栏:x∈[-1.6,1.6] 间距 0.29,条宽 0.03 高 0.9——0.75 档下每条 ~2px。
  for (let index = 0; index < 12; index++) {
    const x = -1.6 + index * 0.29;
    const bright = index % 2 === 0;
    const c = bright ? 0.9 : 0.04;
    floats.push(x, 0.5, -1.4, 0.015, c, c, bright ? 1 : 0.02, 0, 0.5, 0, 0, 0);
    floats.push(x, 0.5, 1.2, 0.015, c, c, bright ? 1 : 0.02, 0, 0.5, 0, 0, 0);
  }
  // 加重光栅负载:背景棋盘地砖阵(8×6 大球压后场),让 opaque 节省脱离固定开销噪声。
  for (let row = 0; row < 6; row++) for (let column = 0; column < 8; column++) {
    const x = (column - 3.5) * 1.1, z = -2.6 - row * 0.9;
    const bright = (row + column) % 2 === 0;
    const c = bright ? 0.5 : 0.1;
    floats.push(x, 0.5, z, 0.4, c, c, bright ? 0.6 : 0.15, 0, 0.5, 0, 0, 0);
  }
  return new Float32Array(floats);
}

/** 相机水平扫过 8 帧后停住(运动矢量窗 → 时域收敛/ghost 窗)。 */
function viewAt(frame: number) {
  const offsetX = frame < MOVE_FRAMES ? (frame - (MOVE_FRAMES - 1) / 2) * 0.16 : 0.68;
  return {
    eye: [offsetX, 1.1, 3.0] as [number, number, number],
    target: [0, 0.2, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number],
    extent: 4, background: [0.08, 0.09, 0.11] as [number, number, number],
    floor: [0.05, 0.05, 0.06] as [number, number, number],
    exposure: 1, roughness: 0.4,
    width: WIDTH, height: HEIGHT, pixelRatio: 1,
  };
}

/**
 * 锁定 0.75 档:policy 要求 max>min,用 upStep<quantize/2 让升档候选量化后等于当前值
 * (at-ceiling 分支,scale 不漂移);targetFrameMs=1 使反馈恒 below-band,降档永不触发。
 */
const lockedPolicy = {
  targetFrameMs: 1, hysteresisMs: 0.5, minScale: SCALE, maxScale: SCALE + 0.005,
  downStep: 0.005, upStep: 0.005, upHoldFrames: 1, quantize: 1 / 64,
};

export function probeLegCount(): number { return completed.length; }

export async function beginLeg(mode: LegMode): Promise<void> {
  if (active) throw new Error("Previous probe leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const downscale = mode !== "truth";
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr", image: uniformEquirect(0.25) },
    ...(downscale ? { resolutionScalePolicy: lockedPolicy } : {}),
    features: { environment: true, fog: false, groundPlane: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: true, spatialAa: false, occlusionCulling: false,
      bloom: false, vignette: true, contactShadows: false,
      ...(mode === "upscale" ? { temporalUpscale: true } : {}) },
    gpuPassTiming: true,
    frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  renderer.setInstances(new Float32Array(gridInstances().buffer as ArrayBuffer));
  await renderer.validateFrame(viewAt(0));
  active = { mode, canvas, renderer, frames: [], frameCount: 0 };
  if (mode === "truth") truthSnapshots.length = 0;
}

/** HDR snapshot → 线性 RGB 平面(行距感知,双线性重采样到 truth 网格供跨腿对拍)。 */
function snapshotRgb(snapshot: { readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly format: string; readonly bytes: Uint8Array }): Float32Array {
  if (snapshot.format !== "rgba16float") throw new Error(`Unexpected present-color format ${snapshot.format}.`);
  const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength / 2);
  const rgb = new Float32Array(snapshot.width * snapshot.height * 3);
  for (let y = 0; y < snapshot.height; y++) for (let x = 0; x < snapshot.width; x++) {
    const offset = y * (snapshot.bytesPerRow / 2) + x * 4;
    rgb[(y * snapshot.width + x) * 3] = decodeHalfFloat(words[offset]!);
    rgb[(y * snapshot.width + x) * 3 + 1] = decodeHalfFloat(words[offset + 1]!);
    rgb[(y * snapshot.width + x) * 3 + 2] = decodeHalfFloat(words[offset + 2]!);
  }
  return rgb;
}

/** 双线性重采样(源网格 → W×H):stretched 腿 0.75 画布升到 truth 网格,复刻浏览器拉伸。 */
function resampleBilinear(source: Float32Array, sw: number, sh: number, width: number, height: number): Float32Array {
  const output = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = (x + 0.5) / width * sw - 0.5, py = (y + 0.5) / height * sh - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    for (let channel = 0; channel < 3; channel++) {
      const sample = (sx: number, sy: number) =>
        source[(Math.min(sh - 1, Math.max(0, sy)) * sw + Math.min(sw - 1, Math.max(0, sx))) * 3 + channel]!;
      output[(y * width + x) * 3 + channel] =
        (sample(x0, y0) * (1 - fx) + sample(x0 + 1, y0) * fx) * (1 - fy)
        + (sample(x0, y0 + 1) * (1 - fx) + sample(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return output;
}

function psnr(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) { const d = a[index]! - b[index]!; sum += d * d; }
  const mse = sum / a.length;
  return mse <= 1e-12 ? 99 : 10 * Math.log10(1 / mse);
}

/** RGB 平面的边缘 Laplacian 能量(|∇²| 平方和):感知锐度代理,值高=边缘更锐。 */
function edgeEnergy(rgb: Float32Array, width: number, height: number): number {
  let sum = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    for (let channel = 0; channel < 3; channel++) {
      const at = (dy: number, dx: number) => rgb[((y + dy) * width + (x + dx)) * 3 + channel]!;
      const laplacian = 4 * at(0, 0) - at(1, 0) - at(-1, 0) - at(0, 1) - at(0, -1);
      sum += laplacian * laplacian;
    }
  }
  return sum;
}

export async function stepLeg(count: number): Promise<readonly UpscaleProbeFrame[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const step: UpscaleProbeFrame[] = [];
  for (let index = 0; index < count; index++) {
    const metrics = active.renderer.render(viewAt(active.frameCount));
    active.frameCount += 1;
    const results = await active.renderer.frameReadbackResults;
    const snapshot = (results ?? []).find(isPbrFrameReadbackSnapshot);
    let rgb = snapshot ? snapshotRgb(snapshot) : null;
    const reference = active.mode === "truth" ? undefined : truthSnapshots[active.frames.length];
    let psnrToTruth: number | null = null;
    let edgeEnergyRatio: number | null = null;
    if (rgb && reference) {
      const aligned = rgb.length === reference.rgb.length ? rgb
        : resampleBilinear(rgb, snapshot!.width, snapshot!.height, reference.width, reference.height);
      psnrToTruth = psnr(aligned, reference.rgb);
      edgeEnergyRatio = edgeEnergy(aligned, reference.width, reference.height)
        / Math.max(1e-9, edgeEnergy(reference.rgb, reference.width, reference.height));
    }
    if (rgb && active.mode === "truth") {
      truthSnapshots.push({ width: snapshot!.width, height: snapshot!.height, rgb });
    }
    const passTimings = metrics?.gpuPassTimings;
    const passMs = (passId: string): number | null => {
      const entry = passTimings?.passes?.find(candidate => candidate.passId === passId);
      return entry ? entry.durationMs : null;
    };
    const record: UpscaleProbeFrame = Object.freeze({
      frame: metrics?.frame ?? active.frameCount,
      psnrToTruth,
      edgeEnergyRatio,
      temporalUpscale: metrics?.temporalUpscale ?? null,
      resolutionScaleRevision: metrics?.resolutionScale ? metrics.resolutionScale.revision : null,
      opaquePassMs: passMs("opaque"),
      upscalePassMs: passMs("temporal-upscale"),
    });
    active.frames.push(record);
    step.push(record);
  }
  return step;
}

export async function endLeg(): Promise<{ readonly mode: LegMode; readonly frames: readonly UpscaleProbeFrame[] }> {
  if (!active) throw new Error("beginLeg was not called.");
  const leg = Object.freeze({ mode: active.mode, frames: Object.freeze(active.frames) });
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  completed.push(leg);
  return leg;
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string;
  readonly description?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}
