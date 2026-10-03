import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeFurnaceColor, furnaceSphereSegmentation, uniformFurnaceEquirect } from "../src/webgpu/whiteFurnace.js";
import type { FrameMetrics } from "../src/webgpu/pbrRendererTypes.js";
import type { RenderPacket } from "../src/renderPacket.js";
import type { AdvancedMaterialParameters } from "../src/shader/materialAdvancedParameters.js";
import { ADVANCED_MATERIAL_MATH_WGSL } from "../src/shader/materialAdvancedWgsl.js";
import { dCharlie, evalIridescence, fSchlick, iblSheenBrdf, schlickToF0, sheenDirectBrdf, sheenDirectEnergy,
  sheenIndirectEnergy, vNeubelt, volumeAttenuation } from "../src/shader/materialAdvancedReference.js";

/**
 * advancedMaterials 真机探针(headless Chrome WebGPU)。三类证据:
 *  1) math:   WGSL 数学函数(薄膜干涉/Charlie/Neubelt/IBL sheen/Beer)compute 对拍 CPU 参考(three r185 逐式移植);
 *  2) furnace: 球体白炉(均匀环境、禁灯)——stock 位级一致、sheen/iridescence 守恒、clearcoat/透射能量上界;
 *  3) direct:  平面解析对拍(单太阳光、近零环境)——sheen / iridescence / clearcoat 直射项逐像素对照 CPU 预测。
 */

const WIDTH = 192, HEIGHT = 192, SPHERE_RADIUS = 1.7, EYE_DISTANCE = 5, VERTICAL_FOV = Math.PI / 4;
const WARM_FRAMES = 4, FURNACE_RADIANCE = 0.5, DARK_RADIANCE = 0.001;
const TO_LIGHT = norm([0.3, 0.3, 1]);
const FEATURES = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: false, contactShadows: false } as const;
const sunFor = (toLight: Vec3) => ({ lights: { directional: [{ directionWorld: [-toLight[0], -toLight[1], -toLight[2]] as const,
  color: [1, 1, 1] as const, intensity: 1, castShadow: false }] } }) as const;
const SUN = sunFor(TO_LIGHT);
const OFF = { lights: { directional: [] as never[] } } as const;
const VIEW = { eye: [0, 0, EYE_DISTANCE] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0.02, 0.02, 0.02] as const, floor: [0.05, 0.05, 0.05] as const, exposure: 1.05,
  roughness: 0.5, verticalFovRadians: VERTICAL_FOV, panoramaBackground: { toneMapped: true },
  width: WIDTH, height: HEIGHT, pixelRatio: 1 };

type Vec3 = readonly [number, number, number];
function norm(v: readonly number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sat = (v: number): number => Math.min(Math.max(v, 0), 1);

export interface LegSpec {
  readonly id: string;
  readonly advancedRenderer: boolean;
  readonly shape: "sphere" | "plane";
  readonly tiltDeg?: number;
  readonly env: number;
  readonly sun: boolean;
  readonly roughness: number;
  readonly metallic?: number;
  readonly base?: Vec3;
  readonly textured?: boolean;
  readonly coat?: { readonly factor: number; readonly roughness: number };
  readonly transmission?: number;
  readonly advanced?: AdvancedMaterialParameters;
  /** 计时腿的测量帧数(缺省 2);计时取中位数以抑制抖动。 */
  readonly measureFrames?: number;
  /** 画布边长(缺省 192);大尺寸仅用于计时腿,不进解析对拍。 */
  readonly size?: number;
  /** 指向光源的单位向量(缺省 TO_LIGHT);倾斜平面据此把镜面峰值放进视野。 */
  readonly toLight?: Vec3;
  /** 计时腿:不挂帧捕获/回读,仅收集 render() 返回的 GPU pass 计时。 */
  readonly timingOnly?: boolean;
}

function sphereMesh(segments = 96, rings = 64) {
  const vertices: number[] = [], indices: number[] = [], uv0: number[] = [];
  for (let y = 0; y <= rings; y++) for (let x = 0; x <= segments; x++) {
    const theta = y / rings * Math.PI, phi = x / segments * Math.PI * 2;
    const nx = Math.sin(theta) * Math.cos(phi), ny = Math.cos(theta), nz = Math.sin(theta) * Math.sin(phi);
    vertices.push(nx, ny, nz, nx, ny, nz); uv0.push(x / segments, y / rings);
  }
  for (let y = 0; y < rings; y++) for (let x = 0; x < segments; x++) {
    const a = y * (segments + 1) + x, b = a + segments + 1;
    if (y > 0) indices.push(a, a + 1, b);
    if (y < rings - 1) indices.push(a + 1, b + 1, b);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), uv0: new Float32Array(uv0) };
}

function planeNormal(tiltDeg: number): [number, number, number] {
  const t = tiltDeg * Math.PI / 180;
  return [0, -Math.sin(t), Math.cos(t)];
}

function planeMesh(tiltDeg: number) {
  const t = tiltDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), n = planeNormal(tiltDeg);
  const corners: ReadonlyArray<readonly [number, number]> = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
  const vertices: number[] = [], uv0: number[] = [];
  for (const [x, y] of corners) { vertices.push(x, y * c, y * s, n[0], n[1], n[2]); uv0.push((x + 3) / 6, (y + 3) / 6); }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), uv0: new Float32Array(uv0) };
}

function packetFor(spec: LegSpec): RenderPacket {
  const mesh = spec.shape === "sphere" ? sphereMesh() : planeMesh(spec.tiltDeg ?? 0);
  const needsExtended = spec.coat !== undefined || spec.transmission !== undefined;
  const scale = spec.shape === "sphere" ? SPHERE_RADIUS : 1;
  return {
    geometries: [{ id: "g", revision: 0, vertices: mesh.vertices, indices: mesh.indices, uv0: mesh.uv0 }],
    materials: [{ id: "m", baseColor: spec.base ?? [1, 1, 1], metallic: spec.metallic ?? 0, roughness: spec.roughness,
      ...(spec.shape === "plane" ? { doubleSided: true } : {}),
      ...(spec.textured === false ? {} : { baseColorTexture: { texture: "white" } }),
      ...(needsExtended ? { extendedParameters: { ior: 1.5, clearcoat: spec.coat ?? { factor: 0, roughness: 0 },
        anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: spec.transmission ?? 0 } } } : {}),
      ...(spec.advanced ? { advancedParameters: spec.advanced } : {}) }],
    instances: [{ id: "i", geometry: "g", material: "m",
      transform: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1] }],
    textures: spec.textured === false ? [] : [{ id: "white", revision: 0, semantic: "baseColor", width: 1, height: 1,
      data: new Uint8Array([255, 255, 255, 255]) }],
  } as RenderPacket;
}

export interface LegResult { readonly id: string; readonly gpuMs: number | null; readonly cpuSubmitMs: number | null }
const legPixels = new Map<string, Float32Array>();
const legSpecs = new Map<string, LegSpec>();

export async function probeAdapterInfo(): Promise<Record<string, unknown>> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { available: false };
  const info = adapter.info ?? {};
  return { available: true, vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
}

export async function runLeg(spec: LegSpec): Promise<LegResult> {
  const size = spec.size ?? WIDTH;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
  document.body.appendChild(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr", image: uniformFurnaceEquirect(spec.env) },
    features: { ...FEATURES }, gpuPassTiming: true, advancedMaterials: spec.advancedRenderer,
    ...(spec.timingOnly ? {} : { frameCapture: { session: new FrameCaptureSession(), readbacks: { requests: [{ resourceId: "present-color" as const }] } } }),
  });
  try {
    renderer.setPacket(packetFor(spec));
    const view = { ...VIEW, width: size, height: size, ...(spec.sun ? sunFor(spec.toLight ?? TO_LIGHT) : OFF) };
    await renderer.validateFrame(view);
    const gpu: number[] = [], cpu: number[] = [];
    if (spec.timingOnly) {
      for (let frame = 0; frame < WARM_FRAMES + (spec.measureFrames ?? 60); frame++) {
        const metrics = renderer.render(view);
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (frame >= WARM_FRAMES && metrics) {
          if (metrics.cpuSubmitMs !== undefined) cpu.push(metrics.cpuSubmitMs);
          if (metrics.gpuPassTimings?.milliseconds !== undefined) gpu.push(metrics.gpuPassTimings.milliseconds);
        }
      }
      const median = (values: number[]): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null;
      return { id: spec.id, gpuMs: median(gpu), cpuSubmitMs: median(cpu) };
    }
    let pixels: Float32Array | undefined;
    for (let frame = 0; frame < WARM_FRAMES + (spec.measureFrames ?? 2); frame++) {
      const metrics: FrameMetrics | undefined = renderer.render(view);
      const results = await renderer.frameReadbackResults;
      const snapshot = (results ?? []).find(isPbrFrameReadbackSnapshot);
      if (!snapshot) throw new Error(`Readback unavailable for leg ${spec.id}.`);
      pixels = decodeFurnaceColor(snapshot);
      if (frame >= WARM_FRAMES && metrics) {
        if (metrics.cpuSubmitMs !== undefined) cpu.push(metrics.cpuSubmitMs);
        if (metrics.gpuPassTimings?.milliseconds !== undefined) gpu.push(metrics.gpuPassTimings.milliseconds);
      }
    }
    if (size === WIDTH) legPixels.set(spec.id, pixels!);
    legSpecs.set(spec.id, spec);
    const mean = (values: number[]): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null;
    return { id: spec.id, gpuMs: mean(gpu), cpuSubmitMs: mean(cpu) };
  } finally { renderer.dispose(); canvas.remove(); }
}

/** 展示腿:四球并排(sheen 天鹅绒 / 薄膜 / 清漆车漆 / 带衰减的透射玻璃),供截图存证。 */
export async function runShowcase(): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 960; canvas.height = 270;
  document.body.appendChild(canvas);
  const mesh = sphereMesh(64, 48);
  const entries: ReadonlyArray<{ readonly color: Vec3; readonly metal: number; readonly rough: number; readonly extended?: object; readonly advanced?: AdvancedMaterialParameters }> = [
    { color: [0.35, 0.03, 0.05], metal: 0, rough: 0.7, advanced: { sheen: { color: [0.95, 0.75, 0.75], roughness: 0.45 } } },
    { color: [0.04, 0.04, 0.05], metal: 1, rough: 0.2, advanced: { iridescence: { factor: 1, ior: 1.3, thickness: 380 } } },
    { color: [0.55, 0.02, 0.02], metal: 0, rough: 0.45, extended: { ior: 1.5, clearcoat: { factor: 1, roughness: 0.08 }, anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } } },
    { color: [0.35, 0.95, 0.6], metal: 0, rough: 0.08, extended: { ior: 1.5, clearcoat: { factor: 0, roughness: 0 }, anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 1 } },
      advanced: { volume: { thickness: 1.2, attenuationColor: [0.3, 0.9, 0.5], attenuationDistance: 1.5 } } },
  ];
  const packet = {
    geometries: [{ id: "g", revision: 0, vertices: mesh.vertices, indices: mesh.indices, uv0: mesh.uv0 }],
    materials: entries.map((entry, index) => ({ id: `m${index}`, baseColor: entry.color, metallic: entry.metal, roughness: entry.rough,
      baseColorTexture: { texture: "white" }, ...(entry.extended ? { extendedParameters: entry.extended } : {}),
      ...(entry.advanced ? { advancedParameters: entry.advanced } : {}) })),
    instances: entries.map((_, index) => ({ id: `i${index}`, geometry: "g", material: `m${index}`,
      transform: [1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1.5, 0, (index - 1.5) * 3.3, 0, 0, 1] })),
    textures: [{ id: "white", revision: 0, semantic: "baseColor", width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }],
  } as RenderPacket;
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr", image: studioSky() }, features: { ...FEATURES, vignette: false }, advancedMaterials: true });
  showcase = renderer;
  renderer.setPacket(packet);
  const view = { ...VIEW, eye: [0, 0.6, 9.5] as const, extent: 12, width: 960, height: 270, exposure: 1.0,
    background: [0.05, 0.055, 0.065] as const, ...SUN };
  await renderer.validateFrame(view);
  for (let frame = 0; frame < 4; frame++) { renderer.render(view); await new Promise(resolve => requestAnimationFrame(resolve)); }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
let showcase: PbrRenderer | undefined;

function studioSky() {
  const width = 128, height = 64, data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = y / (height - 1), sun = Math.exp(-(((x / width) - 0.62) ** 2 * 80 + (v - 0.3) ** 2 * 120)) * 14;
    const sky = [0.12 + 0.55 * (1 - v), 0.16 + 0.6 * (1 - v), 0.24 + 0.75 * (1 - v)];
    for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = (v > 0.5 ? 0.08 + 0.1 * (1 - v) : sky[c]!) + sun;
  }
  return { width, height, data };
}

export function disposeShowcase(): void { showcase?.dispose(); showcase = undefined; }

/* ------------------------------ 分析 ------------------------------ */

const sphereSegmentation = furnaceSphereSegmentation(WIDTH, HEIGHT, EYE_DISTANCE, SPHERE_RADIUS, VERTICAL_FOV);
const tanHalf = Math.tan(VERTICAL_FOV / 2);

function pixelRay(x: number, y: number): [number, number, number] {
  return norm([(2 * (x + 0.5) / WIDTH - 1) * tanHalf, (1 - 2 * (y + 0.5) / HEIGHT) * tanHalf, -1]);
}

interface SurfaceSample { readonly index: number; readonly nv: number; readonly nl: number; readonly nh: number; readonly vh: number }

function sphereSamples(minNl = -1, light: Vec3 = TO_LIGHT): SurfaceSample[] {
  const samples: SurfaceSample[] = [];
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    if (sphereSegmentation[y * WIDTH + x] !== 0) continue;
    const ray = pixelRay(x, y), eye = [0, 0, EYE_DISTANCE];
    const b = dot(ray, eye), disc = b * b - (dot(eye, eye) - SPHERE_RADIUS * SPHERE_RADIUS);
    if (disc <= 0) continue;
    const hit = -b - Math.sqrt(disc);
    const p = [eye[0]! + ray[0] * hit, eye[1]! + ray[1] * hit, eye[2]! + ray[2] * hit];
    const n = [p[0]! / SPHERE_RADIUS, p[1]! / SPHERE_RADIUS, p[2]! / SPHERE_RADIUS];
    const v = norm([eye[0]! - p[0]!, eye[1]! - p[1]!, eye[2]! - p[2]!]);
    const h = norm([v[0] + light[0], v[1] + light[1], v[2] + light[2]]);
    const nl = dot(n, light);
    if (nl < minNl) continue;
    samples.push({ index: y * WIDTH + x, nv: sat(dot(n, v)), nl: sat(nl), nh: sat(dot(n, h)), vh: sat(dot(v, h)) });
  }
  return samples;
}

function planeSamples(tiltDeg: number, light: Vec3): SurfaceSample[] {
  const n = planeNormal(tiltDeg), samples: SurfaceSample[] = [], eye = [0, 0, EYE_DISTANCE];
  const t = tiltDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  for (let y = 6; y < HEIGHT - 6; y++) for (let x = 6; x < WIDTH - 6; x++) {
    const ray = pixelRay(x, y), denom = dot(n, ray);
    if (Math.abs(denom) < 1e-6) continue;
    const hit = -dot(n, eye) / denom;
    if (hit <= 0) continue;
    const p = [eye[0]! + ray[0] * hit, eye[1]! + ray[1] * hit, eye[2]! + ray[2] * hit];
    const localY = p[1]! * c + p[2]! * s;
    if (Math.abs(p[0]!) > 2.9 || Math.abs(localY) > 2.9) continue;
    const v = norm([eye[0]! - p[0]!, eye[1]! - p[1]!, eye[2]! - p[2]!]);
    if (dot(n, v) <= 0.05) continue;
    const h = norm([v[0] + light[0], v[1] + light[1], v[2] + light[2]]);
    samples.push({ index: y * WIDTH + x, nv: sat(dot(n, v)), nl: sat(dot(n, light)), nh: sat(dot(n, h)), vh: sat(dot(v, h)) });
  }
  return samples;
}

const get = (id: string): Float32Array => {
  const pixels = legPixels.get(id);
  if (!pixels) throw new Error(`Leg ${id} was not measured.`);
  return pixels;
};

function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b), at = (f: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1), p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0, min: sorted[0] ?? 0 };
}

export interface FurnaceStats { readonly meanRatio: readonly number[]; readonly minRatio: number; readonly maxRatio: number; readonly pixels: number }

/** 球体几何区像素 / E 的逐通道均值与极值。 */
export function furnaceRatio(id: string, radiance = FURNACE_RADIANCE): FurnaceStats {
  const pixels = get(id), sum = [0, 0, 0];
  let min = Infinity, max = -Infinity, count = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    if (sphereSegmentation[i] !== 0) continue;
    for (let c = 0; c < 3; c++) { const r = pixels[i * 3 + c]! / radiance; sum[c]! += r; min = Math.min(min, r); max = Math.max(max, r); }
    count++;
  }
  return { meanRatio: sum.map(v => v / count), minRatio: min, maxRatio: max, pixels: count };
}

/** 两腿球体几何区的逐分量最大绝对差(stock 位级一致、untextured≡textured 等)。 */
export function maxAbsDelta(a: string, b: string, sphereOnly = true): number {
  const pa = get(a), pb = get(b);
  let max = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    if (sphereOnly && sphereSegmentation[i] !== 0) continue;
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(pa[i * 3 + c]! - pb[i * 3 + c]!));
  }
  return max;
}

/** 球体白炉:彩色 sheen 预测 = stock·(1−max·A) + E·s_c·A(A = IBL sheen 反照率,逐像素 nv)。 */
export function sheenColorFurnace(stockId: string, sheenId: string, color: Vec3, roughness: number) {
  const stock = get(stockId), actual = get(sheenId), errors: number[] = [];
  for (const sample of sphereSamples()) {
    const a = iblSheenBrdf(sample.nv, roughness), energy = sheenIndirectEnergy(color, roughness, sample.nv);
    for (let c = 0; c < 3; c++) {
      const predicted = stock[sample.index * 3 + c]! * energy + FURNACE_RADIANCE * color[c]! * a;
      errors.push(Math.abs(actual[sample.index * 3 + c]! - predicted) / FURNACE_RADIANCE);
    }
  }
  return stats(errors);
}

/** 透射衰减:att − noatt 的逐通道比 ≈ (1−F)·E·(A−1);A = Beer(thickness, color, distance)。 */
export function volumeAttenuationRatio(noAttId: string, attId: string, thickness: number, color: Vec3, distance: number) {
  const a = get(noAttId), b = get(attId), attenuation = volumeAttenuation(thickness, color, distance);
  const ratios: number[][] = [[], [], []];
  for (const sample of sphereSamples()) for (let c = 0; c < 3; c++) {
    const expectedDelta = FURNACE_RADIANCE * (attenuation[c]! - 1);
    if (Math.abs(expectedDelta) < 0.02) continue;
    ratios[c]!.push((b[sample.index * 3 + c]! - a[sample.index * 3 + c]!) / expectedDelta);
  }
  return { attenuation, channels: ratios.map(values => stats(values)) };
}

type DirectPredictor = (sample: SurfaceSample, off: Float32Array) => readonly [number, number, number];

function directTransfer(offId: string, onId: string, tiltDeg: number, predict: DirectPredictor) {
  const off = get(offId), on = get(onId), abs: number[] = [], rel: number[] = [], delta: number[] = [];
  const light = legSpecs.get(onId)?.toLight ?? TO_LIGHT;
  for (const sample of planeSamples(tiltDeg, light)) {
    const predicted = predict(sample, off);
    for (let c = 0; c < 3; c++) {
      const measured = on[sample.index * 3 + c]!, error = Math.abs(measured - predicted[c]!);
      abs.push(error); delta.push(Math.abs(predicted[c]! - off[sample.index * 3 + c]!));
      if (Math.abs(predicted[c]! - off[sample.index * 3 + c]!) > 0.01) rel.push(error / Math.abs(predicted[c]! - off[sample.index * 3 + c]!));
    }
  }
  return { abs: stats(abs), rel: stats(rel), signal: stats(delta) };
}

export function sheenDirectTransfer(offId: string, onId: string, tiltDeg: number, color: Vec3, roughness: number) {
  return directTransfer(offId, onId, tiltDeg, (s, off) => {
    const energy = sheenDirectEnergy(color, roughness, s.nv, s.nl), brdf = sheenDirectBrdf(color, roughness, s.nv, s.nl, s.nh);
    return [0, 1, 2].map(c => off[s.index * 3 + c]! * energy + brdf[c]! * s.nl) as unknown as [number, number, number];
  });
}

function ggxVisibilityD(roughness: number, nl: number, nv: number, nh: number): number {
  const a2 = (roughness * roughness) ** 2, denom = nh * nh * (a2 - 1) + 1;
  const d = a2 / Math.max(Math.PI * denom * denom, 1e-6);
  const gv = nl * Math.sqrt(a2 + (1 - a2) * nv * nv), gl = nv * Math.sqrt(a2 + (1 - a2) * nl * nl);
  return d * 0.5 / Math.max(gv + gl, 1e-6);
}

export function iridescenceDirectTransfer(offId: string, onId: string, tiltDeg: number, roughness: number, ior: number, thickness: number) {
  return directTransfer(offId, onId, tiltDeg, (s, off) => {
    const fStock = fSchlick(0.04, s.vh), film = evalIridescence(1, ior, s.nv, thickness, [0.04, 0.04, 0.04]);
    const vd = ggxVisibilityD(Math.max(roughness, 0.06), s.nl, Math.max(s.nv, 1e-4), s.nh);
    return [0, 1, 2].map(c => off[s.index * 3 + c]! + (film[c]! - fStock) * vd * s.nl) as unknown as [number, number, number];
  });
}

export function clearcoatDirectTransfer(offId: string, onId: string, tiltDeg: number, factor: number, coatRoughness: number) {
  return directTransfer(offId, onId, tiltDeg, (s, off) => {
    const fcc = fSchlick(0.04, s.nv), coat = s.nl * fSchlick(0.04, s.vh) * ggxVisibilityD(Math.max(coatRoughness, 0.0525), s.nl, Math.max(s.nv, 1e-4), s.nh);
    return [0, 1, 2].map(c => off[s.index * 3 + c]! * (1 - factor * fcc) + coat * factor) as unknown as [number, number, number];
  });
}

/** 平面 stock 对照:同参数在 advanced 与非 advanced 管线下的逐分量最大差。 */
export function planeMaxAbsDelta(a: string, b: string): number { return maxAbsDelta(a, b, false); }

/* ------------------------------ WGSL 数学对拍 ------------------------------ */

const MATH_HARNESS = /* wgsl */ `
${ADVANCED_MATERIAL_MATH_WGSL}
@group(0) @binding(0) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs) / 2u) { return; }
  let a = inputs[i * 2u];
  let b = inputs[i * 2u + 1u];
  outputs[i * 4u] = vec4f(deepAdvEvalIridescence(1.0, a.z, a.x, a.y, b.xyz), 0.0);
  outputs[i * 4u + 1u] = vec4f(deepAdvDCharlie(a.w, b.w), deepAdvVNeubelt(a.x, b.w), deepAdvIblSheen(a.x, a.w), 0.0);
  outputs[i * 4u + 2u] = vec4f(deepAdvSchlickToF0(b.xyz, a.x), 0.0);
  outputs[i * 4u + 3u] = vec4f(deepAdvBeer(a.y * 0.01, b.xyz, 2.0), 0.0);
}`;

export async function runMathHarness(sampleCount = 4096) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice();
  let seed = 123456789;
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const inputs = new Float32Array(sampleCount * 8);
  for (let i = 0; i < sampleCount; i++) {
    const thickness = i % 17 === 0 ? 0 : 10 + random() * 990;
    inputs.set([0.02 + random() * 0.98, thickness, 1 + random() * 1.33, 0.05 + random() * 0.95,
      0.02 + random() * 0.98, 0.02 + random() * 0.98, 0.02 + random() * 0.98, random()], i * 8);
  }
  const module = device.createShaderModule({ code: MATH_HARNESS });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === "error").map(message => `WGSL ${message.lineNum}: ${message.message}`);
  if (errors.length) return { errors };
  const input = device.createBuffer({ size: inputs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(input, 0, inputs);
  const outputBytes = sampleCount * 4 * 16;
  const output = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] });
  const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(sampleCount / 64)); pass.end();
  encoder.copyBufferToBuffer(output, 0, read, 0, outputBytes);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  const worst = { iridescence: 0, charlie: 0, neubelt: 0, iblSheen: 0, schlickToF0: 0, beer: 0 };
  const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-3);
  for (let i = 0; i < sampleCount; i++) {
    const cos = inputs[i * 8]!, thickness = inputs[i * 8 + 1]!, ior = inputs[i * 8 + 2]!, rough = inputs[i * 8 + 3]!;
    const f0: Vec3 = [inputs[i * 8 + 4]!, inputs[i * 8 + 5]!, inputs[i * 8 + 6]!], nh = inputs[i * 8 + 7]!;
    const irid = evalIridescence(1, ior, cos, thickness, f0), f = schlickToF0(f0, cos);
    const beer = volumeAttenuation(thickness * 0.01, f0, 2);
    for (let c = 0; c < 3; c++) {
      worst.iridescence = Math.max(worst.iridescence, rel(out[i * 16 + c]!, irid[c]!));
      worst.schlickToF0 = Math.max(worst.schlickToF0, rel(out[i * 16 + 8 + c]!, f[c]!));
      worst.beer = Math.max(worst.beer, rel(out[i * 16 + 12 + c]!, beer[c]!));
    }
    worst.charlie = Math.max(worst.charlie, rel(out[i * 16 + 4]!, dCharlie(rough, nh)));
    worst.neubelt = Math.max(worst.neubelt, rel(out[i * 16 + 5]!, vNeubelt(cos, nh)));
    worst.iblSheen = Math.max(worst.iblSheen, rel(out[i * 16 + 6]!, iblSheenBrdf(cos, rough)));
  }
  device.destroy();
  return { errors: [] as string[], samples: sampleCount, worstRelativeError: worst };
}
