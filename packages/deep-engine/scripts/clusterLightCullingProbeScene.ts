import type { ClusterGridConfig, PointLight } from "../src/lighting/types.js";

/** C2 真机 probe 共享场景:确定性灯场 + 基准网格 + 与 probe WGSL 逐式同源的 CPU BRDF 参考。 */

/** 基准网格:640×360、32px tile、12 深度切片 → 20×12×12=2880 簇;near1/far32、fov60°。 */
export const BENCH_GRID: ClusterGridConfig = { viewportWidth: 640, viewportHeight: 360, tileSizeX: 32, tileSizeY: 32,
  zSlices: 12, near: 1, far: 32, verticalFovRadians: Math.PI / 3, maxLightsPerCluster: 64 };

/** 正确性小网格(含溢出腿):64×32、32px、4 切片、2×1×4=8 簇、每簇上限 4。 */
export const OVERFLOW_GRID: ClusterGridConfig = { viewportWidth: 64, viewportHeight: 32, tileSizeX: 32, tileSizeY: 32,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 4 };

/** xorshift32 确定性灯场:位置布满视锥体深板,range 1.5..6,暖/冷交替色,intensity 2。 */
export function seededLights(count: number, seed = 0x9e3779b9): PointLight[] {  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: count }, (_, index) => {
    const warm = index % 2 === 0;
    return {
      positionView: [-14 + 28 * next(), -8 + 16 * next(), -2 - 28 * next()] as [number, number, number],
      range: 1.5 + 4.5 * next(),
      color: warm ? [1, 0.82, 0.6] as const : [0.55, 0.75, 1] as const,
      intensity: 2,
    };
  });
}

const PI = Math.PI;

const fr = Math.fround;
export interface F32LightBounds { minTileX: number; maxTileX: number; minTileY: number; maxTileY: number;
  minSlice: number; maxSlice: number }

/**
 * WGSL boundsForSphere 的 f32 逐式镜像(每步 fround):随机灯场下 f64 CPU 参考会在
 * tile/切片边界与 GPU f32 分歧,B1 自家 probe 以手工摆位避开;真机随机场对拍必须用
 * 与 WGSL 同精度的镜像才算数。算子顺序与 clusterLightCulling.wgsl 逐行同构。
 */
export function clusterBoundsForSphereF32(grid: NormalizedClusterGridLike,
  position: readonly [number, number, number], range: number): F32LightBounds | undefined {
  const near = grid.near, far = grid.far, tanHalfFovY = grid.tanHalfFovY, aspect = grid.aspect;
  const depth = fr(-position[2]);
  if (range === 0) return { minTileX: 0, maxTileX: grid.tilesX - 1, minTileY: 0, maxTileY: grid.tilesY - 1, minSlice: 0, maxSlice: grid.zSlices - 1 };
  if (fr(depth + range) < near || fr(depth - range) > far) return undefined;
  const depthSlice = (value: number): number => {
    const clamped = value < near ? near : value > far ? far : value;
    const logFarNear = fr(Math.log(fr(far / near)));
    const normalized = fr(fr(fr(Math.log(fr(fr(clamped / near)))) / logFarNear));
    const scaled = fr(fr(normalized * grid.zSlices));
    return Math.min(grid.zSlices - 1, Math.floor(scaled));
  };
  const minSlice = depthSlice(near < fr(depth - range) ? fr(depth - range) : near);
  const maxSlice = depthSlice(far > fr(depth + range) ? fr(depth + range) : far);
  if (depth <= range || fr(depth - range) <= near) {
    return { minTileX: 0, maxTileX: grid.tilesX - 1, minTileY: 0, maxTileY: grid.tilesY - 1, minSlice, maxSlice };
  }
  const tanHalfFovX = fr(tanHalfFovY * aspect);
  const closestDepth = near < fr(depth - range) ? fr(depth - range) : near;
  const centerX = fr(position[0] / fr(depth * tanHalfFovX));
  const centerY = fr(position[1] / fr(depth * tanHalfFovY));
  const radiusX = fr(range / fr(closestDepth * tanHalfFovX));
  const radiusY = fr(range / fr(closestDepth * tanHalfFovY));
  const minX = fr(centerX - radiusX), maxX = fr(centerX + radiusX);
  const minY = fr(centerY - radiusY), maxY = fr(centerY + radiusY);
  if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) return undefined;
  const tileAt = (ndc: number, viewport: number, tileSize: number, tileCount: number): number => {
    const scaled = fr(fr(fr(ndc * 0.5) + 0.5) * viewport);
    const clamped = Math.max(0, Math.min(viewport - 1e-4, scaled));
    return Math.min(tileCount - 1, Math.floor(fr(clamped / tileSize)));
  };
  return {
    minTileX: tileAt(Math.max(-1, minX), grid.viewportWidth, grid.tileSizeX, grid.tilesX),
    maxTileX: tileAt(Math.min(1, maxX), grid.viewportWidth, grid.tileSizeX, grid.tilesX),
    minTileY: tileAt(Math.max(-1, -maxY), grid.viewportHeight, grid.tileSizeY, grid.tilesY),
    maxTileY: tileAt(Math.min(1, -minY), grid.viewportHeight, grid.tileSizeY, grid.tilesY),
    minSlice, maxSlice,
  };
}
export interface NormalizedClusterGridLike { viewportWidth: number; viewportHeight: number; tileSizeX: number;
  tileSizeY: number; tilesX: number; tilesY: number; zSlices: number; near: number; far: number;
  aspect: number; tanHalfFovY: number; maxLightsPerCluster: number }

/** 与 probe WGSL 逐式同源的点光衰减(1/r^decay 窗口)。 */
export function rangeAttenuationCpu(distanceSquared: number, range: number, decay: number): number {
  const falloff = 1 / Math.max(Math.pow(Math.max(Math.sqrt(distanceSquared), 1e-8), decay), 0.01);
  if (range === 0) return falloff;
  if (distanceSquared >= range * range) return 0;
  const ratioSquared = distanceSquared / Math.max(range * range, 1e-4);
  const window = Math.max(1 - ratioSquared * ratioSquared, 0);
  if (decay === 2) return window * window / Math.max(distanceSquared, 0.01);
  return window * window * falloff;
}

/** 与 probe WGSL 逐式同源的 GGX BRDF 点光贡献(clusterLightingPbrWgsl.deepClusterPointContribution 同型)。 */
export function pointContributionCpu(light: PointLight, positionView: readonly [number, number, number],
  baseColor: readonly [number, number, number], metallic: number, roughness: number,
  normal: readonly [number, number, number], view: readonly [number, number, number], dielectric = 0.04): [number, number, number] {
  const toLight = [light.positionView[0] - positionView[0], light.positionView[1] - positionView[1], light.positionView[2] - positionView[2]];
  const distanceSquared = toLight[0] * toLight[0] + toLight[1] * toLight[1] + toLight[2] * toLight[2];
  const attenuation = rangeAttenuationCpu(distanceSquared, light.range, light.decay ?? 2);
  if (attenuation <= 0) return [0, 0, 0];
  const length = Math.sqrt(distanceSquared);
  const surfaceToLight = length > 1e-4 ? [toLight[0] / length, toLight[1] / length, toLight[2] / length]
    : [...normal] as [number, number, number];
  const radiance = [light.color[0] * light.intensity * attenuation, light.color[1] * light.intensity * attenuation,
    light.color[2] * light.intensity * attenuation];
  return brdfCpu(baseColor, metallic, roughness, normal, view, surfaceToLight, radiance, dielectric);
}

function safeNormalize(value: readonly number[], fallback: readonly number[]): [number, number, number] {
  const lengthSquared = value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
  if (lengthSquared <= 1e-8) return [...fallback] as [number, number, number];
  const scale = 1 / Math.sqrt(Math.max(lengthSquared, 1e-8));
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function brdfCpu(baseColor: readonly [number, number, number], metallic: number, roughness: number,
  normal: readonly [number, number, number], view: readonly [number, number, number],
  surfaceToLight: readonly [number, number, number], radiance: readonly number[],
  dielectric: number): [number, number, number] {
  const nDotL = Math.max(0, Math.min(1, normal[0] * surfaceToLight[0] + normal[1] * surfaceToLight[1] + normal[2] * surfaceToLight[2]));
  if (nDotL <= 0) return [0, 0, 0];
  const halfVector = safeNormalize([view[0] + surfaceToLight[0], view[1] + surfaceToLight[1], view[2] + surfaceToLight[2]], normal);
  const nDotV = Math.max(1e-4, Math.min(1, normal[0] * view[0] + normal[1] * view[1] + normal[2] * view[2]));
  const nDotH = Math.max(0, Math.min(1, normal[0] * halfVector[0] + normal[1] * halfVector[1] + normal[2] * halfVector[2]));
  const vDotH = Math.max(0, Math.min(1, view[0] * halfVector[0] + view[1] * halfVector[1] + view[2] * halfVector[2]));
  const f0 = [dielectric * (1 - metallic) + baseColor[0] * metallic, dielectric * (1 - metallic) + baseColor[1] * metallic,
    dielectric * (1 - metallic) + baseColor[2] * metallic];
  const fresnel = f0.map(value => value * (1 - Math.exp((-5.55473 * vDotH - 6.98316) * vDotH)) + Math.exp((-5.55473 * vDotH - 6.98316) * vDotH));
  const alpha = roughness * roughness, alpha2 = alpha * alpha;
  const denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  const distribution = alpha2 / Math.max(PI * denominator * denominator, 1e-6);
  const gv = nDotL * Math.sqrt(alpha2 + (1 - alpha2) * nDotV * nDotV);
  const gl = nDotV * Math.sqrt(alpha2 + (1 - alpha2) * nDotL * nDotL);
  const visibility = 0.5 / Math.max(gv + gl, 1e-6);
  const pixel: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const diffuse = (1 - metallic) * baseColor[channel] / PI;
    pixel[channel] = (diffuse + distribution * visibility * fresnel[channel]) * radiance[channel] * nDotL;
  }
  return pixel;
}
