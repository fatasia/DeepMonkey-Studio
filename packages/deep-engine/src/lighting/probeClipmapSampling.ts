import { DEEP_GI_PROBE_LEVEL_BYTES, DEEP_GI_PROBE_RECORD_BYTES,
  type ProbeClipmapLevel, type ProbeClipmapProfile, type ProbeVector3 } from "./probeClipmapPlan.js";
import { DEEP_GI_CASCADE_BLEND_CELLS, DEEP_GI_LEVEL_METADATA_BINDING, DEEP_GI_MAX_PROBE_FETCHES,
  DEEP_GI_MIN_SAMPLE_WEIGHT, DEEP_GI_NORMAL_BIAS_CELLS, DEEP_GI_PROBE_STORAGE_BINDING,
  DEEP_GI_SAMPLING_ABI_VERSION, DEEP_GI_SAMPLING_BIND_GROUP } from "./probeClipmapSamplingWgsl.js";

export interface IrradianceProbeRecord {
  readonly irradiance: ProbeVector3;
  readonly validity: number;
  readonly meanDistance: number;
  readonly distanceVariance: number;
  readonly occlusionFloor?: number;
  readonly positionOffset?: ProbeVector3;
}
export interface ProbeClipmapSampleRequest {
  readonly worldPosition: ProbeVector3;
  readonly worldNormal: ProbeVector3;
  readonly levels: readonly ProbeClipmapLevel[];
  readonly records: readonly (IrradianceProbeRecord | undefined)[];
  readonly environmentFallback?: ProbeVector3;
}
export interface ProbeClipmapSampleResult {
  readonly irradiance: ProbeVector3;
  readonly selectedLevel?: number;
  readonly blendedLevel?: number;
  readonly cascadeBlend: number;
  readonly accumulatedWeight: number;
  readonly sampledProbeCount: number;
  readonly fallback: boolean;
}
export interface ProbeClipmapSamplingBudgetEvidence {
  readonly abiVersion: typeof DEEP_GI_SAMPLING_ABI_VERSION;
  readonly bindGroup: typeof DEEP_GI_SAMPLING_BIND_GROUP;
  readonly storageBindings: readonly [number, number];
  readonly recordBytes: typeof DEEP_GI_PROBE_RECORD_BYTES;
  readonly levelBytes: typeof DEEP_GI_PROBE_LEVEL_BYTES;
  readonly maxProbeFetches: typeof DEEP_GI_MAX_PROBE_FETCHES;
  readonly probeStorageBytes: number;
  readonly levelMetadataBytes: number;
  readonly additionalGpuBytes: 0;
}

export function probeClipmapSamplingBudget(profile: ProbeClipmapProfile): ProbeClipmapSamplingBudgetEvidence {
  return Object.freeze({ abiVersion: DEEP_GI_SAMPLING_ABI_VERSION, bindGroup: DEEP_GI_SAMPLING_BIND_GROUP,
    storageBindings: Object.freeze([DEEP_GI_PROBE_STORAGE_BINDING, DEEP_GI_LEVEL_METADATA_BINDING]) as readonly [number, number],
    recordBytes: DEEP_GI_PROBE_RECORD_BYTES, levelBytes: DEEP_GI_PROBE_LEVEL_BYTES,
    maxProbeFetches: DEEP_GI_MAX_PROBE_FETCHES, probeStorageBytes: profile.probeStorageBytes,
    levelMetadataBytes: profile.levelMetadataBytes, additionalGpuBytes: 0 });
}

export function packIrradianceProbeRecord(record: IrradianceProbeRecord): ArrayBuffer {
  const irradiance = vector(record.irradiance, "irradiance", 0, 65_504);
  const validity = finite(record.validity, "validity", 0, 1);
  const meanDistance = finite(record.meanDistance, "meanDistance", 0, 1_000_000);
  const variance = finite(record.distanceVariance, "distanceVariance", 0, 1_000_000_000_000);
  const floor = finite(record.occlusionFloor ?? 0, "occlusionFloor", 0, 1);
  const relocation = vector(record.positionOffset ?? [0, 0, 0], "positionOffset", -1_000_000, 1_000_000);
  const values = new Float32Array(DEEP_GI_PROBE_RECORD_BYTES / 4);
  values.set([...irradiance, validity], 0); values.set([meanDistance, variance, floor, 0], 4);
  values.set([...relocation, 0], 8); return values.buffer;
}

interface LevelSample { irradiance: ProbeVector3; weight: number; probes: number }

/** CPU reference for bounded 8-probe interpolation and adjacent-level edge blending. */
export function sampleIrradianceProbeClipmap(request: ProbeClipmapSampleRequest): ProbeClipmapSampleResult {
  const position = vector(request.worldPosition, "worldPosition", -1_000_000_000, 1_000_000_000);
  const normalInput = vector(request.worldNormal, "worldNormal", -1_000_000, 1_000_000);
  const fallback = vector(request.environmentFallback ?? [0, 0, 0], "environmentFallback", 0, 65_504);
  const levels = request.levels.slice(0, 4), bases: number[] = []; let base = 0;
  for (const level of levels) { bases.push(base); base += validProbeCount(level); }
  const selected = levels.findIndex(level => contains(level, position));
  if (selected < 0) return result(fallback, undefined, undefined, 0, 0, 0, true);
  const fine = sampleLevel(levels[selected]!, bases[selected]!, position, normalInput, request.records);
  const next = selected + 1;
  if (next < levels.length && contains(levels[next]!, position)) {
    const coarse = sampleLevel(levels[next]!, bases[next]!, position, normalInput, request.records);
    if (fine.weight >= DEEP_GI_MIN_SAMPLE_WEIGHT && coarse.weight >= DEEP_GI_MIN_SAMPLE_WEIGHT) {
      const blend = 1 - smoothstep(0, DEEP_GI_CASCADE_BLEND_CELLS, boundaryCells(levels[selected]!, position));
      return result(mix3(fine.irradiance, coarse.irradiance, blend), selected, next, blend,
        fine.weight * (1 - blend) + coarse.weight * blend, fine.probes + coarse.probes, false);
    }
    if (coarse.weight >= DEEP_GI_MIN_SAMPLE_WEIGHT) {
      return result(coarse.irradiance, next, undefined, 0, coarse.weight, coarse.probes, false);
    }
  }
  if (fine.weight >= DEEP_GI_MIN_SAMPLE_WEIGHT) {
    return result(fine.irradiance, selected, undefined, 0, fine.weight, fine.probes, false);
  }
  return result(fallback, undefined, undefined, 0, 0, 0, true);
}

function sampleLevel(level: ProbeClipmapLevel, base: number, position: ProbeVector3,
  normalInput: ProbeVector3, records: readonly (IrradianceProbeRecord | undefined)[]): LevelSample {
  if (!contains(level, position)) return { irradiance: [0, 0, 0], weight: 0, probes: 0 };
  const coordinate = position.map((value, axis) => (value - level.origin[axis]!) / level.spacing);
  const low = coordinate.map((value, axis) => Math.min(Math.floor(value), level.gridSize[axis]! - 2));
  const fraction = coordinate.map((value, axis) => clamp(value - low[axis]!, 0, 1));
  const normalLength = Math.hypot(...normalInput), normal = normalLength > 1e-6
    ? normalInput.map(value => value / normalLength) : [0, 1, 0];
  const receiver = position.map((value, axis) => value + normal[axis]! * level.spacing * DEEP_GI_NORMAL_BIAS_CELLS);
  const sum = [0, 0, 0]; let total = 0, probes = 0;
  for (let corner = 0; corner < 8; corner++) {
    const bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const cell = low.map((value, axis) => value + bits[axis]!);
    const axisWeight = bits.map((bit, axis) => bit ? fraction[axis]! : 1 - fraction[axis]!);
    const trilinear = axisWeight[0]! * axisWeight[1]! * axisWeight[2]!;
    const linear = (cell[2]! * level.gridSize[1]! + cell[1]!) * level.gridSize[0]! + cell[0]!;
    const record = Number.isSafeInteger(linear) && linear >= 0 && linear < level.probeCount ? records[base + linear] : undefined;
    if (!record || !recordFinite(record) || record.validity <= 0 || trilinear <= 0) continue;
    const offset = record.positionOffset ?? [0, 0, 0], probePosition = cell.map((value, axis) => level.origin[axis]!
      + value * level.spacing + offset[axis]!);
    const visibility = visibilityWeight(record, receiver, probePosition, level.spacing);
    const weight = trilinear * clamp(record.validity, 0, 1) * visibility;
    for (let channel = 0; channel < 3; channel++) sum[channel]! += Math.max(0, record.irradiance[channel]!) * weight;
    total += weight; probes++;
  }
  if (total < DEEP_GI_MIN_SAMPLE_WEIGHT) return { irradiance: [0, 0, 0], weight: 0, probes };
  return { irradiance: [clamp(sum[0]! / total, 0, 65_504), clamp(sum[1]! / total, 0, 65_504),
    clamp(sum[2]! / total, 0, 65_504)], weight: total, probes };
}

function visibilityWeight(record: IrradianceProbeRecord, receiver: readonly number[], probe: readonly number[], spacing: number): number {
  const distance = Math.hypot(...receiver.map((value, axis) => value - probe[axis]!));
  if (distance <= record.meanDistance) return 1;
  const variance = clamp(record.distanceVariance, spacing * spacing * 0.0001, 1_000_000_000_000);
  const delta = distance - record.meanDistance, chebyshev = variance / Math.max(variance + delta * delta, 1e-6);
  return Math.max(clamp(record.occlusionFloor ?? 0, 0, 1), chebyshev);
}
function contains(level: ProbeClipmapLevel, position: ProbeVector3): boolean {
  return usableLevel(level) && position.every((value, axis) => value >= level.origin[axis]! && value <= level.max[axis]!);
}
function usableLevel(level: ProbeClipmapLevel): boolean {
  return Boolean(level) && Number.isFinite(level.spacing) && level.spacing > 0 && level.spacing <= 1_000_000
    && level.gridSize.length === 3 && level.gridSize.every(value => Number.isSafeInteger(value) && value >= 2 && value <= 64)
    && level.origin.every(Number.isFinite) && level.max.every(Number.isFinite) && level.probeCount === validProbeCount(level);
}
function validProbeCount(level: ProbeClipmapLevel): number {
  const count = level.gridSize[0] * level.gridSize[1] * level.gridSize[2]; return Number.isSafeInteger(count) ? count : 0;
}
function recordFinite(record: IrradianceProbeRecord): boolean {
  return record.irradiance.length === 3 && record.irradiance.every(value => Number.isFinite(value) && Math.abs(value) <= 65_504)
    && Number.isFinite(record.validity) && record.validity >= 0 && record.validity <= 1
    && Number.isFinite(record.meanDistance) && record.meanDistance >= 0 && record.meanDistance <= 1_000_000
    && Number.isFinite(record.distanceVariance) && record.distanceVariance >= 0 && record.distanceVariance <= 1_000_000_000_000
    && Number.isFinite(record.occlusionFloor ?? 0) && (record.occlusionFloor ?? 0) >= 0 && (record.occlusionFloor ?? 0) <= 1
    && (record.positionOffset ?? [0, 0, 0]).every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000);
}
function boundaryCells(level: ProbeClipmapLevel, position: ProbeVector3): number {
  const coordinate = position.map((value, axis) => (value - level.origin[axis]!) / level.spacing);
  return Math.min(...coordinate.map((value, axis) => Math.min(value, level.gridSize[axis]! - 1 - value)));
}
function smoothstep(low: number, high: number, value: number): number { const x = clamp((value - low) / (high - low), 0, 1); return x * x * (3 - 2 * x); }
function mix3(left: ProbeVector3, right: ProbeVector3, weight: number): ProbeVector3 {
  return [left[0] + (right[0] - left[0]) * weight, left[1] + (right[1] - left[1]) * weight,
    left[2] + (right[2] - left[2]) * weight];
}
function result(irradiance: ProbeVector3, selectedLevel: number | undefined, blendedLevel: number | undefined,
  cascadeBlend: number, accumulatedWeight: number, sampledProbeCount: number, fallback: boolean): ProbeClipmapSampleResult {
  return Object.freeze({ irradiance: Object.freeze([...irradiance]) as ProbeVector3, ...(selectedLevel === undefined ? {} : { selectedLevel }),
    ...(blendedLevel === undefined ? {} : { blendedLevel }), cascadeBlend, accumulatedWeight, sampledProbeCount, fallback });
}
function vector(value: unknown, path: string, minimum: number, maximum: number): ProbeVector3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number"
    || !Number.isFinite(item) || item < minimum || item > maximum)) throw new RangeError(`${path} must be finite RGB/XYZ within bounds.`);
  return value as unknown as ProbeVector3;
}
function finite(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${path} is out of bounds.`);
  return value;
}
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
