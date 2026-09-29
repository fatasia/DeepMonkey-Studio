import { summarizeShadowQuality, type AtlasLegOptions, type EvaluationOccluder,
  type EvaluationSpotLight, type PagedLegOptions, type ShadowQualityStats } from "../src/shadows/shadowPagingEvaluation.js";

/**
 * F7 阴影分页评估的场景与 GPU 构建块（probe 的纯几何/WGSL 半场）。
 * 相机、补丁投影、遮挡器三角化与两段 WGSL；策略无关，可被 vitest 侧复核。
 */

export const WIDTH = 512, HEIGHT = 384;
export const WARM_FRAMES = 3, MEASURE_FRAMES = 20;
export const CAMERA = { eye: [0, 40, 8] as const, target: [0, 0, 0] as const, verticalFovRadians: Math.PI / 4 };
export const FRAME_UNIFORM_FLOATS = 48;

export interface LegConfigSpec {
  readonly id: string;
  readonly strategy: "atlas" | "paged";
  readonly options: AtlasLegOptions | PagedLegOptions;
}

export const LEG_CONFIGS: readonly LegConfigSpec[] = Object.freeze([
  { id: "atlas-product-512", strategy: "atlas", options: { requestedAtlasSize: 1024, tileTexels: 512 } },
  { id: "atlas-256", strategy: "atlas", options: { requestedAtlasSize: 1024, tileTexels: 256 } },
  { id: "paged-256-mip1", strategy: "paged", options: { tileEdgeTexels: 256, mipLevels: 1 } },
  { id: "paged-256-mip3", strategy: "paged", options: { tileEdgeTexels: 256, mipLevels: 3 } },
  { id: "paged-512-mip3", strategy: "paged", options: { tileEdgeTexels: 512, mipLevels: 3 } },
]);
export const LIGHT_COUNTS: readonly number[] = Object.freeze([1, 4, 16]);

export interface CameraBasis {
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

const subtract = (a: readonly number[], b: readonly number[]): [number, number, number] =>
  [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const normalize = (v: readonly number[]): [number, number, number] => {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / length, v[1]! / length, v[2]! / length];
};
const cross = (a: readonly number[], b: readonly number[]): [number, number, number] =>
  [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

export function cameraBasis(): CameraBasis {
  const forward = normalize(subtract(CAMERA.target, CAMERA.eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  return { forward, right, up: cross(right, forward) };
}

/** 主相机 NDC 射线方向（与 probe 的 CPU 参考、WGSL fragment 三方同式）。 */
export function cameraRay(basis: CameraBasis, ndcX: number, ndcY: number): readonly [number, number, number] {
  const tanHalf = Math.tan(CAMERA.verticalFovRadians / 2);
  const aspect = WIDTH / HEIGHT;
  const x = basis.forward[0]! + basis.right[0]! * ndcX * tanHalf * aspect + basis.up[0]! * ndcY * tanHalf;
  const y = basis.forward[1]! + basis.right[1]! * ndcX * tanHalf * aspect + basis.up[1]! * ndcY * tanHalf;
  const z = basis.forward[2]! + basis.right[2]! * ndcX * tanHalf * aspect + basis.up[2]! * ndcY * tanHalf;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

export function projectToPixels(point: readonly number[], viewProjection: Float32Array): readonly [number, number] {
  const v = [point[0]!, point[1]!, point[2]!, 1];
  const clip = [0, 0, 0, 0];
  // cameraMath 为列主序:clip[r] = Σ_c m[c*4 + r]·v[c](与 WGSL mat4x4f 同主序)。
  for (let row = 0; row < 4; row += 1) {
    clip[row] = viewProjection[row]! * v[0]! + viewProjection[4 + row]! * v[1]!
      + viewProjection[8 + row]! * v[2]! + viewProjection[12 + row]! * v[3]!;
  }
  const ndcX = clip[0]! / clip[3]!, ndcY = clip[1]! / clip[3]!;
  return [(ndcX * 0.5 + 0.5) * WIDTH, (0.5 - ndcY * 0.5) * HEIGHT];
}

/** 补丁投影像素矩形 [x, y, w, h]，出屏即抛错（场景完整性前置检查）。 */
export function patchRect(light: EvaluationSpotLight, viewProjection: Float32Array):
  readonly [number, number, number, number] {
  const [cx, cz] = light.patchCenter, half = light.patchHalfExtent;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const dx of [-half, half]) for (const dz of [-half, half]) {
    const [px, py] = projectToPixels([cx + dx, 0, cz + dz], viewProjection);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const x0 = Math.max(0, Math.floor(minX) - 1), y0 = Math.max(0, Math.floor(minY) - 1);
  const x1 = Math.min(WIDTH, Math.ceil(maxX) + 2), y1 = Math.min(HEIGHT, Math.ceil(maxY) + 2);
  if (x1 - x0 < 4 || y1 - y0 < 4) throw new Error(`Patch ${light.key} projects off screen.`);
  return [x0, y0, x1 - x0, y1 - y0];
}

/** AABB → 12 三角形 × 3 顶点的三角列表（36 顶点/盒）。 */
export function emitBoxes(occluders: readonly EvaluationOccluder[]): Float32Array<ArrayBuffer> {
  const vertices: number[] = [];
  const push = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
    vertices.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!);
  };
  const quad = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): void => {
    push(a, b, c); push(a, c, d);
  };
  for (const box of occluders) {
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
    quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
    quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
    quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]);
  }
  return Float32Array.from(vertices);
}

/** IEEE 754 binary16 → number(读回 rgba16float 用)。 */
export function decodeHalfFloat(bits: number): number {
  const sign = (bits & 0x8000) >> 15, exponent = (bits & 0x7c00) >> 10, fraction = bits & 0x03ff;
  if (exponent === 0) return (sign ? -1 : 1) * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : (sign ? -1 : 1) * Infinity;
  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export interface PerLightQuality {
  readonly key: string;
  readonly texels: number;
  readonly shadowed: boolean;
  readonly stats: ShadowQualityStats | null;
}

export interface LegEvaluation {
  readonly configId: string;
  readonly strategy: "atlas" | "paged";
  readonly lightCount: number;
  readonly coverage: number;
  readonly shadowedKeys: readonly string[];
  readonly unshadowedKeys: readonly string[];
  readonly perLight: readonly PerLightQuality[];
  readonly aggregate: ShadowQualityStats;
  readonly referenceShadowedSamples: number;
  readonly depthBytes: number;
  readonly budgetBytes: number;
  readonly gpuFrameMs: number | null;
  readonly cpuPlanUs: number;
}

/** 聚合判据:各行 padded 到最大行宽(行内非补丁像素与行尾 padding 均 mask=0),行语义成立后统一 summarize。 */
export function aggregateShadowStats(rows: { measured: number[]; reference: number[]; mask: number[] }[]):
  ShadowQualityStats {
  const width = Math.max(...rows.map(row => row.measured.length));
  const measured = new Float32Array(rows.length * width);
  const reference = new Float32Array(rows.length * width);
  const mask = new Uint8Array(rows.length * width);
  rows.forEach((row, y) => {
    measured.set(row.measured, y * width);
    reference.set(row.reference, y * width);
    mask.set(row.mask, y * width);
  });
  return summarizeShadowQuality(measured, reference, mask, width);
}

export const SHADOW_WGSL = /* wgsl */ `
struct ShadowUniform { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> su: ShadowUniform;
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return su.viewProj * vec4f(pos, 1.0);
}`;

export const RECEIVER_WGSL = /* wgsl */ `
struct FrameUniform {
  eye: vec3f, padA: f32, forward: vec3f, padB: f32, right: vec3f, padC: f32, up: vec3f, padD: f32,
  tanHalfFov: f32, aspect: f32, patchHalf: f32, shadowed: f32,
  lightPos: vec3f, padE: f32,
  patchCenter: vec2f, mapSize: f32, texel: f32,
  bias: f32, scale: f32, width: f32, height: f32,
  lightViewProj: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: FrameUniform;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

fn shadowVisibility(world: vec3f) -> f32 {
  if (u.shadowed < 0.5) { return 1.0; }
  let clip = u.lightViewProj * vec4f(world, 1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  let offsets = array<vec2f, 4>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5), vec2f(0.5, 0.5));
  var visibility = 0.0;
  for (var sampleIndex = 0u; sampleIndex < 4u; sampleIndex++) {
    visibility += textureSampleCompareLevel(shadowMap, shadowSampler, uv + offsets[sampleIndex] * u.texel,
      ndc.z - u.bias);
  }
  return visibility / 4.0;
}

@vertex fn vs(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let ndcX = 2.0 * fragCoord.x / u.width - 1.0;
  let ndcY = 1.0 - 2.0 * fragCoord.y / u.height;
  let ray = normalize(u.forward + u.right * (ndcX * u.tanHalfFov * u.aspect) + u.up * (ndcY * u.tanHalfFov));
  if (abs(ray.y) < 1e-6) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let t = -u.eye.y / ray.y;
  if (t <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let world = u.eye + ray * t;
  let inPatch = abs(world.x - u.patchCenter.x) <= u.patchHalf && abs(world.z - u.patchCenter.y) <= u.patchHalf;
  if (!inPatch) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let toLight = u.lightPos - world;
  let irradiance = 64.0 / max(1.0, dot(toLight, toLight));
  return vec4f(vec3f(irradiance * shadowVisibility(world) * u.scale), 1.0);
}`;
