import { isValidVisibilityPixel, type VisibilitySlotRow } from "./visibilityBufferEncoding.js";

/**
 * 可见性 resolve 的 CPU 参考实现 —— 与 VISIBILITY_RESOLVE_WGSL 逐公式对拍。
 *
 * 用途：无需 GPU 即可验证"给定合成可见性 buffer 输出与 forward 一致的材质选择"，
 * 并作为后续真机 readback 比对的黄金参考。第一切片光照 =
 * albedo(slot 表) + 深度重建平面法线 + 太阳直射 GGX(brdf) + 自发光；
 * 阴影图/clustered/IBL/雾/AO 未进入该切片（deferred，两边都不假装有）。
 */

export interface ResolveReferenceUniforms {
  /** 列主序逆视图投影（invertMat4 输出）。 */
  readonly inverseViewProjection: ArrayLike<number>;
  readonly eye: readonly [number, number, number];
  /** 世界空间主光方向（指向光源，同 frame.lightDirection）。 */
  readonly lightDirection: readonly [number, number, number];
  /** rgb 颜色 × w 强度（同 frame.sunColor）。 */
  readonly sunColor: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
}

export interface ResolveReferencePixel {
  readonly slot: number;
  readonly packedTriangle: number;
  readonly depth: number;
  readonly forward: readonly [number, number, number, number];
  /** 供法线重建的屏幕空间世界位置导数；WGSL 侧为 dpdx/dpdy(world)。 */
  readonly world: readonly [number, number, number];
  readonly worldNeighborX: readonly [number, number, number];
  readonly worldNeighborY: readonly [number, number, number];
  /** WGSL deepGeometryRoughness(normal)：dpdx/dpdy 幅值；CPU 参考由外部提供同量。 */
  readonly geometryRoughness?: number;
}

const safeNormalize = (value: readonly number[], fallback: readonly [number, number, number]): readonly [number, number, number] => {
  const lengthSquared = value[0]! * value[0]! + value[1]! * value[1]! + value[2]! * value[2]!;
  if (lengthSquared <= 0.00000001) return fallback;
  const scale = 1 / Math.sqrt(lengthSquared);
  return [value[0]! * scale, value[1]! * scale, value[2]! * scale];
};

/** GGX + 相关 Smith + Schlick，与 PBR_DIRECT_LIGHTING_WGSL 的 brdf 同式。 */
export function referenceBrdf(n: readonly number[], v: readonly number[], l: readonly number[],
  base: readonly number[], metal: number, rough: number): [number, number, number] {
  const h = safeNormalize([v[0]! + l[0]!, v[1]! + l[1]!, v[2]! + l[2]!], [n[0]!, n[1]!, n[2]!]);
  const nv = clamp(dot(n, v), 0.0001, 1.0), nl = clamp(dot(n, l), 0.0, 1.0);
  const nh = clamp(dot(n, h), 0.0, 1.0), vh = clamp(dot(v, h), 0.0, 1.0);
  const alpha = rough * rough, a2 = alpha * alpha;
  const denom = nh * nh * (a2 - 1.0) + 1.0;
  const distribution = a2 / Math.max(Math.PI * denom * denom, 0.000001);
  const gv = nl * Math.sqrt(a2 + (1.0 - a2) * nv * nv);
  const gl = nv * Math.sqrt(a2 + (1.0 - a2) * nl * nl);
  const visibility = 0.5 / Math.max(gv + gl, 0.000001);
  // f0 = mix(0.04, base, metal)；f = f0*(1-factor) + factor —— 与 WGSL fresnel 同式（exp2 = 2^x）。
  const factor = Math.pow(2, (-5.55473 * vh - 6.98316) * vh);
  const f = [0, 1, 2].map(index => {
    const f0 = 0.04 * (1.0 - metal) + base[index]! * metal;
    return f0 * (1.0 - factor) + factor;
  });
  const specular = [0, 1, 2].map(index => f[index]! * visibility * distribution);
  const diffuse = [0, 1, 2].map(index => (1.0 - metal) * base[index]! / Math.PI);
  return [0, 1, 2].map(index => (diffuse[index]! + specular[index]!) * nl) as [number, number, number];
}

/** 单像素解析：先做材质选择（与 forward 覆盖一致性由哨兵回落保证），再算第一切片颜色。 */
export function resolveVisibilityPixelReference(pixel: ResolveReferencePixel,
  materials: readonly (VisibilitySlotRow | undefined)[],
  uniforms: ResolveReferenceUniforms): readonly [number, number, number, number] {
  const [r, g, b, a] = pixel.forward;
  if (!isValidVisibilityPixel(pixel.slot, pixel.packedTriangle)) return [r, g, b, a];
  const entry = materials[pixel.slot];
  if (!entry) return [r, g, b, a];
  const world = pixel.world;
  const view = safeNormalize([uniforms.eye[0]! - world[0]!, uniforms.eye[1]! - world[1]!, uniforms.eye[2]! - world[2]!],
    [0, 0, 1]);
  const tangentX = subtract(pixel.worldNeighborX, world), tangentY = subtract(pixel.worldNeighborY, world);
  let normal = normalize(cross(tangentX, tangentY));
  if (dot(normal, view) < 0.0) normal = negate(normal);
  const rough = clamp(entry.material[0]!, 0.06, 1.0) + (pixel.geometryRoughness ?? 0);
  const light = safeNormalize(uniforms.lightDirection, [0, 1, 0]);
  const direct = referenceBrdf(normal, view, light, entry.colorMetal, entry.colorMetal[3]!, rough);
  const strength = uniforms.sunColor[3]!;
  const color = [0, 1, 2].map(index => direct[index]! * uniforms.sunColor[index]! * strength + entry.emissiveAlpha[index]!);
  return [color[0]!, color[1]!, color[2]!, 1.0];
}

/** 材质选择对拍：covered 像素的 slot 表行必须等于 forward 实例行同源参数。 */
export function visibilityMaterialSelection(pixel: ResolveReferencePixel,
  materials: readonly (VisibilitySlotRow | undefined)[]): VisibilitySlotRow | "forward" {
  if (!isValidVisibilityPixel(pixel.slot, pixel.packedTriangle)) return "forward";
  return materials[pixel.slot] ?? "forward";
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function subtract(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function negate(a: readonly [number, number, number]): [number, number, number] {
  return [-a[0]!, -a[1]!, -a[2]!];
}
function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function normalize(a: readonly number[]): [number, number, number] {
  const length = Math.sqrt(dot(a, a));
  return length > 0 ? ([a[0]! / length, a[1]! / length, a[2]! / length]) : [0, 0, 0];
}
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
