import {
  GPU_LOD_LEVEL_STRIDE,
  GPU_LOD_MAX_LEVELS,
  GPU_LOD_MAX_OBJECTS,
  GPU_LOD_OBJECT_STRIDE,
  type GpuLodLevelSource,
  type GpuLodObjectSource,
  type PackedGpuLodScene,
} from "./gpuLodTypes.js";

const MAX_U32 = 0xffff_ffff;
const DEFAULT_HYSTERESIS = 0.12;

export function packGpuLodScene(objects: readonly GpuLodObjectSource[], defaultHysteresisRatio = DEFAULT_HYSTERESIS): PackedGpuLodScene {
  finiteRange(defaultHysteresisRatio, 0, 0.49, "default hysteresis ratio");
  if (objects.length > GPU_LOD_MAX_OBJECTS) throw new RangeError(`GPU LOD object count exceeds ${GPU_LOD_MAX_OBJECTS}.`);
  const objectData = new ArrayBuffer(objects.length * GPU_LOD_OBJECT_STRIDE);
  const levelData = new ArrayBuffer(objects.length * GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE);
  const objectFloats = new Float32Array(objectData), objectUints = new Uint32Array(objectData);
  const levelFloats = new Float32Array(levelData), levelUints = new Uint32Array(levelData);
  objects.forEach((object, objectIndex) => {
    validateObject(object, objectIndex);
    const [center, radius] = sourceSphere(object);
    const packedCenter = center.map(Math.fround);
    const centerError = Math.hypot(center[0]! - packedCenter[0]!, center[1]! - packedCenter[1]!, center[2]! - packedCenter[2]!);
    const base = objectIndex * GPU_LOD_OBJECT_STRIDE / 4;
    objectFloats.set([packedCenter[0]!, packedCenter[1]!, packedCenter[2]!, conservativeF32(radius + centerError)], base);
    objectUints[base + 4] = object.levels.length;
    objectUints[base + 5] = residencyMask(object.levels);
    objectUints[base + 6] = object.instanceIndex;
    objectFloats[base + 7] = Math.fround(object.hysteresisRatio ?? defaultHysteresisRatio);
    object.levels.forEach((level, levelIndex) => {
      const levelBase = (objectIndex * GPU_LOD_MAX_LEVELS + levelIndex) * GPU_LOD_LEVEL_STRIDE / 4;
      levelFloats[levelBase] = Math.fround(level.minProjectedDiameterPixels);
      levelFloats[levelBase + 1] = Math.fround(level.geometricError);
      levelUints[levelBase + 2] = level.triangles;
      levelUints[levelBase + 3] = level.meshletOffset;
      levelUints[levelBase + 4] = level.meshletCount;
    });
  });
  return Object.freeze({ objectData, levelData, count: objects.length, objectStride: GPU_LOD_OBJECT_STRIDE,
    levelStride: GPU_LOD_LEVEL_STRIDE, levelSlots: GPU_LOD_MAX_LEVELS });
}

function validateObject(object: GpuLodObjectSource, objectIndex: number): void {
  if (!object || typeof object !== "object") throw new TypeError(`GPU LOD object ${objectIndex} is invalid.`);
  if ((object.bounds === undefined) === (object.sphere === undefined)) {
    throw new TypeError(`GPU LOD object ${objectIndex} must supply exactly one bound representation.`);
  }
  sourceSphere(object);
  uint(object.instanceIndex, `GPU LOD object ${objectIndex} instance index`);
  const hysteresis = object.hysteresisRatio;
  if (hysteresis !== undefined) finiteRange(hysteresis, 0, 0.49, `GPU LOD object ${objectIndex} hysteresis ratio`);
  if (!Array.isArray(object.levels) || object.levels.length < 1 || object.levels.length > GPU_LOD_MAX_LEVELS) {
    throw new RangeError(`GPU LOD object ${objectIndex} must have 1-${GPU_LOD_MAX_LEVELS} levels.`);
  }
  object.levels.forEach((level, levelIndex) => validateLevel(level, objectIndex, levelIndex));
  for (let index = 1; index < object.levels.length; index += 1) {
    const finer = object.levels[index - 1]!, coarser = object.levels[index]!;
    if (Math.fround(finer.minProjectedDiameterPixels) <= Math.fround(coarser.minProjectedDiameterPixels)) {
      throw new RangeError(`GPU LOD object ${objectIndex} thresholds must strictly decrease after float32 conversion.`);
    }
    if (finer.geometricError > coarser.geometricError) throw new RangeError(`GPU LOD object ${objectIndex} geometric errors must not decrease.`);
    if (finer.triangles <= coarser.triangles) throw new RangeError(`GPU LOD object ${objectIndex} triangle counts must strictly decrease.`);
  }
  if (object.levels.at(-1)!.minProjectedDiameterPixels !== 0) throw new RangeError(`GPU LOD object ${objectIndex} final threshold must be zero.`);
}

function sourceSphere(object: GpuLodObjectSource): [readonly number[], number] {
  if (object.sphere) {
    if (object.sphere.length !== 4 || !object.sphere.every(Number.isFinite) || object.sphere[3] < 0
      || object.sphere.some(value => Math.abs(value) > 1e15)) throw new RangeError("GPU LOD object sphere is invalid.");
    return [[object.sphere[0], object.sphere[1], object.sphere[2]], object.sphere[3]];
  }
  const bounds = object.bounds!;
  if (!bounds || bounds.min.length !== 3 || bounds.max.length !== 3) throw new TypeError("GPU LOD object bounds are invalid.");
  for (let axis = 0; axis < 3; axis++) {
    const min = bounds.min[axis]!, max = bounds.max[axis]!;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new RangeError("GPU LOD object bounds are invalid.");
    if (Math.abs(min) > 1e15 || Math.abs(max) > 1e15) throw new RangeError("GPU LOD object bounds exceed the numeric limit.");
  }
  const center = [0, 1, 2].map(axis => (bounds.min[axis]! + bounds.max[axis]!) * 0.5);
  const half = [0, 1, 2].map(axis => (bounds.max[axis]! - bounds.min[axis]!) * 0.5);
  return [center, Math.hypot(...half)];
}

function validateLevel(level: GpuLodLevelSource, objectIndex: number, levelIndex: number): void {
  finiteRange(level.minProjectedDiameterPixels, 0, 1e9, `GPU LOD object ${objectIndex} level ${levelIndex} threshold`);
  finiteRange(level.geometricError, 0, 1e15, `GPU LOD object ${objectIndex} level ${levelIndex} error`);
  uint(level.triangles, `GPU LOD object ${objectIndex} level ${levelIndex} triangle count`, true);
  uint(level.meshletOffset, `GPU LOD object ${objectIndex} level ${levelIndex} meshlet offset`);
  uint(level.meshletCount, `GPU LOD object ${objectIndex} level ${levelIndex} meshlet count`, true);
  if (level.meshletOffset > MAX_U32 - level.meshletCount) throw new RangeError(`GPU LOD object ${objectIndex} level ${levelIndex} meshlet range overflows uint32.`);
  if (level.resident !== undefined && typeof level.resident !== "boolean") throw new TypeError(`GPU LOD object ${objectIndex} level ${levelIndex} residency is invalid.`);
}

function residencyMask(levels: readonly GpuLodLevelSource[]): number {
  let mask = 0;
  levels.forEach((level, index) => { if (level.resident !== false) mask |= 1 << index; });
  return mask >>> 0;
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} is invalid.`);
}

function uint(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_U32) throw new RangeError(`${label} is invalid.`);
}

function conservativeF32(value: number): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new RangeError("GPU LOD bound radius exceeds float32.");
  if (rounded >= value) return rounded;
  const data = new Float32Array([rounded]);
  const bits = new Uint32Array(data.buffer); bits[0] = bits[0]! + 1;
  return data[0]!;
}
