import type { Document } from "@gltf-transform/core";
import * as THREE from "three";
import type { ProbeAabb } from "@bim-studio/deep-engine";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { buildSceneAcceleration, collectTargets, isOccluded, type PrimitiveBakeTarget, type SceneAcceleration } from "./lightmapBaker";
import { createBounceScratch, diffuseBounce, type BounceScene } from "./lightmapIndirect";
import { createLightmapMaterialSamplers } from "./lightmapMaterial";
import { PROBE_BAKE_QUALITY_PRESETS, boundsOverlap, lightInfluenceAabb, planProbeGrid,
  type ProbeBakeQuality, type ProbeBakeQualityPreset, type ProbeGridPlan, type ProbeRegionPlan } from "./lightmapProbeRegions";
import type { BakeLightState } from "./modelOptimizer";

/**
 * 探针烘焙执行层(B 烘焙轴切片一期)。
 *
 * 合同:bakePreparedProbeRegion 是纯函数——(区域相交几何指纹 + 影响该区域的启用灯状态
 * + 质量参数 + 探针布局)完全决定输出字节,同输入逐位同输出。增量复用与一致性证明都建立在
 * 这一点上。禁用灯不参与区域哈希:禁用灯的状态变化不应触发重烘,重新启用会改变哈希自然失效。
 * 探针记录为 Float32(哈希按内存字节计算):
 * [0..2] 直射辐照 RGB、[3..5] 一跳间接 RGB、[6] 中程遮挡(0..1)、[7] 保留位(恒 1)。
 * 直射/间接通道含 4π/N 球面积分归一,直射的余弦平滑核额外引入 π 增益,消费端换算时扣除;
 * 方向光的 |direction| 缩放口径与贴图烘焙 evaluateLighting 保持一致。
 */

export const PROBE_RECORD_FLOATS = 8;
const PROBE_RECORD_FORMAT_VERSION = 1;
const GOLDEN_ANGLE = 2.399963229728653;
const FOUR_PI = Math.PI * 4;

export interface ProbeBakeOptions {
  quality: ProbeBakeQuality;
  lights: BakeLightState[];
  ambient: number;
  ambientColor: string;
}

export interface ProbeTargetFingerprint {
  hash: string;
  bounds: ProbeAabb;
}

export interface PreparedProbeBake {
  plan: ProbeGridPlan;
  readonly options: ProbeBakeOptions;
  readonly preset: ProbeBakeQualityPreset;
  targets: number;
  triangles: number;
  sceneBounds: ProbeAabb;
  fingerprints: ProbeTargetFingerprint[];
  acceleration: SceneAcceleration;
  dispose(): void;
}

export interface ProbeRegionBakeResult {
  key: string;
  probeCount: number;
  records: Float32Array;
  bytes: Uint8Array;
  stateHash: string;
  bakeMs: number;
  affectedLightIds: string[];
  overlappingPrimitives: number;
}

interface RegionLight {
  light: BakeLightState;
  color: THREE.Color;
}

/** 一次性准备:收集烘焙目标、构建 BVH、计算每 primitive 指纹与世界包围盒。 */
export async function prepareProbeBake(document: Document, options: ProbeBakeOptions): Promise<PreparedProbeBake> {
  const preset = PROBE_BAKE_QUALITY_PRESETS[options.quality];
  const targets = collectTargets(document);
  if (targets.length === 0) throw new Error("模型没有可用于探针烘焙的三角面和法线");
  // 间接通道需要材质采样;纯直射时传空表——BounceSurface.sample 只会被反弹路径调用。
  const samplers = preset.indirectSamples > 0
    ? await createLightmapMaterialSamplers(targets.map(target => target.primitive), undefined, true)
    : new Map();
  const acceleration = buildSceneAcceleration(targets, samplers);
  const fingerprints = targets.map((target, index) => fingerprintTarget(target, index));
  const sceneBounds = unionBounds(fingerprints.map(item => item.bounds));
  const plan = planProbeGrid(sceneBounds, options.quality);
  const triangles = targets.reduce((sum, target) => {
    const cornerCount = target.indices?.getCount() ?? target.position.getCount();
    return sum + Math.floor(cornerCount / 3);
  }, 0);
  return {
    plan, options, preset, targets: targets.length, triangles, sceneBounds, fingerprints, acceleration,
    dispose: () => acceleration.geometry?.dispose(),
  };
}

/** 影响某区域且启用的灯(影响域不相交的灯不进哈希也不进烘焙,是未变区域字节复用的前提)。 */
function regionAffectedLights(prepared: PreparedProbeBake, region: ProbeRegionPlan, lights: readonly BakeLightState[]): RegionLight[] {
  return lights
    .filter(light => {
      if (!light.enabled || light.intensity <= 0) return false;
      const influence = lightInfluenceAabb(light, prepared.sceneBounds);
      return influence !== null && boundsOverlap(region, influence);
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(light => ({ light, color: new THREE.Color(light.color) }));
}

/** 区域状态哈希:受影响灯状态 + 相交几何指纹 + 质量参数 + 布局,sha256 十六进制。 */
export function probeRegionStateHash(prepared: PreparedProbeBake, region: ProbeRegionPlan, lights: readonly BakeLightState[]): {
  hash: string; affectedLightIds: string[]; overlappingPrimitives: number;
} {
  const affected = regionAffectedLights(prepared, region, lights);
  const overlapping: string[] = [];
  for (const fingerprint of prepared.fingerprints) {
    if (boundsOverlap(region, fingerprint.bounds)) overlapping.push(fingerprint.hash);
  }
  const preset = prepared.preset;
  const text = [
    `format=${PROBE_RECORD_FORMAT_VERSION}`,
    `layout=${prepared.plan.layout.layoutKey}`,
    `quality=${prepared.options.quality}`,
    `samples=${preset.directionSamples}/${preset.shadowSamples}/${preset.indirectSamples}`,
    `ambient=${prepared.options.ambient}/${prepared.options.ambientColor}`,
    ...affected.map(({ light }) => `light=${JSON.stringify(light)}`),
    ...overlapping.map(hash => `geom=${hash}`),
  ].join("\n");
  return {
    hash: sha256Bytes(new TextEncoder().encode(text)),
    affectedLightIds: affected.map(({ light }) => light.id),
    overlappingPrimitives: overlapping.length,
  };
}

/** 烘焙单个区域;同输入逐位同输出,供增量层缓存复用。 */
export function bakePreparedProbeRegion(prepared: PreparedProbeBake, region: ProbeRegionPlan, lights: readonly BakeLightState[]): ProbeRegionBakeResult {
  const { acceleration, preset, options } = prepared;
  const directionSamples = preset.directionSamples;
  const sampleScale = FOUR_PI / directionSamples;
  const records = new Float32Array(region.probes.length * PROBE_RECORD_FLOATS);
  const bounceScene: BounceScene = {
    epsilon: acceleration.epsilon,
    ...(acceleration.bvh ? { bvh: acceleration.bvh } : {}),
    ...(acceleration.surfaces ? { surfaces: acceleration.surfaces } : {}),
  };
  const scratch = {
    origin: new THREE.Vector3(), ray: new THREE.Ray(),
    direction: new THREE.Vector3(), dirToLight: new THREE.Vector3(),
    jitter: new THREE.Vector3(), tangent: new THREE.Vector3(), bitangent: new THREE.Vector3(),
    hitNormal: new THREE.Vector3(), indirect: new THREE.Vector3(),
    bounce: createBounceScratch(),
  };
  const ambientColor = new THREE.Color(options.ambientColor);
  const affected = regionAffectedLights(prepared, region, lights);
  const started = nowMs();
  region.probes.forEach((probe, probeIndex) => {
    const base = probeIndex * PROBE_RECORD_FLOATS;
    const position = new THREE.Vector3(probe.position[0], probe.position[1], probe.position[2]);
    const phase = probePhase(probe.position);
    let directR = 0, directG = 0, directB = 0, indirectR = 0, indirectG = 0, indirectB = 0, blocked = 0;
    for (let sampleIndex = 0; sampleIndex < directionSamples; sampleIndex += 1) {
      const cosTheta = 1 - (2 * (sampleIndex + 0.5)) / directionSamples;
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = sampleIndex * GOLDEN_ANGLE + phase;
      const direction = scratch.direction.set(Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta);
      let sampleR = 0, sampleG = 0, sampleB = 0;
      for (const { light, color } of affected) {
        const dirToLight = scratch.dirToLight.fromArray(light.type === "point" ? light.position : light.direction);
        if (light.type === "point") dirToLight.sub(position);
        const distance = dirToLight.length();
        if (distance <= acceleration.epsilon) continue;
        dirToLight.normalize();
        const attenuation = light.type === "point" ? Math.pow(Math.max(0, 1 - distance / Math.max(light.range, 0.001)), 2) : 1;
        const cosine = Math.max(0, direction.dot(dirToLight));
        if (cosine <= 0 || attenuation <= 0) continue;
        const visibility = probeLightVisibility(position, dirToLight, light, distance, prepared, scratch);
        if (visibility <= 0) continue;
        const energy = cosine * light.intensity * attenuation * visibility;
        sampleR += color.r * energy; sampleG += color.g * energy; sampleB += color.b * energy;
      }
      directR += sampleR * sampleScale; directG += sampleG * sampleScale; directB += sampleB * sampleScale;
      if (preset.indirectSamples > 0 && acceleration.bvh) {
        const incoming = probeIndirectSample(position, direction, prepared, bounceScene, lights, scratch);
        indirectR += incoming.x * sampleScale; indirectG += incoming.y * sampleScale; indirectB += incoming.z * sampleScale;
      }
      if (isOccluded(position, direction, direction, acceleration.radius * 0.35, acceleration, scratch)) blocked += 1;
    }
    const occlusion = blocked / directionSamples;
    records[base] = directR + ambientColor.r * options.ambient * (1 - occlusion);
    records[base + 1] = directG + ambientColor.g * options.ambient * (1 - occlusion);
    records[base + 2] = directB + ambientColor.b * options.ambient * (1 - occlusion);
    records[base + 3] = indirectR;
    records[base + 4] = indirectG;
    records[base + 5] = indirectB;
    records[base + 6] = occlusion;
    records[base + 7] = 1;
  });
  const { hash, affectedLightIds, overlappingPrimitives } = probeRegionStateHash(prepared, region, lights);
  return {
    key: region.key,
    probeCount: region.probes.length,
    records,
    bytes: new Uint8Array(records.buffer, records.byteOffset, records.byteLength),
    stateHash: hash,
    bakeMs: nowMs() - started,
    affectedLightIds,
    overlappingPrimitives,
  };
}

function probeLightVisibility(position: THREE.Vector3, dirToLight: THREE.Vector3, light: BakeLightState,
  distance: number, prepared: PreparedProbeBake, scratch: {
    origin: THREE.Vector3; ray: THREE.Ray; jitter: THREE.Vector3; tangent: THREE.Vector3; bitangent: THREE.Vector3;
  }): number {
  const { preset, acceleration } = prepared;
  if (!acceleration.bvh || preset.shadowSamples <= 0) return 1;
  let visible = 0;
  for (let sampleIndex = 0; sampleIndex < preset.shadowSamples; sampleIndex += 1) {
    const sampleDirection = preset.shadowSamples === 1
      ? scratch.jitter.copy(dirToLight)
      : jitterToward(dirToLight, sampleIndex, preset.shadowSamples,
          light.type === "directional" ? 0.035 : Math.min(0.12, (light.range / Math.max(distance, 0.001)) * 0.018), scratch);
    if (!isOccluded(position, sampleDirection, sampleDirection, light.type === "point" ? distance : Infinity, acceleration, scratch)) visible += 1;
  }
  return visible / preset.shadowSamples;
}

/** 一跳间接:命中表面 q 的反照率 × q 处单跳反弹辐照(复用贴图烘焙的 diffuseBounce)。 */
function probeIndirectSample(position: THREE.Vector3, direction: THREE.Vector3, prepared: PreparedProbeBake,
  bounceScene: BounceScene, lights: readonly BakeLightState[], scratch: {
    origin: THREE.Vector3; ray: THREE.Ray; hitNormal: THREE.Vector3; indirect: THREE.Vector3; bounce: ReturnType<typeof createBounceScratch>;
  }): THREE.Vector3 {
  scratch.indirect.set(0, 0, 0);
  const { acceleration, preset } = prepared;
  if (!acceleration.bvh) return scratch.indirect;
  const origin = scratch.origin.copy(position).addScaledVector(direction, acceleration.epsilon * 2);
  scratch.ray.set(origin, direction);
  const hit = acceleration.bvh.raycastFirst(scratch.ray, THREE.DoubleSide, acceleration.epsilon, Infinity);
  const surface = hit?.face ? acceleration.surfaces?.[Math.floor(hit.face.a / 3)] : undefined;
  if (!hit || !hit.face || !surface) return scratch.indirect;
  const normal = scratch.hitNormal.copy(hit.face.normal).normalize();
  if (normal.dot(direction) > 0) {
    if (!surface.doubleSided) return scratch.indirect;
    normal.negate();
  }
  diffuseBounce(hit.point, normal, preset.indirectSamples, bounceScene, lights, scratch.indirect, scratch.bounce);
  return scratch.indirect.multiply(surface.diffuse);
}

// 与 lightmapIndirect.diffuseBounce 同一套黄金角抖动与基向量约定;tangent/bitangent 专用向量避免原地突变串扰。
function jitterToward(direction: THREE.Vector3, index: number, count: number, spread: number, scratch: {
  jitter: THREE.Vector3; tangent: THREE.Vector3; bitangent: THREE.Vector3;
}): THREE.Vector3 {
  const angle = index * GOLDEN_ANGLE;
  const radius = Math.sqrt((index + 0.5) / count) * spread;
  const tangent = Math.abs(direction.z) < 0.999 ? scratch.tangent.set(0, 0, 1).cross(direction).normalize() : scratch.tangent.set(1, 0, 0);
  const bitangent = scratch.bitangent.copy(direction).cross(tangent);
  return scratch.jitter.copy(direction)
    .addScaledVector(tangent, Math.cos(angle) * radius)
    .addScaledVector(bitangent, Math.sin(angle) * radius)
    .normalize();
}

function probePhase(position: readonly [number, number, number]): number {
  const value = Math.sin(position[0] * 12.9898 + position[1] * 78.233 + position[2] * 37.719) * 43758.5453;
  return (value - Math.floor(value)) * Math.PI * 2;
}

function fingerprintTarget(target: PrimitiveBakeTarget, index: number): ProbeTargetFingerprint {
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  const value: number[] = [];
  const parts: Uint8Array[] = [];
  const pushBytes = (array: ArrayBufferView) => parts.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  for (let vertex = 0; vertex < target.position.getCount(); vertex += 1) {
    target.position.getElement(vertex, value);
    point.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0).applyMatrix4(target.matrix);
    bounds.expandByPoint(point);
  }
  pushBytes(new Float64Array(target.matrix.elements));
  const positions = target.position.getArray();
  const normals = target.normal.getArray();
  if (positions) pushBytes(positions);
  if (normals) pushBytes(normals);
  const indices = target.indices?.getArray();
  if (indices) pushBytes(indices);
  const material = target.primitive.getMaterial();
  const materialText = material
    ? [material.getName(), material.getBaseColorFactor().join(","), material.getEmissiveFactor().join(","),
        material.getMetallicFactor(), material.getRoughnessFactor(), String(material.getDoubleSided()), material.getAlphaMode(),
        material.getBaseColorTexture()?.getName() ?? "-", material.getBaseColorTexture()?.getMimeType() ?? "-",
        material.getEmissiveTexture()?.getName() ?? "-"].join("|")
    : "none";
  const header = new TextEncoder().encode(`p=${index};m=${materialText};v=${target.position.getCount()}`);
  const total = header.byteLength + parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  merged.set(header, offset); offset += header.byteLength;
  for (const part of parts) { merged.set(part, offset); offset += part.byteLength; }
  return {
    hash: sha256Bytes(merged),
    bounds: { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] },
  };
}

function unionBounds(bounds: readonly ProbeAabb[]): ProbeAabb {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const box of bounds) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, box.min[axis]!);
      max[axis] = Math.max(max[axis]!, box.max[axis]!);
    }
  }
  return { min, max };
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}
