import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { buildEvaluationLights, analyticSpotVisibility, summarizeShadowQuality,
  type EvaluationSpotLight, type ShadowQualityStats } from "../src/shadows/shadowPagingEvaluation.js";
import { LOCAL_SPOT_SHADOW_ENTRY_BYTES, LOCAL_SPOT_SHADOW_MAX_LIGHTS,
  LOCAL_SPOT_SHADOW_UNIFORM_BYTES } from "../src/shadows/localSpotShadowShader.js";
import type { LocalSpotShadowAtlasTier } from "../src/shadows/localSpotShadowAtlasQuality.js";
import { aggregateShadowStats } from "./shadowPagingQualityGpuScene.js";
import { CAMERA, HEIGHT, WIDTH, cameraBasis, cameraRay, patchRect } from "./shadowPagingQualityGpuScene.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import type { RenderPacket } from "../src/renderPacket.js";
import type { FrameMetrics, RenderView } from "../src/webgpu/pbrRendererTypes.js";

/**
 * F7b 产品渲染器图集档位真机探针(headless Chrome WebGPU,驱动形态同
 * contactShadowGpuProbe——这次被驱动的是产品 PbrRenderer 本体,不是 mini-renderer)。
 * F7 评估场景(16 灯 4×4 补丁、每补丁 3 根竖条遮挡器)重建为产品 RenderPacket,
 * 两腿仅差 PbrRendererOptions.localSpotShadowAtlasTier:
 *   standard    = 默认档(2×2 tile,4 灯有影,12 灯拒绝)
 *   multi-light = F7b 扩容后可达(4×4 tile,16 灯全覆盖,ABI 1536B)
 * 画质 = present-color 读回按每补丁 P95 归一,对照 CPU 解析硬影(RMSE/渗漏,
 * summarizeShadowQuality 与 F7 同一口径);性能 = cpuSubmitMs + gpuPassTimings。
 * 覆盖 = 渗漏 < 0.5 的补丁数(有影补丁的硬判据)。
 */

export interface AtlasTierLegAnalysis {
  readonly tier: LocalSpotShadowAtlasTier;
  readonly frames: number;
  readonly coveredLights: number;
  readonly shadowedKeys: readonly string[];
  readonly perLight: readonly { readonly key: string; readonly shadowed: boolean;
    readonly stats: ShadowQualityStats }[];
  readonly aggregate: ReturnType<typeof aggregateShadowStats>;
  readonly referenceShadowedSamples: number;
  readonly frameCpuMs: number;
  readonly totalGpuMs: number | null;
  readonly drawCalls: number;
  readonly frameTrace: readonly { readonly drawCalls: number; readonly lightCount: number;
    readonly shadowUpdated: boolean }[];
  readonly atlasBudget?: { readonly maxShadowedLights: number; readonly downgraded: boolean };
  readonly atlasDegraded: boolean;
  readonly atlasSignature?: string;
  readonly metadataEntries: number;
  readonly repeatFrameIdentical: boolean;
  readonly error?: string;
}

const PROBE_FEATURES = { environment: false, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, screenSpaceReflection: false, volumetricFog: false, temporalAa: false,
  spatialAa: false, visibilityBuffer: false, softRasterizeFallback: false, textureArrays: false,
  occlusionCulling: false, contactShadows: false, temporalUpscale: false, bloom: false,
  vignette: true } as const;
const LIGHT_INTENSITY = 30;
const WARM_FRAMES = 4, MEASURE_FRAMES = 8;

/** F7 评估场景 → 产品 RenderPacket(地面 + 48 根带法线竖条)。 */
export function evaluationPacket(lights: readonly EvaluationSpotLight[]): RenderPacket {
  const vertices: number[] = [], indices: number[] = [];
  const quad = (corners: readonly [number, number, number][], n: readonly [number, number, number]): void => {
    const base = vertices.length / 6;
    for (const point of corners) vertices.push(...point, ...n);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const half = 16;
  quad([[-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half]], [0, 1, 0]);
  let boxIndex = 0;
  for (const light of lights) {
    for (const occluder of light.occluders) {
      const [x0, y0, z0] = occluder.min, [x1, y1, z1] = occluder.max;
      for (const axis of [0, 1, 2]) {
        for (const sign of [0, 1]) {
          const normal: [number, number, number] = [0, 0, 0];
          normal[axis] = sign === 0 ? -1 : 1;
          const bounds: [number, number, number][] = [];
          const a = sign === 0 ? (axis === 1 ? y0 : axis === 0 ? x0 : z0) : axis === 1 ? y1 : axis === 0 ? x1 : z1;
          for (const u of [false, true]) for (const v of [false, true]) {
            const point: [number, number, number] = [0, 0, 0];
            point[axis] = a;
            const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3;
            point[uAxis] = u ? (uAxis === 0 ? x1 : uAxis === 1 ? y1 : z1) : (uAxis === 0 ? x0 : uAxis === 1 ? y0 : z0);
            point[vAxis] = v ? (vAxis === 0 ? x1 : vAxis === 1 ? y1 : z1) : (vAxis === 0 ? x0 : vAxis === 1 ? y0 : z0);
            bounds.push(point);
          }
          const flip = (axis === 0) === (sign === 1);
          quad(flip ? [bounds[0]!, bounds[2]!, bounds[3]!, bounds[1]!] : [bounds[0]!, bounds[1]!, bounds[3]!, bounds[2]!], normal);
        }
      }
      boxIndex += 1;
    }
  }
  return {
    geometries: [{ id: "atlas-tier-scene", revision: 0, vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices) }],
    materials: [{ id: "white", baseColor: [0.85, 0.85, 0.85], metallic: 0, roughness: 1 }],
    instances: [{ id: `scene-${boxIndex}`, geometry: "atlas-tier-scene", material: "white",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
}

function probeView(lights: readonly EvaluationSpotLight[]): RenderView {
  return { eye: CAMERA.eye, target: CAMERA.target, extent: 40, background: [0, 0, 0], floor: [0, 0, 0],
    exposure: 1, roughness: 1, verticalFovRadians: CAMERA.verticalFovRadians,
    width: WIDTH, height: HEIGHT, pixelRatio: 1,
    lights: { directional: [], spots: lights.map(light => ({
      positionWorld: light.position, directionWorld: light.direction, range: light.range,
      color: [1, 1, 1] as const, intensity: LIGHT_INTENSITY,
      innerConeCos: Math.cos(light.outerHalfAngleRadians * 0.92),
      outerConeCos: Math.cos(light.outerHalfAngleRadians),
      shadow: { key: light.key, importance: light.importance } })) } };
}

interface ActiveLeg {
  readonly tier: LocalSpotShadowAtlasTier;
  readonly lights: readonly EvaluationSpotLight[];
  readonly patchPixels: readonly (readonly [number, number, number, number])[];
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly frameCpuMs: number[];
  readonly totalGpuMs: Array<number | null>;
  readonly drawCalls: number[];
  readonly frameTrace: { drawCalls: number; lightCount: number; shadowUpdated: boolean }[];
  luma?: Float32Array;
  previousLuma?: Float32Array;
  frames: number;
}

let active: ActiveLeg | undefined;
const completed: AtlasTierLegAnalysis[] = [];

export function probeLegCount(): number { return completed.length; }

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture };
}

/** ABI 预算门:F7b 常量必须在 bundle 内即为本 slice 的钉住值。 */
export function probeAbiBudget(): { readonly maxLights: number; readonly entryBytes: number;
  readonly uniformBytes: number; readonly withinUniformBudget: boolean } {
  return { maxLights: LOCAL_SPOT_SHADOW_MAX_LIGHTS, entryBytes: LOCAL_SPOT_SHADOW_ENTRY_BYTES,
    uniformBytes: LOCAL_SPOT_SHADOW_UNIFORM_BYTES,
    withinUniformBudget: LOCAL_SPOT_SHADOW_UNIFORM_BYTES <= 65_536 };
}

export async function beginLeg(tier: LocalSpotShadowAtlasTier): Promise<void> {
  if (active) throw new Error("Previous leg was not ended.");
  const lights = buildEvaluationLights(16).lights;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "studio" },
    features: PROBE_FEATURES,
    localSpotShadowAtlasTier: tier,
    gpuPassTiming: true,
    frameCapture: { session: new (await import("../src/r12/frameCapture.js")).FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  renderer.setPacket(evaluationPacket(lights));
  await renderer.validateFrame(probeView(lights));
  const viewProjection = multiply(perspective(CAMERA.verticalFovRadians, WIDTH / HEIGHT, 0.5, 300),
    lookAt(CAMERA.eye, CAMERA.target));
  active = { tier, lights, patchPixels: lights.map(light => patchRect(light, viewProjection)),
    canvas, renderer, frameCpuMs: [], totalGpuMs: [], drawCalls: [], frameTrace: [], frames: 0 };
}

export async function stepLeg(count: number): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const metrics: FrameMetrics | undefined = active.renderer.render(probeView(active.lights));
    active.frames += 1;
    frames.push(metrics?.frame ?? active.frames);
    if (metrics) {
      active.frameCpuMs.push(metrics.cpuSubmitMs);
      active.drawCalls.push(metrics.drawCalls);
      active.frameTrace.push({ drawCalls: metrics.drawCalls, lightCount: metrics.lightCount,
        shadowUpdated: metrics.shadowUpdated });
      active.totalGpuMs.push(metrics.gpuPassTimings?.milliseconds ?? null);
    }
    const results = await active.renderer.frameReadbackResults;
    const snapshots = (results ?? []).filter(isPbrFrameReadbackSnapshot);
    const color = snapshots.find(result => result.resourceId === "present-color");
    if (color && index >= count - 2) {
      const words = new Uint16Array(color.bytes.buffer, color.bytes.byteOffset, color.bytes.byteLength / 2);
      const stride = color.bytesPerRow / 2;
      const luma = new Float32Array(WIDTH * HEIGHT);
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          const offset = y * stride + x * 4;
          luma[y * WIDTH + x] = 0.2126 * decodeHalfFloat(words[offset]!)
            + 0.7152 * decodeHalfFloat(words[offset + 1]!) + 0.0722 * decodeHalfFloat(words[offset + 2]!);
        }
      }
      if (index === count - 2) active.previousLuma = luma;
      else active.luma = luma;
      lastReadback = summarizeReadbackLuma(luma);
    }
  }
  return frames;
}

export function summarizeReadbackLuma(luma: Float32Array): { readonly min: number; readonly max: number;
  readonly mean: number } {
  if (luma.length === 0) throw new Error("Cannot summarize an empty present-color readback.");
  let min = Infinity, max = -Infinity, total = 0;
  for (const value of luma) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    total += value;
  }
  return { min, max, mean: total / luma.length };
}

let lastReadback: { readonly min: number; readonly max: number; readonly mean: number } | undefined;

/** 诊断:最近一次 present-color 读回的亮度分布(定位黑帧用)。 */
export function probeLastReadback(): { readonly min: number; readonly max: number;
  readonly mean: number } | undefined { return lastReadback; }

/** 合成器呈现后返回;截图前必须先走到这里(双 rAF)。 */
export async function flushPresent(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export async function endLeg(): Promise<AtlasTierLegAnalysis> {
  if (!active) throw new Error("beginLeg was not called.");
  const leg = active;
  if (!leg.luma || !leg.previousLuma) throw new Error("Leg captured no readback frames.");
  const basis = cameraBasis();
  const perLight: Array<AtlasTierLegAnalysis["perLight"][number]> = [];
  const aggregateRows: { measured: number[]; reference: number[]; mask: number[] }[] = [];
  let referenceShadowedSamples = 0;
  leg.lights.forEach((light, lightIndex) => {
    const [rx, ry, rw, rh] = leg.patchPixels[lightIndex]!;
    const size = rw * rh;
    const raw = new Float32Array(size), reference = new Float32Array(size), mask = new Uint8Array(size);
    const measured = new Float32Array(size);
    let insidePixels = 0;
    for (let y = 0; y < rh; y += 1) {
      for (let x = 0; x < rw; x += 1) {
        const ndcX = 2 * (rx + x + 0.5) / WIDTH - 1, ndcY = 1 - 2 * (ry + y + 0.5) / HEIGHT;
        const ray = cameraRay(basis, ndcX, ndcY);
        if (Math.abs(ray[1]) < 1e-6) continue;
        const t = -CAMERA.eye[1] / ray[1];
        if (t <= 0) continue;
        const point: [number, number, number] = [CAMERA.eye[0] + ray[0] * t, 0, CAMERA.eye[2] + ray[2] * t];
        const index = y * rw + x;
        raw[index] = leg.luma![(ry + y) * WIDTH + rx + x]!;
        reference[index] = analyticSpotVisibility(point, light) ? 0 : 1;
        mask[index] = Math.abs(point[0] - light.patchCenter[0]) <= light.patchHalfExtent
          && Math.abs(point[2] - light.patchCenter[1]) <= light.patchHalfExtent ? 1 : 0;
        if (mask[index] === 1) insidePixels += 1;
      }
    }
    if (insidePixels === 0) throw new Error(`Patch ${light.key} has no floor samples.`);
    // 每补丁按 P95(lit 水平)归一:tonemap 后的绝对亮度不参与判据,相对明暗参与。
    const sorted = [...raw].filter((_, index) => mask[index] === 1).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! || 1;
    for (let index = 0; index < size; index += 1) measured[index] = Math.min(1, raw[index]! / p95);
    const stats = summarizeShadowQuality(measured, reference, mask, rw);
    referenceShadowedSamples += stats.shadowedSamples;
    for (let y = 0; y < rh; y += 1) {
      aggregateRows.push({ measured: [...measured.subarray(y * rw, (y + 1) * rw)],
        reference: [...reference.subarray(y * rw, (y + 1) * rw)],
        mask: [...mask.subarray(y * rw, (y + 1) * rw)] });
    }
    perLight.push({ key: light.key, shadowed: stats.leakFraction < 0.5, stats });
  });
  const mean = (values: Array<number | null>): number | null => {
    const usable = values.filter((value): value is number => value !== null);
    return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : null;
  };
  const gpuMs = mean(leg.totalGpuMs);
  const repeatFrameIdentical = leg.luma!.length === leg.previousLuma!.length
    && leg.luma!.every((value, index) => value === leg.previousLuma![index]);
  const atlasRuntime = (leg.renderer as unknown as { localShadows: {
    degraded: boolean; budget?: { maxShadowedLights: number; downgraded: boolean };
    lastSignature?: string; committedMetadata: Float32Array } }).localShadows;
  let metadataEntries = 0;
  for (let index = 0; index < LOCAL_SPOT_SHADOW_MAX_LIGHTS; index += 1) {
    if (atlasRuntime.committedMetadata[index * LOCAL_SPOT_SHADOW_ENTRY_BYTES / 4 + 23] !== 0) metadataEntries += 1;
  }
  const analysis: AtlasTierLegAnalysis = Object.freeze({
    tier: leg.tier, frames: leg.frames, atlasDegraded: atlasRuntime.degraded,
    atlasSignature: atlasRuntime.lastSignature, metadataEntries,
    ...(atlasRuntime.budget ? { atlasBudget: { maxShadowedLights: atlasRuntime.budget.maxShadowedLights,
      downgraded: atlasRuntime.budget.downgraded } } : {}),
    coveredLights: perLight.filter(entry => entry.shadowed).length,
    shadowedKeys: perLight.filter(entry => entry.shadowed).map(entry => entry.key),
    perLight, aggregate: aggregateShadowStats(aggregateRows),
    referenceShadowedSamples,
    frameCpuMs: mean(leg.frameCpuMs) ?? 0,
    totalGpuMs: gpuMs === null ? null : Number(gpuMs.toFixed(3)),
    drawCalls: Math.round(mean(leg.drawCalls) ?? 0), frameTrace: leg.frameTrace,
    repeatFrameIdentical,
  });
  leg.renderer.dispose();
  leg.canvas.remove();
  active = undefined;
  completed.push(analysis);
  return analysis;
}

export const ATLAS_TIER_PROBE_CONSTANTS = Object.freeze({ WIDTH, HEIGHT, WARM_FRAMES, MEASURE_FRAMES, LIGHT_INTENSITY });
