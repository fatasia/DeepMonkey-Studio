import type { MorphBlendOutput, MorphPrimitiveSource, MorphSampleOptions, MorphWeightTrack } from "./types.js";
import { MorphRuntimeError } from "./types.js";

/** Samples one variable-width glTF morph-weight track into a caller-reusable buffer. */
export function sampleMorphWeightTrack(
  track: MorphWeightTrack,
  time: number,
  options: MorphSampleOptions = {},
  output?: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
  validateTrack(track);
  if (!Number.isFinite(time)) throw new MorphRuntimeError("invalid-time", "Morph sample time must be finite.");
  if (!options || typeof options !== "object") throw new MorphRuntimeError("invalid-time", "Morph sample options are invalid.");
  const result = output ?? new Float32Array(track.targetCount);
  if (!(result instanceof Float32Array) || result.length !== track.targetCount) {
    throw new MorphRuntimeError("invalid-output", "Morph sample output must be a target-sized Float32Array.");
  }
  const wrapMode = options.wrapMode ?? "loop";
  if (wrapMode !== "loop" && wrapMode !== "clamp") throw new MorphRuntimeError("invalid-time", "Morph wrap mode is invalid.");
  const lastTime = track.times[track.times.length - 1]!, sampledTime = wrapTime(time, lastTime, wrapMode);
  const upper = upperBound(track.times, sampledTime), left = Math.max(0, upper - 1), right = Math.min(track.times.length - 1, upper);
  if (left === right || track.interpolation === "STEP") {
    copyValue(track, left, result);
    return result;
  }
  const start = track.times[left]!, end = track.times[right]!, alpha = (sampledTime - start) / (end - start);
  if (track.interpolation === "LINEAR") {
    const leftOffset = left * track.targetCount, rightOffset = right * track.targetCount;
    for (let target = 0; target < track.targetCount; target += 1) {
      result[target] = track.values[leftOffset + target]! * (1 - alpha) + track.values[rightOffset + target]! * alpha;
    }
    return result;
  }
  const stride = track.targetCount * 3, duration = end - start;
  const h00 = 2 * alpha ** 3 - 3 * alpha ** 2 + 1, h10 = alpha ** 3 - 2 * alpha ** 2 + alpha;
  const h01 = -2 * alpha ** 3 + 3 * alpha ** 2, h11 = alpha ** 3 - alpha ** 2;
  for (let target = 0; target < track.targetCount; target += 1) assertFloat32(cubicValue(track, left, right, target, stride, duration, h00, h10, h01, h11));
  for (let target = 0; target < track.targetCount; target += 1) {
    result[target] = cubicValue(track, left, right, target, stride, duration, h00, h10, h01, h11);
  }
  return result;
}

/** Produces weighted POSITION/NORMAL/TANGENT deltas; callers add them to their base vertex streams. */
export function blendMorphTargetDeltas(
  primitive: MorphPrimitiveSource,
  weights: ArrayLike<number>,
  output?: MorphBlendOutput,
): MorphBlendOutput {
  validatePrimitive(primitive);
  if (!weights || weights.length !== primitive.targets.length) throw new MorphRuntimeError("invalid-source", "Morph weight count must equal target count.");
  for (let index = 0; index < weights.length; index += 1) if (!Number.isFinite(weights[index])) {
    throw new MorphRuntimeError("invalid-source", "Morph weights must be finite.");
  }
  const length = primitive.vertexCount * 3;
  const allocate = output === undefined;
  const position = prepareOutput("positionDeltas", primitive.targets.some((target) => target.positionDeltas), length, output?.positionDeltas, allocate);
  const normal = prepareOutput("normalDeltas", primitive.targets.some((target) => target.normalDeltas), length, output?.normalDeltas, allocate);
  const tangent = prepareOutput("tangentDeltas", primitive.targets.some((target) => target.tangentDeltas), length, output?.tangentDeltas, allocate);
  const arrays = [position, normal, tangent].filter((value): value is Float32Array<ArrayBuffer> => value !== undefined);
  if (new Set(arrays).size !== arrays.length) throw new MorphRuntimeError("invalid-output", "Morph semantic outputs cannot alias each other.");
  assertBlendRange(primitive, weights, "positionDeltas");
  assertBlendRange(primitive, weights, "normalDeltas");
  assertBlendRange(primitive, weights, "tangentDeltas");
  writeBlend(position, primitive, weights, "positionDeltas");
  writeBlend(normal, primitive, weights, "normalDeltas");
  writeBlend(tangent, primitive, weights, "tangentDeltas");
  if (output) return output;
  return Object.freeze({ ...(position ? { positionDeltas: position } : {}), ...(normal ? { normalDeltas: normal } : {}),
    ...(tangent ? { tangentDeltas: tangent } : {}) });
}

function validateTrack(track: MorphWeightTrack): void {
  if (!track || typeof track !== "object" || !Number.isSafeInteger(track.targetCount) || track.targetCount < 1
    || !(track.times instanceof Float32Array) || track.times.length < 1 || !(track.values instanceof Float32Array)
    || !["STEP", "LINEAR", "CUBICSPLINE"].includes(track.interpolation)) {
    throw new MorphRuntimeError("invalid-source", "Morph weight track is invalid.");
  }
  const multiplier = track.interpolation === "CUBICSPLINE" ? 3 : 1;
  if (track.values.length !== track.times.length * track.targetCount * multiplier) throw new MorphRuntimeError("invalid-source", "Morph track value layout is invalid.");
  for (let index = 0; index < track.times.length; index += 1) {
    if (!Number.isFinite(track.times[index]) || track.times[index]! < 0 || (index > 0 && track.times[index]! <= track.times[index - 1]!)) {
      throw new MorphRuntimeError("invalid-source", "Morph track times must be finite, non-negative, and strictly increasing.");
    }
  }
  for (const value of track.values) if (!Number.isFinite(value)) throw new MorphRuntimeError("invalid-source", "Morph track values must be finite.");
}

function validatePrimitive(primitive: MorphPrimitiveSource): void {
  if (!primitive || typeof primitive !== "object" || !Number.isSafeInteger(primitive.vertexCount) || primitive.vertexCount < 1
    || !Array.isArray(primitive.targets) || primitive.targets.length < 1) throw new MorphRuntimeError("invalid-source", "Morph primitive is invalid.");
  const length = primitive.vertexCount * 3;
  for (const target of primitive.targets) {
    if (!target || typeof target !== "object") throw new MorphRuntimeError("invalid-source", "Morph target is invalid.");
    const streams = [target.positionDeltas, target.normalDeltas, target.tangentDeltas];
    if (!streams.some(Boolean) || streams.some((stream) => stream !== undefined && (!(stream instanceof Float32Array) || stream.length !== length))) {
      throw new MorphRuntimeError("invalid-source", "Morph target delta layout is invalid.");
    }
    for (const stream of streams) if (stream) for (const value of stream) if (!Number.isFinite(value)) {
      throw new MorphRuntimeError("invalid-source", "Morph target deltas must be finite.");
    }
  }
}

function prepareOutput(label: string, needed: boolean, length: number, value: Float32Array<ArrayBuffer> | undefined,
  allocate: boolean): Float32Array<ArrayBuffer> | undefined {
  if (!needed) {
    if (value !== undefined) throw new MorphRuntimeError("invalid-output", `Unexpected ${label} output.`);
    return undefined;
  }
  if (value === undefined) {
    if (!allocate) throw new MorphRuntimeError("invalid-output", `Missing ${label} output.`);
    return new Float32Array(length);
  }
  if (!(value instanceof Float32Array) || value.length !== length) throw new MorphRuntimeError("invalid-output", `Invalid ${label} output.`);
  return value;
}
function assertBlendRange(primitive: MorphPrimitiveSource, weights: ArrayLike<number>,
  semantic: "positionDeltas" | "normalDeltas" | "tangentDeltas"): void {
  if (!primitive.targets.some((target) => target[semantic] !== undefined)) return;
  const length = primitive.vertexCount * 3;
  for (let component = 0; component < length; component += 1) {
    let value = 0;
    for (let target = 0; target < primitive.targets.length; target += 1) {
      value += (primitive.targets[target]![semantic]?.[component] ?? 0) * weights[target]!;
    }
    assertFloat32(value);
  }
}
function writeBlend(output: Float32Array | undefined, primitive: MorphPrimitiveSource, weights: ArrayLike<number>,
  semantic: "positionDeltas" | "normalDeltas" | "tangentDeltas"): void {
  if (!output) return;
  for (let component = 0; component < output.length; component += 1) {
    let value = 0;
    for (let target = 0; target < primitive.targets.length; target += 1) {
      value += (primitive.targets[target]![semantic]?.[component] ?? 0) * weights[target]!;
    }
    output[component] = value;
  }
}
function cubicValue(track: MorphWeightTrack, left: number, right: number, target: number, stride: number,
  duration: number, h00: number, h10: number, h01: number, h11: number): number {
  const leftValue = left * stride + track.targetCount + target, leftOut = left * stride + 2 * track.targetCount + target;
  const rightIn = right * stride + target, rightValue = right * stride + track.targetCount + target;
  return h00 * track.values[leftValue]! + h10 * duration * track.values[leftOut]!
    + h01 * track.values[rightValue]! + h11 * duration * track.values[rightIn]!;
}
function assertFloat32(value: number): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new MorphRuntimeError("invalid-source", "Morph result exceeds finite float32 range.");
}
function copyValue(track: MorphWeightTrack, key: number, output: Float32Array): void {
  const offset = key * track.targetCount * (track.interpolation === "CUBICSPLINE" ? 3 : 1)
    + (track.interpolation === "CUBICSPLINE" ? track.targetCount : 0);
  output.set(track.values.subarray(offset, offset + track.targetCount));
}
function wrapTime(time: number, duration: number, mode: "loop" | "clamp"): number {
  if (duration <= 0) return 0;
  if (mode === "clamp") return Math.min(duration, Math.max(0, time));
  return ((time % duration) + duration) % duration;
}
function upperBound(values: Float32Array, target: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! <= target) low = middle + 1; else high = middle; }
  return low;
}
