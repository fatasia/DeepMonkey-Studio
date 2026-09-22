import { clusterSliceForDepth } from "./clusterGrid.js";
import { packClusteredLights, SPOT_LIGHT_STRIDE } from "./clusterPacking.js";
import { evaluateIesShadingFactor, packIesShading } from "./iesShading.js";
import type { ClusteredLights, CpuClusterAssignment, LightVector3, PackedClusteredLights, PointLight, SpotLight } from "./types.js";

const PI = Math.PI;
type MutableVec3 = [number, number, number];

export interface ForwardPlusPbrSurface {
  readonly fragmentCoordinate: readonly [number, number];
  readonly positionView: LightVector3;
  readonly normalView: LightVector3;
  readonly baseColor: LightVector3;
  readonly metallic: number;
  readonly roughness: number;
}

export interface CpuForwardPlusPbrResult {
  readonly color: LightVector3;
  readonly clusterIndex?: number;
  readonly referencedLocalLightCount: number;
}

function finite3(value: LightVector3, name: string): void {
  if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${name} must contain three finite values.`);
}
function normalize(value: LightVector3, fallback: LightVector3): MutableVec3 {
  const lengthSquared = dot(value, value);
  if (lengthSquared <= 1e-8) return [...fallback];
  const inverseLength = 1 / Math.sqrt(lengthSquared); return [value[0] * inverseLength, value[1] * inverseLength, value[2] * inverseLength];
}
function dot(a: LightVector3, b: LightVector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add(target: MutableVec3, value: LightVector3): void { target[0] += value[0]; target[1] += value[1]; target[2] += value[2]; }
function scale(value: LightVector3, amount: number): MutableVec3 { return [value[0] * amount, value[1] * amount, value[2] * amount]; }
function subtract(a: LightVector3, b: LightVector3): MutableVec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }

export function clusterIndexForFragment(assignment: CpuClusterAssignment, fragmentCoordinate: readonly [number, number], positionView: LightVector3): number | undefined {
  const grid = assignment.grid, depth = -positionView[2];
  if (!fragmentCoordinate.every(Number.isFinite) || !positionView.every(Number.isFinite)
    || fragmentCoordinate[0] < 0 || fragmentCoordinate[1] < 0 || fragmentCoordinate[0] >= grid.viewportWidth
    || fragmentCoordinate[1] >= grid.viewportHeight || depth < grid.near || depth > grid.far) return undefined;
  const tileX = Math.min(grid.tilesX - 1, Math.floor(fragmentCoordinate[0]) / grid.tileSizeX) | 0;
  const tileY = Math.min(grid.tilesY - 1, Math.floor(fragmentCoordinate[1]) / grid.tileSizeY) | 0;
  return clusterSliceForDepth(grid, depth) * grid.tilesX * grid.tilesY + tileY * grid.tilesX + tileX;
}

function fresnelSchlick(cosine: number, f0: LightVector3): MutableVec3 {
  const factor = 2 ** ((-5.55473 * cosine - 6.98316) * cosine);
  return f0.map(value => value * (1 - factor) + factor) as MutableVec3;
}
function distributionGgx(nDotH: number, roughness: number): number {
  const alpha = roughness * roughness, alpha2 = alpha * alpha, denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  return alpha2 / Math.max(PI * denominator * denominator, 1e-6);
}
function brdf(baseColor: LightVector3, metallic: number, roughness: number, normal: LightVector3,
  view: LightVector3, surfaceToLight: LightVector3, radiance: LightVector3): MutableVec3 {
  const nDotL = clamp(dot(normal, surfaceToLight), 0, 1); if (nDotL <= 0) return [0, 0, 0];
  const half = normalize([view[0] + surfaceToLight[0], view[1] + surfaceToLight[1], view[2] + surfaceToLight[2]], normal);
  const nDotV = clamp(dot(normal, view), 1e-4, 1), nDotH = clamp(dot(normal, half), 0, 1), vDotH = clamp(dot(view, half), 0, 1);
  const f0 = baseColor.map(value => 0.04 * (1 - metallic) + value * metallic) as MutableVec3;
  const fresnel = fresnelSchlick(vDotH, f0), distribution = distributionGgx(nDotH, roughness);
  const alpha = roughness * roughness, alpha2 = alpha * alpha;
  const gv = nDotL * Math.sqrt(alpha2 + (1 - alpha2) * nDotV * nDotV);
  const gl = nDotV * Math.sqrt(alpha2 + (1 - alpha2) * nDotL * nDotL);
  const visibility = 0.5 / Math.max(gv + gl, 1e-6);
  return baseColor.map((base, index) => {
    const specular = distribution * visibility * fresnel[index]!;
    const diffuse = (1 - metallic) * base / PI;
    return (diffuse + specular) * radiance[index]! * nDotL;
  }) as MutableVec3;
}
function rangeAttenuation(distanceSquared: number, range: number, decay = 2): number {
  const falloff = 1 / Math.max(Math.max(Math.sqrt(distanceSquared), 1e-8) ** decay, 0.01);
  if (range === 0) return falloff;
  if (distanceSquared >= range * range) return 0;
  const ratioSquared = distanceSquared / Math.max(range * range, 1e-4), window = Math.max(1 - ratioSquared * ratioSquared, 0);
  if (decay === 2) return window * window / Math.max(distanceSquared, 0.01);
  return window * window * falloff;
}
function localContribution(light: PointLight | SpotLight, surface: ForwardPlusPbrSurface, base: LightVector3,
  metallic: number, roughness: number, normal: LightVector3, view: LightVector3,
  packed: PackedClusteredLights, iesPacking: ReturnType<typeof packIesShading>, spotIndex: number): MutableVec3 {
  const toLight = subtract(light.positionView, surface.positionView), distanceSquared = dot(toLight, toLight);
  let attenuation = rangeAttenuation(distanceSquared, light.range, light.decay); if (attenuation <= 0) return [0, 0, 0];
  const surfaceToLight = normalize(toLight, normal);
  if ("directionView" in light) {
    const direction = normalize(light.directionView, [0, 0, -1]);
    const coneCos = dot(scale(surfaceToLight, -1), direction);
    const coneWeight = light.innerConeCos === light.outerConeCos ? Number(coneCos >= light.outerConeCos)
      : clamp((coneCos - light.outerConeCos) / (light.innerConeCos - light.outerConeCos), 0, 1);
    attenuation *= coneWeight * coneWeight * (3 - 2 * coneWeight);
    if (light.ies !== undefined && spotIndex >= 0) {
      // E02：与 GPU 同式（读打包 f32 方向 + 打包归一化表），见 iesShading.ts。
      const packedBase = spotIndex * SPOT_LIGHT_STRIDE / 4 + 4;
      const packedDirection: LightVector3 = [packed.spots[packedBase]!, packed.spots[packedBase + 1]!, packed.spots[packedBase + 2]!];
      attenuation *= evaluateIesShadingFactor(iesPacking, spotIndex, packedDirection,
        [surfaceToLight[0], surfaceToLight[1], surfaceToLight[2]]);
    }
  }
  return brdf(base, metallic, roughness, normal, view, surfaceToLight,
    scale(light.color, light.intensity * attenuation));
}

/** Deterministic scalar reference for fake-device tests and real-GPU readback probes. */
export function evaluateForwardPlusPbrCpu(assignment: CpuClusterAssignment, lights: ClusteredLights,
  surface: ForwardPlusPbrSurface): CpuForwardPlusPbrResult {
  const packed = packClusteredLights(lights), points = lights.points ?? [], spots = lights.spots ?? [];
  // E02：与 GPU 同一份 IES 打包字节；无 ies 时为最小占位缓冲，评测恒等返回 1。
  const iesPacking = packIesShading(spots, lights.lightProfiles);
  if (assignment.localLightCount !== packed.pointCount + packed.spotCount) throw new Error("CPU cluster assignment does not match the supplied local lights.");
  finite3(surface.positionView, "positionView"); finite3(surface.normalView, "normalView"); finite3(surface.baseColor, "baseColor");
  if (!surface.fragmentCoordinate.every(Number.isFinite) || !Number.isFinite(surface.metallic) || !Number.isFinite(surface.roughness)) {
    throw new Error("PBR surface scalar inputs must be finite.");
  }
  const base = surface.baseColor.map(value => Math.max(value, 0)) as MutableVec3;
  const metallic = clamp(surface.metallic, 0, 1), roughness = clamp(surface.roughness, 0.045, 1);
  const normal = normalize(surface.normalView, [0, 0, 1]), view = normalize(scale(surface.positionView, -1), [0, 0, 1]);
  const color: MutableVec3 = [0, 0, 0];
  for (const light of lights.directional ?? []) {
    const surfaceToLight = scale(normalize(light.directionView, [0, 0, -1]), -1);
    add(color, brdf(base, metallic, roughness, normal, view, surfaceToLight, scale(light.color, light.intensity)));
  }
  const clusterIndex = clusterIndexForFragment(assignment, surface.fragmentCoordinate, surface.positionView);
  let referencedLocalLightCount = 0;
  if (clusterIndex !== undefined) {
    const offset = assignment.headers[clusterIndex * 2]!, count = Math.min(assignment.headers[clusterIndex * 2 + 1]!, assignment.grid.maxLightsPerCluster);
    for (let slot = 0; slot < count; slot++) {
      const localIndex = assignment.lightIndices[offset + slot]!;
      if (localIndex >= assignment.localLightCount) continue;
      const isPoint = localIndex < points.length;
      const light = isPoint ? points[localIndex] : spots[localIndex - points.length];
      if (!light) continue;
      referencedLocalLightCount++;
      add(color, localContribution(light, surface, base, metallic, roughness, normal, view, packed, iesPacking,
        isPoint ? -1 : localIndex - points.length));
    }
  }
  if (!color.every(Number.isFinite)) throw new Error("PBR CPU reference produced a non-finite color.");
  return { color, ...(clusterIndex === undefined ? {} : { clusterIndex }), referencedLocalLightCount };
}
