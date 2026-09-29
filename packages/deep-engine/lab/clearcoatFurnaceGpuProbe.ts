import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { analyzeFurnaceFrame, decodeFurnaceColor, evaluateFurnaceChecks, furnaceSphereSegmentation,
  uniformFurnaceEquirect, WHITE_FURNACE_ENVIRONMENT_RADIANCE, type FurnaceCheck } from "../src/webgpu/whiteFurnace.js";
import { lookAt, perspective, multiply } from "../src/webgpu/cameraMath.js";
import { evaluateExtendedMaterialDirect, type StandardSurfaceInputs } from "../src/shader/materialEvaluate.js";
import type { FrameMetrics } from "../src/webgpu/pbrRendererTypes.js";
import type { RenderPacket } from "../src/renderPacket.js";

/**
 * C9 Clearcoat 清漆层真机探针(headless Chrome WebGPU,分步驱动形态同 whiteFurnaceGpuProbe)。
 * 材质管线 sphere(1×1 白底色纹理 + extendedParameters)走权威 extendedShade 路径。五路证据:
 *  1) 转移恒等式(太阳白炉): coat(1,0.3)−coat(0.35,0.3) 逐像素对照 CPU 参考
 *     ext(1,0.3)−ext(0.35,0.3)——两腿同在扩展分支,stock 项精确相消;清漆增量 = 清漆瓣增量
 *     − 按 f·F_c(vh) 转移出的基础能量,无中生有上界 = (f1−f2)·清漆瓣;
 *  2) 缺省零行为(禁灯): 全默认 vs 全默认+清漆逐像素位级对照(运行时清漆只改直射项);
 *  3) 材质管线白炉回归: 禁灯默认腿过 C12 守恒断言(≡E),extendedShade 路径首次纳入门禁;
 *  4) 双瓣视觉: 深红底漆+锐清漆 off/on 剖面 FWHM(窄清漆瓣叠在宽底漆瓣上);
 *  5) 帧时: 全帧 GPU 毫秒 off/on 对照(F1 全帧口径)。
 */

export type ClearcoatLegKind = "sun-coat-on" | "sun-coat-weak" | "sun-coat-off" | "dark-coat-off" | "dark-coat-on" | "visual-coat-off" | "visual-coat-on";

export interface LegSummary {
  readonly kind: ClearcoatLegKind;
  readonly frames: number;
  readonly totalGpuMs: number | null;
  readonly cpuSubmitMs: number | null;
}

export interface TransferStats {
  readonly compared: number;
  /** 相对误差实际参与求值的样本数(|expected| ≥ REL_EVAL_FLOOR 的信号区像素)。 */
  readonly relEvaluated: number;
  readonly p50Abs: number; readonly p95Abs: number; readonly maxAbs: number;
  readonly p95Rel: number; readonly maxRel: number;
  readonly freeEnergyMax: number;
  readonly positive: number; readonly negative: number;
}

export interface DarkPairStats {
  readonly compared: number;
  readonly maxAbsDelta: number;
  readonly furnaceChecks: readonly FurnaceCheck[];
}

export interface VisualStats {
  readonly peakRatio: number;
  readonly baseFwhmPx: number;
  readonly coatFwhmPx: number;
  readonly coatDeltaPeak: number;
}

const WIDTH = 192, HEIGHT = 192, SPHERE_RADIUS = 1.7, EYE_DISTANCE = 5;
const VERTICAL_FOV = Math.PI / 4, WARM_FRAMES = 6, MEASURE_FRAMES = 8;
const SUN_DIRECTION = [-0.35, -0.45, -1] as const;
/** 相对误差求值的信号下限:低于此 |expected| 的像素(清漆贡献→0 的晨昏线环带)其 rel
 * 被法线插值的均匀绝对噪声支配;0.01 ≈ 25× 实测 p95Abs(4.17e-4)且 ≥ 峰值信号 10%。 */
const REL_EVAL_FLOOR = 0.01;
const BASE_SURFACE: StandardSurfaceInputs = { baseColor: [1, 1, 1], metallic: 0, roughness: 0.35 };
const PAINT_SURFACE: StandardSurfaceInputs = { baseColor: [0.55, 0.02, 0.02], metallic: 0, roughness: 0.6 };
const LIGHT_TO_SURFACE = normalize([-SUN_DIRECTION[0]!, -SUN_DIRECTION[1]!, -SUN_DIRECTION[2]!]);
const MAIN_COAT = { factor: 1, roughness: 0.3 }, WEAK_COAT = { factor: 0.35, roughness: 0.3 };
const VISUAL_COAT = { factor: 1, roughness: 0.15 };

const FEATURES = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: true } as const;
const SUN_LIGHTS = { lights: { directional: [{ directionWorld: SUN_DIRECTION, color: [1, 1, 1] as const,
  intensity: 1, castShadow: false }] } } as const;
const LIGHTS_OFF = { lights: { directional: [] as never[] } } as const;
const VIEW = { eye: [0, 0, EYE_DISTANCE] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0.02, 0.02, 0.02] as const, floor: [0.05, 0.05, 0.05] as const, exposure: 1.05,
  roughness: 0.5, verticalFovRadians: VERTICAL_FOV, panoramaBackground: { toneMapped: true },
  width: WIDTH, height: HEIGHT, pixelRatio: 1 };

function normalize(value: readonly number[]): readonly [number, number, number] {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!);
  return [value[0]! / length, value[1]! / length, value[2]! / length];
}
const dot3 = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const luma = (rgb: readonly number[]): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

/** 有纹理材质才能进 material 管线(extendedShade 载体);1×1 白底色保持 base 逐位中性。 */
/** 带等距柱状 UV0 的球体(primitives.sphereMesh 不含 UV0,而有纹理材质要求几何携带 UV0);
 * 顶点/索引数学与 primitives.sphereMesh 逐字一致,仅追加 uv0 数组。 */
function sphereMeshWithUv0(segments = 40, rings = 24): { vertices: Float32Array; indices: Uint32Array; uv0: Float32Array } {
  if (!Number.isInteger(segments) || !Number.isInteger(rings) || segments < 3 || rings < 2 || segments > 256 || rings > 256) {
    throw new Error("Sphere subdivisions are outside the supported range.");
  }
  const vertices: number[] = [], indices: number[] = [], uv0: number[] = [];
  for (let y = 0; y <= rings; y++) for (let x = 0; x <= segments; x++) {
    const theta = y / rings * Math.PI, phi = x / segments * Math.PI * 2;
    const nx = Math.sin(theta) * Math.cos(phi), ny = Math.cos(theta), nz = Math.sin(theta) * Math.sin(phi);
    vertices.push(nx, ny, nz, nx, ny, nz);
    uv0.push(x / segments, y / rings);
  }
  for (let y = 0; y < rings; y++) for (let x = 0; x < segments; x++) {
    const a = y * (segments + 1) + x, b = a + segments + 1;
    if (y > 0) indices.push(a, a + 1, b);
    if (y < rings - 1) indices.push(a + 1, b + 1, b);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), uv0: new Float32Array(uv0) };
}

function coatPacket(surface: StandardSurfaceInputs,
  coat: { readonly factor: number; readonly roughness: number } | undefined): RenderPacket {
  const mesh = sphereMeshWithUv0(96, 64);
  return {
    geometries: [{ id: "coat-sphere", revision: 0, vertices: mesh.vertices, indices: mesh.indices, uv0: mesh.uv0 }],
    materials: [{ id: "coat", baseColor: surface.baseColor, metallic: surface.metallic, roughness: surface.roughness,
      baseColorTexture: { texture: "coat-white" },
      ...(coat ? { extendedParameters: { ior: 1.5, clearcoat: coat,
        anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } } } : {}) }],
    instances: [{ id: "sphere", geometry: "coat-sphere", material: "coat",
      transform: [SPHERE_RADIUS, 0, 0, 0, 0, SPHERE_RADIUS, 0, 0, 0, 0, SPHERE_RADIUS, 0, 0, 0, 0, 1] }],
    textures: [{ id: "coat-white", revision: 0, semantic: "baseColor", width: 1, height: 1,
      data: new Uint8Array([255, 255, 255, 255]) }],
  };
}

interface ActiveLeg {
  readonly kind: ClearcoatLegKind;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly totalGpuMs: Array<number | null>;
  readonly cpuSubmitMs: number[];
  pixels?: Float32Array;
  frameCount: number;
}

let active: ActiveLeg | undefined;
const legFrames = new Map<ClearcoatLegKind, Float32Array>();
const legSummaries: LegSummary[] = [];

export async function beginLeg(kind: ClearcoatLegKind): Promise<void> {
  if (active) throw new Error("Previous leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const visual = kind.startsWith("visual");
  const coated = kind.endsWith("on");
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr",
      image: uniformFurnaceEquirect(visual ? 0.02 : WHITE_FURNACE_ENVIRONMENT_RADIANCE) },
    features: { ...FEATURES }, gpuPassTiming: true,
    frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  const coat = coated ? (visual ? VISUAL_COAT : MAIN_COAT)
    : kind === "sun-coat-weak" ? WEAK_COAT : undefined;
  renderer.setPacket(coatPacket(visual ? PAINT_SURFACE : BASE_SURFACE, coat));
  await renderer.validateFrame({ ...VIEW, ...(visual || kind.startsWith("sun") ? SUN_LIGHTS : LIGHTS_OFF) });
  active = { kind, canvas, renderer, totalGpuMs: [], cpuSubmitMs: [], frameCount: 0 };
}

export async function stepLeg(count: number): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const view = { ...VIEW, ...(active.kind.startsWith("visual") || active.kind.startsWith("sun") ? SUN_LIGHTS : LIGHTS_OFF) };
  const frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const metrics: FrameMetrics | undefined = active.renderer.render(view);
    active.frameCount += 1;
    frames.push(metrics?.frame ?? active.frameCount);
    if (metrics) {
      active.cpuSubmitMs.push(metrics.cpuSubmitMs);
      active.totalGpuMs.push(metrics.gpuPassTimings?.milliseconds ?? null);
    }
    const results = await active.renderer.frameReadbackResults;
    const snapshot = (results ?? []).find(isPbrFrameReadbackSnapshot);
    if (!snapshot) throw new Error(`Clearcoat color readback unavailable on frame ${active.frameCount}.`);
    active.pixels = decodeFurnaceColor(snapshot);
  }
  return frames;
}

/** 合成器呈现后返回;截图前必须先走到这里(双 rAF,同 contactShadow 探针)。 */
export async function flushPresent(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export async function endLeg(): Promise<LegSummary> {
  if (!active) throw new Error("beginLeg was not called.");
  if (!active.pixels) throw new Error("Leg captured no pixels.");
  legFrames.set(active.kind, active.pixels);
  const mean = (values: readonly (number | null)[]): number | null => {
    const usable = values.filter((value): value is number => value !== null);
    return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : null;
  };
  const summary: LegSummary = Object.freeze({ kind: active.kind, frames: active.frameCount,
    totalGpuMs: mean(active.totalGpuMs), cpuSubmitMs: mean(active.cpuSubmitMs) });
  active.renderer.dispose(); active.canvas.remove(); active = undefined;
  legSummaries.push(summary);
  return summary;
}

const pixelLuma = (pixels: Float32Array, index: number): number =>
  luma([pixels[index * 3]!, pixels[index * 3 + 1]!, pixels[index * 3 + 2]!]);

interface SphereSample { readonly index: number; readonly normal: readonly [number, number, number];
  readonly view: readonly [number, number, number] }

/** 受光球面像素采样(轮廓环带外 + n·l≥0.02);一次构建缓存,与 whiteFurnace 分割同视几何。 */
function litSphereSamples(): readonly SphereSample[] {
  const inverse = invert4(multiply(perspective(VERTICAL_FOV, WIDTH / HEIGHT, 0.1, 200), lookAt(VIEW.eye, VIEW.target)));
  const segmentation = furnaceSphereSegmentation(WIDTH, HEIGHT, EYE_DISTANCE, SPHERE_RADIUS, VERTICAL_FOV);
  const samples: SphereSample[] = [];
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    if (segmentation[y * WIDTH + x] !== 0) continue;
    const world = unproject(inverse, 2 * (x + 0.5) / WIDTH - 1, 1 - 2 * (y + 0.5) / HEIGHT, 0.5);
    const ray = normalize([world[0] - VIEW.eye[0], world[1] - VIEW.eye[1], world[2] - VIEW.eye[2]]);
    const b = dot3(ray, VIEW.eye);
    const discriminant = b * b - (dot3(VIEW.eye, VIEW.eye) - SPHERE_RADIUS * SPHERE_RADIUS);
    if (discriminant <= 0) continue;
    const hit = -b - Math.sqrt(discriminant);
    if (hit <= 0) continue;
    const point = [VIEW.eye[0]! + ray[0]! * hit, VIEW.eye[1]! + ray[1]! * hit, VIEW.eye[2]! + ray[2]! * hit];
    const normal = [point[0]! / SPHERE_RADIUS, point[1]! / SPHERE_RADIUS, point[2]! / SPHERE_RADIUS] as const;
    if (dot3(normal, LIGHT_TO_SURFACE) < 0.02) continue;
    samples.push({ index: y * WIDTH + x, normal,
      view: normalize([VIEW.eye[0]! - point[0]!, VIEW.eye[1]! - point[1]!, VIEW.eye[2]! - point[2]!]) });
  }
  return samples;
}

function invert4(m: Float32Array): Float32Array {
  const s0 = m[0]! * m[5]! - m[1]! * m[4]!, s1 = m[0]! * m[6]! - m[2]! * m[4]!;
  const s2 = m[0]! * m[7]! - m[3]! * m[4]!, s3 = m[1]! * m[6]! - m[2]! * m[5]!;
  const s4 = m[1]! * m[7]! - m[3]! * m[5]!, s5 = m[2]! * m[7]! - m[3]! * m[6]!;
  const c5 = m[10]! * m[15]! - m[11]! * m[14]!, c4 = m[9]! * m[15]! - m[11]! * m[13]!;
  const c3 = m[9]! * m[14]! - m[10]! * m[13]!, c2 = m[8]! * m[15]! - m[11]! * m[12]!;
  const c1 = m[8]! * m[14]! - m[10]! * m[12]!, c0 = m[8]! * m[13]! - m[9]! * m[12]!;
  const determinant = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (Math.abs(determinant) < 1e-12) throw new Error("Singular view-projection matrix.");
  const scale = 1 / determinant, inverse = new Float32Array(16);
  inverse[0] = (m[5]! * c5 - m[6]! * c4 + m[7]! * c3) * scale;
  inverse[1] = (m[2]! * c4 - m[1]! * c5 - m[3]! * c3) * scale;
  inverse[2] = (m[13]! * s5 - m[14]! * s4 + m[15]! * s3) * scale;
  inverse[3] = (m[10]! * s4 - m[9]! * s5 - m[11]! * s3) * scale;
  inverse[4] = (m[6]! * c2 - m[4]! * c5 - m[7]! * c1) * scale;
  inverse[5] = (m[0]! * c5 - m[2]! * c2 + m[3]! * c1) * scale;
  inverse[6] = (m[14]! * s2 - m[12]! * s5 - m[15]! * s1) * scale;
  inverse[7] = (m[8]! * s5 - m[10]! * s2 + m[11]! * s1) * scale;
  inverse[8] = (m[4]! * c4 - m[5]! * c2 + m[7]! * c0) * scale;
  inverse[9] = (m[1]! * c2 - m[0]! * c4 - m[3]! * c0) * scale;
  inverse[10] = (m[12]! * s4 - m[13]! * s2 + m[15]! * s0) * scale;
  inverse[11] = (m[9]! * s2 - m[8]! * s4 - m[11]! * s0) * scale;
  inverse[12] = (m[5]! * c1 - m[4]! * c3 - m[6]! * c0) * scale;
  inverse[13] = (m[0]! * c3 - m[1]! * c1 + m[2]! * c0) * scale;
  inverse[14] = (m[13]! * s1 - m[12]! * s3 - m[14]! * s0) * scale;
  inverse[15] = (m[8]! * s3 - m[9]! * s1 + m[10]! * s0) * scale;
  return inverse;
}

function unproject(inverse: Float32Array, ndcX: number, ndcY: number, ndcZ: number): readonly [number, number, number] {
  const x = inverse[0]! * ndcX + inverse[4]! * ndcY + inverse[8]! * ndcZ + inverse[12]!;
  const y = inverse[1]! * ndcX + inverse[5]! * ndcY + inverse[9]! * ndcZ + inverse[13]!;
  const z = inverse[2]! * ndcX + inverse[6]! * ndcY + inverse[10]! * ndcZ + inverse[14]!;
  const w = inverse[3]! * ndcX + inverse[7]! * ndcY + inverse[11]! * ndcZ + inverse[15]!;
  return [x / w, y / w, z / w];
}

/** 断言 1:转移恒等式。main/reference 必须同在扩展分支(f>0),stock 项在差分中精确相消。 */
export function analyzeTransfer(main: ClearcoatLegKind, reference: ClearcoatLegKind): TransferStats {
  const on = legFrames.get(main), weak = legFrames.get(reference);
  if (!on || !weak) throw new Error("Transfer legs were not measured.");
  const increment = MAIN_COAT.factor - WEAK_COAT.factor;
  const absErrors: number[] = [], relErrors: number[] = [];
  let freeEnergyMax = -Infinity, positive = 0, negative = 0;
  for (const sample of litSphereSamples()) {
    const geometry = { ...sample, light: LIGHT_TO_SURFACE, tangent: [1, 0, 0] as const };
    const mainEval = evaluateExtendedMaterialDirect(BASE_SURFACE, { clearcoat: MAIN_COAT }, geometry, [1, 1, 1]);
    const weakEval = evaluateExtendedMaterialDirect(BASE_SURFACE, { clearcoat: WEAK_COAT }, geometry, [1, 1, 1]);
    const expected = luma(mainEval.rgb) - luma(weakEval.rgb);
    const measured = pixelLuma(on, sample.index) - pixelLuma(weak, sample.index);
    const bound = increment * luma(mainEval.components.clearcoat);
    const absolute = Math.abs(measured - expected);
    absErrors.push(absolute);
    // 相对误差只在转移信号区求值:|expected| 低于 REL_EVAL_FLOOR 的像素(晨昏线/掠射环带,
    // 清漆贡献→0)其 rel 被法线插值的均匀绝对噪声(~p95Abs 量级)支配,数值上无意义;
    // 阈值 0.01 ≈ 25× 实测 p95Abs(4.17e-4),且 ≥ 峰值信号的 10%。绝对误差仍全样本覆盖。
    if (Math.abs(expected) >= REL_EVAL_FLOOR) {
      relErrors.push(absolute / Math.abs(expected));
    }
    freeEnergyMax = Math.max(freeEnergyMax, measured - bound);
    if (measured > 2e-4) positive += 1;
    if (measured < -2e-4) negative += 1;
  }
  const percentile = (values: readonly number[], fraction: number): number =>
    [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
  return { compared: absErrors.length, relEvaluated: relErrors.length,
    p50Abs: percentile(absErrors, 0.5), p95Abs: percentile(absErrors, 0.95),
    maxAbs: percentile(absErrors, 1), p95Rel: percentile(relErrors, 0.95), maxRel: percentile(relErrors, 1),
    freeEnergyMax, positive, negative };
}

/** 断言 2/3:禁灯位级对照 + 材质管线白炉守恒(off 腿过 C12 断言)。 */
export function analyzeDarkPair(off: ClearcoatLegKind, on: ClearcoatLegKind): DarkPairStats {
  const offPixels = legFrames.get(off), onPixels = legFrames.get(on);
  if (!offPixels || !onPixels) throw new Error("Dark legs were not measured.");
  let maxAbsDelta = 0;
  for (let index = 0; index < offPixels.length; index++) {
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(offPixels[index]! - onPixels[index]!));
  }
  const furnace = analyzeFurnaceFrame(offPixels, WHITE_FURNACE_ENVIRONMENT_RADIANCE,
    furnaceSphereSegmentation(WIDTH, HEIGHT, EYE_DISTANCE, SPHERE_RADIUS, VERTICAL_FOV), "geometry");
  return { compared: offPixels.length / 3, maxAbsDelta, furnaceChecks: evaluateFurnaceChecks(furnace) };
}

/** 断言 4:双瓣视觉——清漆增量瓣宽 < 底漆高光瓣宽,峰值增强。 */
export function analyzeVisual(off: ClearcoatLegKind, on: ClearcoatLegKind): VisualStats {
  const offPixels = legFrames.get(off), onPixels = legFrames.get(on);
  if (!offPixels || !onPixels) throw new Error("Visual legs were not measured.");
  const segmentation = furnaceSphereSegmentation(WIDTH, HEIGHT, EYE_DISTANCE, SPHERE_RADIUS, VERTICAL_FOV);
  let peakIndex = -1, peakOn = -Infinity, peakOff = 0;
  for (let index = 0; index < WIDTH * HEIGHT; index++) {
    if (segmentation[index] !== 0) continue;
    const lumaOn = pixelLuma(onPixels, index);
    peakOff = Math.max(peakOff, pixelLuma(offPixels, index));
    if (lumaOn > peakOn) { peakOn = lumaOn; peakIndex = index; }
  }
  if (peakIndex < 0) throw new Error("Visual disc is empty.");
  const row = Math.floor(peakIndex / WIDTH), center = peakIndex % WIDTH;
  const offProfile = Array.from({ length: WIDTH }, (_, x) => pixelLuma(offPixels, row * WIDTH + x));
  const deltaProfile = Array.from({ length: WIDTH }, (_, x) => pixelLuma(onPixels, row * WIDTH + x) - offProfile[x]!);
  const fwhm = (values: readonly number[], peak: number): number => {
    const half = peak / 2;
    let left = center, right = center;
    while (left > 0 && values[left]! >= half) left -= 1;
    while (right < WIDTH - 1 && values[right]! >= half) right += 1;
    return right - left;
  };
  const deltaPeak = Math.max(...deltaProfile);
  return { peakRatio: peakOn / Math.max(peakOff, 1e-6), baseFwhmPx: fwhm(offProfile, peakOff),
    coatFwhmPx: fwhm(deltaProfile, deltaPeak), coatDeltaPeak: deltaPeak };
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture };
}

export const CLEARCOAT_PROBE_CONSTANTS = Object.freeze({ WIDTH, HEIGHT, WARM_FRAMES, MEASURE_FRAMES, SPHERE_RADIUS });
