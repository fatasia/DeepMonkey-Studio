import type { LodCamera, LodViewport } from "../spatial/lodTypes.js";
import {
  GPU_LOD_FLAG_DRAWABLE,
  GPU_LOD_FLAG_HISTORY_RESET,
  GPU_LOD_FLAG_VISIBLE,
  GPU_LOD_LEVEL_STRIDE,
  GPU_LOD_MAX_LEVELS,
  GPU_LOD_OBJECT_STRIDE,
  GPU_LOD_OUTPUT_STRIDE,
  GPU_LOD_UNAVAILABLE,
  type GpuLodReferenceRecord,
  type GpuLodReferenceResult,
  type PackedGpuLodScene,
} from "./gpuLodTypes.js";
import { validateGpuLodCamera } from "./gpuLodValidation.js";

export function selectGpuLodReference(scene: PackedGpuLodScene, camera: LodCamera, viewport: LodViewport,
  previousLevels?: Uint32Array, historyReset = previousLevels === undefined): GpuLodReferenceResult {
  validatePackedScene(scene);
  if (previousLevels && previousLevels.length < scene.count) throw new RangeError("GPU LOD previous-level array is too small.");
  const view = validateGpuLodCamera(camera, viewport);
  const objectsF = new Float32Array(scene.objectData), objectsU = new Uint32Array(scene.objectData);
  const levelsF = new Float32Array(scene.levelData), levelsU = new Uint32Array(scene.levelData);
  const packedRecords = new ArrayBuffer(scene.count * GPU_LOD_OUTPUT_STRIDE);
  const outputF = new Float32Array(packedRecords), outputU = new Uint32Array(packedRecords);
  const next = new Uint32Array(scene.count), records: GpuLodReferenceRecord[] = [];
  for (let objectIndex = 0; objectIndex < scene.count; objectIndex += 1) {
    const objectBase = objectIndex * GPU_LOD_OBJECT_STRIDE / 4;
    const levelCount = objectsU[objectBase + 4]!;
    const residency = objectsU[objectBase + 5]!;
    const instanceIndex = objectsU[objectBase + 6]!;
    const hysteresis = objectsF[objectBase + 7]!;
    const center = [objectsF[objectBase]!, objectsF[objectBase + 1]!, objectsF[objectBase + 2]!] as const;
    const radius = objectsF[objectBase + 3]!;
    const depth = dotF32([sub(center[0], view.position[0]), sub(center[1], view.position[1]), sub(center[2], view.position[2])], view.forward);
    const visible = add(depth, radius) >= view.near && sub(depth, radius) <= view.far;
    const pixelsPerWorldUnit = !visible ? 0 : view.projectionMode === 1 ? view.projectionScale
      : div(view.projectionScale, Math.max(depth, view.near));
    const diameter = mul(mul(2, radius), pixelsPerWorldUnit);
    let baseLevel = levelCount - 1;
    for (let level = 0; level < levelCount; level += 1) {
      if (diameter >= levelFloat(levelsF, objectIndex, level, 0)) { baseLevel = level; break; }
    }
    let desiredLevel = baseLevel;
    const previous = previousLevels?.[objectIndex] ?? GPU_LOD_UNAVAILABLE;
    if (!historyReset && previous < levelCount) desiredLevel = hysteresisLevel(levelsF, objectIndex, previous, baseLevel, diameter, hysteresis);
    next[objectIndex] = desiredLevel;
    let selectedLevel = GPU_LOD_UNAVAILABLE;
    if (visible) for (let level = desiredLevel; level < levelCount; level += 1) {
      if ((residency & 1 << level) !== 0) { selectedLevel = level; break; }
    }
    const selectedBase = selectedLevel === GPU_LOD_UNAVAILABLE ? -1 : levelWordBase(objectIndex, selectedLevel);
    const triangles = selectedBase < 0 ? 0 : levelsU[selectedBase + 2]!;
    const meshletOffset = selectedBase < 0 ? 0 : levelsU[selectedBase + 3]!;
    const meshletCount = selectedBase < 0 ? 0 : levelsU[selectedBase + 4]!;
    const projectedErrorPixels = selectedBase < 0 ? 0 : mul(levelsF[selectedBase + 1]!, pixelsPerWorldUnit);
    const flags = (visible ? GPU_LOD_FLAG_VISIBLE : 0) | (selectedBase >= 0 ? GPU_LOD_FLAG_DRAWABLE : 0)
      | (historyReset ? GPU_LOD_FLAG_HISTORY_RESET : 0);
    writeRecord(outputF, outputU, objectIndex, [baseLevel, desiredLevel, selectedLevel, flags],
      [triangles, meshletOffset, meshletCount, instanceIndex], [diameter, projectedErrorPixels, pixelsPerWorldUnit, depth]);
    records.push(Object.freeze({ objectIndex, baseLevel, desiredLevel,
      selectedLevel: selectedLevel === GPU_LOD_UNAVAILABLE ? null : selectedLevel, instanceIndex, flags,
      projectedDiameterPixels: diameter, projectedErrorPixels, pixelsPerWorldUnit, depth,
      triangles, meshletOffset, meshletCount }));
  }
  return Object.freeze({ records: Object.freeze(records), packedRecords, nextPreviousLevels: next });
}

export function decodeGpuLodRecords(data: ArrayBuffer, count: number): readonly GpuLodReferenceRecord[] {
  if (!Number.isSafeInteger(count) || count < 0 || data.byteLength < count * GPU_LOD_OUTPUT_STRIDE) throw new RangeError("GPU LOD record data is too small.");
  const floats = new Float32Array(data), uints = new Uint32Array(data), records: GpuLodReferenceRecord[] = [];
  for (let objectIndex = 0; objectIndex < count; objectIndex += 1) {
    const base = objectIndex * GPU_LOD_OUTPUT_STRIDE / 4, selected = uints[base + 2]!;
    records.push(Object.freeze({ objectIndex, baseLevel: uints[base]!, desiredLevel: uints[base + 1]!,
      selectedLevel: selected === GPU_LOD_UNAVAILABLE ? null : selected, flags: uints[base + 3]!,
      triangles: uints[base + 4]!, meshletOffset: uints[base + 5]!, meshletCount: uints[base + 6]!, instanceIndex: uints[base + 7]!,
      projectedDiameterPixels: floats[base + 8]!, projectedErrorPixels: floats[base + 9]!,
      pixelsPerWorldUnit: floats[base + 10]!, depth: floats[base + 11]! }));
  }
  return Object.freeze(records);
}

function hysteresisLevel(levels: Float32Array, object: number, previous: number, base: number, diameter: number, ratio: number): number {
  let level = previous;
  while (level > base) {
    const threshold = levelFloat(levels, object, level - 1, 0);
    if (diameter < mul(threshold, add(1, ratio))) break;
    level -= 1;
  }
  while (level < base) {
    const threshold = levelFloat(levels, object, level, 0);
    if (diameter >= mul(threshold, sub(1, ratio))) break;
    level += 1;
  }
  return level;
}

function writeRecord(floats: Float32Array, uints: Uint32Array, index: number, selection: readonly number[], meshlets: readonly number[], metrics: readonly number[]): void {
  const base = index * GPU_LOD_OUTPUT_STRIDE / 4;
  uints.set(selection, base); uints.set(meshlets, base + 4); floats.set(metrics.map(Math.fround), base + 8);
}

function levelWordBase(object: number, level: number): number {
  return (object * GPU_LOD_MAX_LEVELS + level) * GPU_LOD_LEVEL_STRIDE / 4;
}
function levelFloat(levels: Float32Array, object: number, level: number, offset: number): number { return levels[levelWordBase(object, level) + offset]!; }
const add = (left: number, right: number): number => Math.fround(Math.fround(left) + Math.fround(right));
const sub = (left: number, right: number): number => Math.fround(Math.fround(left) - Math.fround(right));
const mul = (left: number, right: number): number => Math.fround(Math.fround(left) * Math.fround(right));
const div = (left: number, right: number): number => Math.fround(Math.fround(left) / Math.fround(right));
function dotF32(left: readonly number[], right: readonly number[]): number {
  return add(add(mul(left[0]!, right[0]!), mul(left[1]!, right[1]!)), mul(left[2]!, right[2]!));
}
function validatePackedScene(scene: PackedGpuLodScene): void {
  if (scene.count < 0 || scene.objectStride !== GPU_LOD_OBJECT_STRIDE || scene.levelStride !== GPU_LOD_LEVEL_STRIDE || scene.levelSlots !== GPU_LOD_MAX_LEVELS
    || scene.objectData.byteLength !== scene.count * GPU_LOD_OBJECT_STRIDE
    || scene.levelData.byteLength !== scene.count * GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE) throw new RangeError("Packed GPU LOD scene ABI is invalid.");
}
