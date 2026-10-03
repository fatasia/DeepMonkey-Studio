import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import type { FrameMetrics } from "../src/webgpu/pbrRendererTypes.js";
import { ssrLuminance, ssrSsimRegion } from "../src/postprocess/screenSpaceReflectionQuality.js";
import { sphereMesh } from "../src/webgpu/primitives.js";
import type { RenderPacket } from "../src/renderPacketTypes.js";
import { uniformEquirect, gridInstances, snapshotRgb, resampleBilinear, psnr, edgeEnergy,
  type LegMode } from "./temporalUpscaleGpuProbe.js";

export type { LegMode };
export { probeAdapterInfo } from "./temporalUpscaleGpuProbe.js";

/**
 * F4 67% 档四序列画质探针(headless Chrome WebGPU,完整 PbrRenderer 生产路径)。
 * 与 2026-09-29 的 0.75 档单序列探针互补:本探针固定 2/3 档(resolutionScaler.test
 * 0.67 先例同档),静态/平移/旋转/缩放四序列 + 透明掩码附加序列,每序列 truth /
 * upscale / stretched 三腿,逐帧 SSIM(复用 ssrSsimRegion 8×8 窗口径)+ PSNR +
 * 边缘能量对拍全分辨率真值。帧时通道本轮禁测(并行 GPU 负载),不开 gpuPassTiming。
 * F1 coverage 复用:逐帧记录 temporal-upscale 是否在 executed 集(量,非时,零同步)。
 */

export const WIDTH = 512, HEIGHT = 384;
/** 67% 档 = 2/3;内部渲染 floor 量化 → 341×256(纵横比与画布差 0.1%,报告登记)。 */
export const SCALE = 2 / 3;
export const MOVE_FRAMES = 8, SETTLE_FRAMES = 4, FRAMES = MOVE_FRAMES + SETTLE_FRAMES;
export const SEQUENCES = ["static", "pan", "orbit", "zoom", "transparency"] as const;
export type SequenceKind = (typeof SEQUENCES)[number];

export interface UpscaleSequenceFrame {
  readonly frame: number;
  readonly psnrToTruth: number | null;
  readonly ssimToTruth: number | null;
  /** 梯度能量比(对 truth 的边缘 Laplacian 能量保持,1=完全保持;锐度感知代理)。 */
  readonly edgeEnergyRatio: number | null;
  /** present-color HDR 读回非有限值计数(0 = 完整)。 */
  readonly nanCount: number;
  readonly temporalUpscale: FrameMetrics["temporalUpscale"] | null;
  /** F1 coverage:temporal-upscale 是否在本帧 executed 集(仅 upscale 腿应为 true)。 */
  readonly upscalePassExecuted: boolean | null;
  /** 内部渲染档位(scale<1 时出现;锁定档应为 2/3 精确值)。 */
  readonly resolutionScale: number | null;
  readonly resolutionScaleRevision: number | null;
}

interface ActiveLeg {
  readonly sequence: SequenceKind;
  readonly mode: LegMode;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly frames: UpscaleSequenceFrame[];
  frameCount: number;
}

let active: ActiveLeg | undefined;
/** truth 腿逐帧 HDR(按序列分桶,后续腿按帧索引对拍)。 */
const truthFrames = new Map<SequenceKind, Array<{ readonly width: number; readonly height: number; readonly rgb: Float32Array }>>();
const completed: Array<{ readonly sequence: SequenceKind; readonly mode: LegMode; readonly frames: readonly UpscaleSequenceFrame[] }> = [];

/**
 * 锁定 2/3 档:量化 1/768 使 2/3 恰为整数步(512 步);maxScale=SCALE+0.0005 量化后
 * 仍吸附 2/3(初始档 = quantize(maxScale) = 512/768 精确),down/upStep < quantize/2
 * 使升降候选量化后等于当前值(at-floor/at-ceiling 吸附),targetFrameMs=1 仅为判据
 * 占位 —— 档位锁定不依赖帧时反馈的具体数值。
 */
const lockedPolicy = {
  targetFrameMs: 1, hysteresisMs: 0.5, minScale: SCALE, maxScale: SCALE + 0.0005,
  downStep: 0.0005, upStep: 0.0005, upHoldFrames: 1, quantize: 1 / 768,
};

/** 四序列相机轨迹(0-7 帧运动、8-11 帧静止;static 全程静止)。 */
export function sequenceView(sequence: SequenceKind, frame: number) {
  const settled = frame >= MOVE_FRAMES;
  let eye: [number, number, number];
  if (sequence === "static") eye = [0, 1.1, 3.0];
  else if (sequence === "pan") eye = [settled ? 0.68 : (frame - 3.5) * 0.16, 1.1, 3.0];
  else if (sequence === "orbit") {
    const theta = settled ? 0.315 : (frame - 3.5) * 0.09;
    eye = [Math.sin(theta) * 3.2, 1.1, Math.cos(theta) * 3.2];
  } else {
    const dist = settled ? 2.46 : 3.0 - (frame - 3.5) * 0.12;
    eye = [0, 1.1 * (dist / 3), dist];
  }
  return {
    eye, target: [0, 0.2, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number],
    extent: 4, background: [0.08, 0.09, 0.11] as [number, number, number],
    floor: [0.05, 0.05, 0.06] as [number, number, number],
    exposure: 1, roughness: 0.4, width: WIDTH, height: HEIGHT, pixelRatio: 1,
  };
}

/**
 * 透明掩码腿场景:四序列同款对抗场景(不透明)+ 2 颗 BLEND 球(α=0.5)前景遮挡
 * → weighted OIT 反解 coverage → 渲染器供 encodeUpscale reactive 掩码(binding 8)。
 * 手搭 RenderPacket 模式同 spherePacket(逐实例材质 + 单位球缩放变换)。
 */
function transparencyScenePacket(): RenderPacket {
  const base = gridInstances();
  const count = base.length / 12;
  const blend = [
    { id: "blend-front", position: [0, 0.85, 1.7] as const, radius: 0.5, color: [0.25, 0.75, 0.95] as const },
    { id: "blend-side", position: [0.95, 0.55, 2.1] as const, radius: 0.38, color: [0.95, 0.35, 0.6] as const },
  ];
  return {
    geometries: [{ id: "deep-sphere", revision: 0, ...sphereMesh() }],
    materials: [
      ...Array.from({ length: count }, (_, i) => ({
        id: `opaque-${i}`, baseColor: [base[i * 12 + 4]!, base[i * 12 + 5]!, base[i * 12 + 6]!] as const,
        metallic: base[i * 12 + 7]!, roughness: base[i * 12 + 8]!,
      })),
      ...blend.map(entry => ({ id: entry.id, baseColor: entry.color, metallic: 0, roughness: 0.35,
        alphaMode: "BLEND" as const, baseColorAlpha: 0.5 })),
    ],
    instances: [
      ...Array.from({ length: count }, (_, i) => {
        const n = i * 12, r = base[n + 3]!;
        return { id: `i-${i}`, geometry: "deep-sphere", material: `opaque-${i}`,
          transform: [r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, base[n]!, base[n + 1]!, base[n + 2]!, 1] };
      }),
      ...blend.map((entry, i) => ({ id: entry.id, geometry: "deep-sphere", material: entry.id,
        transform: [entry.radius, 0, 0, 0, 0, entry.radius, 0, 0, 0, 0, entry.radius, 0,
          entry.position[0], entry.position[1], entry.position[2], 1] })),
    ],
  };
}

export function probeLegCount(): number { return completed.length; }

export async function beginSequenceLeg(sequence: SequenceKind, mode: LegMode): Promise<void> {
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
    frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  if (sequence === "transparency") renderer.setPacket(transparencyScenePacket());
  else renderer.setInstances(new Float32Array(gridInstances().buffer as ArrayBuffer));
  // 动态分辨率反馈回路只在诊断采样开启时收到 frame-encode 样本(pbrRenderer 453-463),
  // 否则 scale 恒 1、超分永不激活。此处开启仅为驱动产品自身回路;锁定档量化保证
  // scale 不随负载漂移;本探针不采集/不报告任何毫秒数(帧时禁令 2026-10-02)。
  renderer.setDiagnosticsSampling(true);
  await renderer.validateFrame(sequenceView(sequence, 0));
  active = { sequence, mode, canvas, renderer, frames: [], frameCount: 0 };
  if (mode === "truth") truthFrames.set(sequence, []);
}

/** 全帧 8×8 窗 SSIM(复用 ssrSsimRegion 口径:Rec.709 luma + 动态范围归一)。 */
function ssimToReference(reference: { readonly width: number; readonly height: number; readonly rgb: Float32Array },
  test: Float32Array): number {
  const width = reference.width, height = reference.height;
  const referenceLuma = ssrLuminance(reference.rgb, width * height);
  const testLuma = ssrLuminance(test, width * height);
  return ssrSsimRegion(referenceLuma, testLuma, width, { x0: 0, y0: 0, x1: width, y1: height }).mean;
}

function nonFiniteCount(values: Float32Array): number {
  let count = 0;
  for (let index = 0; index < values.length; index++) if (!Number.isFinite(values[index]!)) count += 1;
  return count;
}

export async function stepSequenceLeg(count: number): Promise<readonly UpscaleSequenceFrame[]> {
  if (!active) throw new Error("beginSequenceLeg was not called.");
  const step: UpscaleSequenceFrame[] = [];
  for (let index = 0; index < count; index++) {
    const metrics = active.renderer.render(sequenceView(active.sequence, active.frameCount));
    active.frameCount += 1;
    const results = await active.renderer.frameReadbackResults;
    const snapshot = (results ?? []).find(isPbrFrameReadbackSnapshot);
    let rgb = snapshot ? snapshotRgb(snapshot) : null;
    const nanCount = rgb ? nonFiniteCount(rgb) : 0;
    const reference = active.mode === "truth" ? undefined : truthFrames.get(active.sequence)![active.frames.length];
    let psnrToTruth: number | null = null, ssimToTruth: number | null = null, edgeEnergyRatio: number | null = null;
    if (rgb && reference) {
      const aligned = rgb.length === reference.rgb.length ? rgb
        : resampleBilinear(rgb, snapshot!.width, snapshot!.height, reference.width, reference.height);
      psnrToTruth = psnr(aligned, reference.rgb);
      ssimToTruth = ssimToReference(reference, aligned);
      edgeEnergyRatio = edgeEnergy(aligned, reference.width, reference.height)
        / Math.max(1e-9, edgeEnergy(reference.rgb, reference.width, reference.height));
    }
    if (rgb && active.mode === "truth") truthFrames.get(active.sequence)!.push({ width: snapshot!.width, height: snapshot!.height, rgb });
    const coverage = metrics?.frameExecutionCoverage;
    const record: UpscaleSequenceFrame = Object.freeze({
      frame: metrics?.frame ?? active.frameCount,
      psnrToTruth, ssimToTruth, edgeEnergyRatio, nanCount,
      temporalUpscale: metrics?.temporalUpscale ?? null,
      // coverage 合同:执行集 ⊆ 映射集;temporal-upscale 已映射,执行 ⇔ 不在未执行差集。
      upscalePassExecuted: coverage ? !coverage.notExecutedMappedPassIds.includes("temporal-upscale") : null,
      resolutionScale: metrics?.resolutionScale ? metrics.resolutionScale.scale : null,
      resolutionScaleRevision: metrics?.resolutionScale ? metrics.resolutionScale.revision : null,
    });
    active.frames.push(record);
    step.push(record);
  }
  return step;
}

export async function endSequenceLeg(): Promise<{ readonly sequence: SequenceKind; readonly mode: LegMode;
  readonly frames: readonly UpscaleSequenceFrame[] }> {
  if (!active) throw new Error("beginSequenceLeg was not called.");
  const leg = Object.freeze({ sequence: active.sequence, mode: active.mode, frames: Object.freeze(active.frames) });
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  completed.push(leg);
  return leg;
}
