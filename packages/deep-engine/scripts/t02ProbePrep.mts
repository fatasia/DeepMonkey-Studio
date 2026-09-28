import { buildReferenceRoomScene, referenceSceneDiagonal, referenceThinWallBoxes,
} from "../src/lighting/probeReferenceScene.ts";
import { buildReferenceRenderPacket } from "../src/lighting/probeReferenceRenderPacket.ts";
import { budgetRecoverySchedule,
  PRODUCER_SHADING_PI_SCALE } from "../src/lighting/probeGpuJointAnalysis.ts";
import { evaluateProbeRadianceEngineParity, integrateProbeReference } from "../src/lighting/probeReferenceIntegrator.ts";
import { packIrradianceProbeRecord, type IrradianceProbeRecord } from "../src/lighting/probeClipmapSampling.ts";
import { DEEP_GI_PROBE_RECORD_BYTES } from "../src/lighting/probeClipmapPlan.ts";
import { computeProbeRelocation } from "../src/lighting/probeRelocation.ts";
import { buildRenderPacketRayScene, RENDER_PACKET_GI_RAY_MASK } from "../src/rayTracing/renderPacketRayScene.ts";
import { packTlasScene } from "../src/rayTracing/tlasLayout.ts";
import { packProbeRadianceProbeParams, packProbeRadianceUniform } from "../src/rayTracing/probeRadianceKernel.ts";
import { probeOcclusionDirection } from "../src/rayTracing/probeOcclusionRayExtension.ts";
import { traceTlasClosest } from "../src/rayTracing/tlas.ts";

/**
 * T02 联测 CPU 备料（纯 CPU、确定性）：参考场景 → RenderPacket → 打包 TLAS、
 * RenderPacket 路径 CPU 权威探针值（fib8/16/32）、MC 参考（4096 分层，seed 固定）、
 * 埋入判定、π 尺度补偿 uniform（含逐帧批量）、逐帧预算排程、墙内接收点与记录打包、
 * GPU 读回解码（f16 → 探针 RGB，已是参考尺度）。
 */
export const MC_SEED = 20260927, MC_SAMPLES = 4096;
export const GRID = [7, 2, 5] as const;
export const CAMERA: [number, number, number] = [4, 1.5, 3];
export const PROBE_PARAM_BYTES = 32;
export const CAPTURE_BYTES_PER_ROW = 256;
export const CAPTURE_BUFFER_BYTES = CAPTURE_BYTES_PER_ROW * GRID[1]! * GRID[2]!;
export const directionCounts = [8, 16, 32] as const;

export function prepareT02ProbeJoint() {
  const scene = buildReferenceRoomScene();
  const packet = buildReferenceRenderPacket(scene);
  const rayScene = buildRenderPacketRayScene(packet);
  const packed = packTlasScene(rayScene.tlas);
  const tMax = referenceSceneDiagonal(scene);
  const positions: [number, number, number][] = [];
  for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
    positions.push([x, y, z]);
  }
  const albedoOf = new Map(rayScene.materials.map(binding => {
    const material = packet.materials.find(candidate => candidate.id === binding.material.id)!;
    return [binding.instanceId, material.baseColor] as const;
  }));
  // RenderPacket 路径 CPU 权威探针值（与 lab/probeRadianceGpuProbe 同公式；参考尺度）。
  const packetProbe = (position: [number, number, number], count: number) => {
    const sum = [0, 0, 0]; const distances: number[] = [];
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const [dx, dy, dz] = probeOcclusionDirection(ordinal, count);
      const hit = traceTlasClosest(rayScene.tlas, { ox: position[0], oy: position[1], oz: position[2],
        dx, dy, dz, tMax }, RENDER_PACKET_GI_RAY_MASK);
      if (!hit) { sum[0] += scene.ambient[0]!; sum[1] += scene.ambient[1]!; sum[2] += scene.ambient[2]!; continue; }
      distances.push(hit.t);
      const albedo = albedoOf.get(hit.instanceId)!;
      const instance = packet.instances.find(candidate => candidate.id === hit.instanceId)!;
      const geometry = packet.geometries.find(candidate => candidate.id === instance.geometry)!;
      const at = (corner: number): number[] => {
        const base = geometry.indices[hit.primitiveIndex * 3 + corner]! * 6;
        return [geometry.vertices[base]!, geometry.vertices[base + 1]!, geometry.vertices[base + 2]!];
      };
      const [a, b, c] = [at(0), at(1), at(2)];
      let nx = (b[1]! - a[1]!) * (c[2]! - a[2]!) - (b[2]! - a[2]!) * (c[1]! - a[1]!);
      let ny = (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!);
      let nz = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
      const length = Math.hypot(nx, ny, nz); nx /= length; ny /= length; nz /= length;
      if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
      const nDotL = Math.max(nx * scene.light.surfaceToLightWorld[0]!
        + ny * scene.light.surfaceToLightWorld[1]! + nz * scene.light.surfaceToLightWorld[2]!, 0);
      sum[0] += albedo[0] * nDotL; sum[1] += albedo[1] * nDotL; sum[2] += albedo[2] * nDotL;
    }
    const meanDistance = distances.length > 0
      ? distances.reduce((total, value) => total + value, 0) / distances.length : tMax;
    const variance = distances.length > 1
      ? distances.reduce((total, value) => total + (value - meanDistance) ** 2, 0) / distances.length : 0;
    return { irradiance: sum.map(value => value / count) as [number, number, number],
      missRatio: 1 - distances.length / count, meanDistance, variance };
  };
  const parity = Object.fromEntries([8, 16, 32].map(count => [count,
    positions.map(position => packetProbe(position, count))])) as Record<number,
    ReturnType<typeof packetProbe>[]>;
  // 埋入判定（wall-leak 同判据：全命中 + 平均距离 ≤ 0.2）；packets/slabs 两路径互证。
  const buried = parity[8].map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => sample.missRatio === 0 && sample.meanDistance <= 0.2).map(entry => entry.index);
  const buriedScene = positions.map((position, index) => index)
    .filter(index => {
      const sample = evaluateProbeRadianceEngineParity(scene, positions[index]!, 8);
      return sample.missRatio === 0 && sample.meanDistance <= 0.2; });
  const reference = positions.map(position => integrateProbeReference(scene, position,
    { sampleCount: MC_SAMPLES, seed: MC_SEED }));
  const truthShadowed = positions.map(position => integrateProbeReference(scene, position,
    { sampleCount: 2048, seed: 99, shadowed: true }).irradiance);
  const mcField = reference.map(sample => sample.irradiance);
  const stable = reference.map(sample => sample.stable);
  const includeProbe = (index: number): boolean => !buried.includes(index) && stable[index]!;
  // relocation 自检：埋入探针沿最薄轴逸出（CPU 既有能力，联测一并复核）。
  const thinWalls = referenceThinWallBoxes(scene);
  const relocation = buried.map(index => computeProbeRelocation({
    cellPosition: positions[index]!, spacing: 1, obstacles: thinWalls, maxOffset: 0.5, margin: 0.2 }));
  return { scene, packet, rayScene, packed, tMax, positions, parity, buried, buriedScene,
    reference, mcField, stable, includeProbe, truthShadowed, relocation };
}

// π 尺度补偿：生产内核命中项 = albedo·(I/π)·max(N·L̂,0)，参考功能量 = albedo·max(N·L,0)
//（L 为场景未归一化光向量，|L|≈1.0377）。取 I = π·|L|·intensity、ambient 原样直传
//（内核 miss 项不除 π），则 GPU 输出与参考功能量逐项同尺度，读回无需任何缩放。
export const toBase64 = (data: ArrayBuffer | ArrayBufferView): string =>
  data instanceof ArrayBuffer ? Buffer.from(data).toString("base64")
    : Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength).toString("base64");

export function uniformInput(scene: ReturnType<typeof buildReferenceRoomScene>,
  updateCount: number, intensity: number, directions: number) {
  const light = scene.light.surfaceToLightWorld;
  const length = Math.hypot(light[0], light[1], light[2]);
  return {
    updateCount, directionCount: directions, rayMask: RENDER_PACKET_GI_RAY_MASK,
    tMax: referenceSceneDiagonal(scene),
    surfaceToLight: [light[0]! / length, light[1]! / length, light[2]! / length] as [number, number, number],
    lightColor: [1, 1, 1] as [number, number, number],
    lightIntensity: PRODUCER_SHADING_PI_SCALE * length * intensity,
    ambient: [scene.ambient[0]!, scene.ambient[1]!, scene.ambient[2]!] as [number, number, number],
    directions: Array.from({ length: directions }, (_, ordinal) =>
      probeOcclusionDirection(ordinal, directions)),
  };
}

export function packUniform(scene: ReturnType<typeof buildReferenceRoomScene>,
  updateCount: number, intensity: number, directions: number): Uint8Array {
  const input = uniformInput(scene, updateCount, intensity, directions);
  return new Uint8Array(packProbeRadianceUniform(input));
}

export function packProbeParams(positions: readonly [number, number, number][],
  indices: readonly number[]): Uint8Array {
  return new Uint8Array(packProbeRadianceProbeParams(indices.map(index => ({
    position: positions[index]!, layer: positions[index]![2]! - 1,
    cellX: positions[index]![0]! - 1, cellY: positions[index]![1]! - 1 }))));
}

/** 逐帧预算排程（调度器同序）+ 每帧 uniform（updateCount=批量）与探针参数。 */
export function buildFrames(scene: ReturnType<typeof buildReferenceRoomScene>,
  positions: readonly [number, number, number][], budgets: readonly number[]) {
  const dirtyAll = positions.map((_, index) => index);
  const frames: { budget: number; batch: number[]; uniformB64: string; paramsB64: string }[] = [];
  for (const budget of budgets) {
    for (const batch of budgetRecoverySchedule(positions, dirtyAll, CAMERA, budget)) {
      frames.push({ budget, batch, uniformB64: toBase64(packUniform(scene, batch.length, 2, 32)),
        paramsB64: toBase64(packProbeParams(positions, batch)) });
    }
  }
  return frames;
}

export function packRecords(records: readonly IrradianceProbeRecord[]): Uint8Array {
  const bytes = new Uint8Array(records.length * DEEP_GI_PROBE_RECORD_BYTES);
  records.forEach((record, index) => bytes.set(
    new Uint8Array(packIrradianceProbeRecord(record)), index * DEEP_GI_PROBE_RECORD_BYTES));
  return bytes;
}

/** GPU f16 读回 → 70 探针 RGB（π 补偿已由 uniform 承担，读回即参考尺度）。 */
export function decodeProbeField(bytes: Uint8Array, probeCount: number): [number, number, number][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < words.length; index++) {
    const bits = view.getUint16(index * 2, true);
    const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
    words[index] = sign * (exponent === 0 ? fraction * 2 ** -24
      : (1 + fraction / 1024) * 2 ** (exponent - 15));
  }
  const rowHalfWords = CAPTURE_BYTES_PER_ROW / 2, layerHalfWords = rowHalfWords * GRID[1]!;
  const fields: [number, number, number][] = [];
  for (let probe = 0; probe < probeCount; probe++) {
    const x = probe % GRID[0]!, y = Math.floor(probe / GRID[0]!) % GRID[1]!,
      z = Math.floor(probe / (GRID[0]! * GRID[1]!));
    const base = z * layerHalfWords + y * rowHalfWords + x * 4;
    fields.push([words[base]!, words[base + 1]!, words[base + 2]!]);
  }
  return fields;
}
