import {
  DEEP_GI_PROBE_LEVEL_BYTES, DEEP_GI_PROBE_RECORD_BYTES, DEEP_GI_PROBE_UPDATE_BYTES,
  type ProbeClipmapLevel, type ProbeClipmapPlan, type ProbeClipmapProfile, type ProbeUpdate,
} from "./probeClipmapPlan.js";

const I32_MIN = -2_147_483_648, I32_MAX = 2_147_483_647;
const reasons = new Set(["pending", "dirty", "scroll", "initial"]);

export function validateProbeClipmapResourcePlan(plan: ProbeClipmapPlan, device: GPUDevice): void {
  if (!plan || typeof plan !== "object" || !plan.profile || !Array.isArray(plan.levels)
    || !Array.isArray(plan.updates)) throw new TypeError("Probe clipmap plan is invalid.");
  const p = plan.profile, grid = p.gridSize;
  if (!Array.isArray(grid) || grid.length !== 3
    || grid.some(value => !Number.isSafeInteger(value) || value < 2 || value > 64)
    || !Number.isSafeInteger(p.levelCount) || p.levelCount < 2 || p.levelCount > 4
    || !Number.isFinite(p.baseSpacing) || p.baseSpacing <= 0
    || !Number.isFinite(p.spacingScale) || p.spacingScale <= 1
    || plan.levels.length !== p.levelCount || !Number.isSafeInteger(p.updateBudget)
    || p.updateBudget < 1 || p.updateBudget > 65_536 || plan.updates.length > p.updateBudget) {
    throw new RangeError("Probe clipmap plan bounds are invalid.");
  }
  const perLevel = grid[0] * grid[1] * grid[2], count = perLevel * p.levelCount;
  const storage = count * DEEP_GI_PROBE_RECORD_BYTES, updates = p.updateBudget * DEEP_GI_PROBE_UPDATE_BYTES;
  const metadata = p.levelCount * DEEP_GI_PROBE_LEVEL_BYTES, total = storage + updates + metadata;
  if (![count, storage, updates, metadata, total].every(Number.isSafeInteger) || count > 65_536
    || p.probeCount !== count || p.probeStorageBytes !== storage || p.updateListBytes !== updates
    || p.levelMetadataBytes !== metadata || p.estimatedBytes !== total) {
    throw new RangeError("Probe clipmap byte evidence is inconsistent.");
  }
  const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  if (!Number.isSafeInteger(limit) || Math.max(storage, updates, metadata) > limit) {
    throw new RangeError("Probe clipmap buffers exceed device storage limits.");
  }
  plan.levels.forEach((level, index) => validateLevel(level, p, index));
  const seen = new Set<string>();
  plan.updates.forEach((update, index) => validateUpdate(update, plan.levels, grid, seen, index));
}

function validateLevel(level: ProbeClipmapLevel, profile: ProbeClipmapProfile, index: number): void {
  const spacing = profile.baseSpacing * profile.spacingScale ** index;
  if (!level || level.level !== index || level.spacing !== spacing || !Number.isFinite(spacing)
    || !Number.isFinite(Math.fround(spacing))
    || level.gridSize.some((value, axis) => value !== profile.gridSize[axis])
    || level.probeCount !== profile.gridSize[0] * profile.gridSize[1] * profile.gridSize[2]
    || !integerVector(level.originCell, I32_MIN, I32_MAX) || !finiteVector(level.origin)
    || !finiteVector(level.max)
    || level.origin.some((value, axis) => value !== level.originCell[axis]! * spacing)
    || level.max.some((value, axis) => value !== (level.originCell[axis]! + level.gridSize[axis]! - 1) * spacing)) {
    throw new RangeError(`Probe clipmap level ${index} is invalid.`);
  }
}

function validateUpdate(update: ProbeUpdate, levels: readonly ProbeClipmapLevel[], grid: readonly number[],
  seen: Set<string>, index: number): void {
  const level = levels[update?.level];
  if (!level || !integerVector(update.localCell, 0, 63)
    || update.localCell.some((value, axis) => value >= grid[axis]!)
    || !integerVector(update.cell, I32_MIN, I32_MAX) || !finiteVector(update.position)
    || !reasons.has(update.reason)) throw new RangeError(`Probe clipmap update ${index} is invalid.`);
  const linear = (update.localCell[2] * grid[1]! + update.localCell[1]) * grid[0]! + update.localCell[0];
  const id = `${update.level}:${linear}`;
  if (update.linearIndex !== linear || seen.has(id)
    || update.cell.some((value, axis) => value !== level.originCell[axis]! + update.localCell[axis]!)
    || update.position.some((value, axis) => value !== update.cell[axis]! * level.spacing)) {
    throw new RangeError(`Probe clipmap update ${index} is inconsistent.`);
  }
  seen.add(id);
}

function integerVector(value: unknown, minimum: number, maximum: number): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every(item => Number.isSafeInteger(item) && item >= minimum && item <= maximum);
}
function finiteVector(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item) && Number.isFinite(Math.fround(item)));
}

const DYNAMIC_PROBE_UPDATE_FLAG = 0x8000_0000;

export function packProbeUpdates(updates: readonly ProbeUpdate[],
  dynamicUpdateIndices: readonly number[] = []): ArrayBuffer {
  const dynamic = new Set(dynamicUpdateIndices);
  if (dynamic.size !== dynamicUpdateIndices.length || dynamicUpdateIndices.some(index =>
    !Number.isSafeInteger(index) || index < 0 || index >= updates.length)) {
    throw new RangeError("Dynamic probe update indices are invalid.");
  }
  const values = new Uint32Array(updates.length * 4);
  updates.forEach((update, index) => values.set([
    update.level | (dynamic.has(index) ? DYNAMIC_PROBE_UPDATE_FLAG : 0), ...update.localCell,
  ], index * 4));
  return values.buffer;
}
export function packProbeLevels(levels: readonly ProbeClipmapLevel[]): ArrayBuffer {
  const data = new ArrayBuffer(levels.length * DEEP_GI_PROBE_LEVEL_BYTES);
  const floats = new Float32Array(data), uints = new Uint32Array(data), ints = new Int32Array(data);
  let baseProbe = 0;
  levels.forEach((level, index) => {
    const offset = index * 16;
    floats.set([...level.origin, level.spacing], offset);
    uints.set([...level.gridSize, level.level], offset + 4);
    ints.set(level.originCell, offset + 8); uints[offset + 11] = baseProbe;
    floats.set(level.max, offset + 12); uints[offset + 15] = level.probeCount;
    baseProbe += level.probeCount;
  });
  return data;
}
export function probeProfileSignature(p: ProbeClipmapProfile): string {
  return `${p.levelCount}|${p.gridSize.join("x")}|${p.baseSpacing}|${p.spacingScale}|${p.updateBudget}|${p.estimatedBytes}`;
}
export function sameProbeLevels(left: readonly ProbeClipmapLevel[], right: readonly ProbeClipmapLevel[]): boolean {
  return left.length === right.length && left.every((level, index) => {
    const other = right[index]!;
    return level.spacing === other.spacing && level.originCell.every((value, axis) => value === other.originCell[axis]);
  });
}
