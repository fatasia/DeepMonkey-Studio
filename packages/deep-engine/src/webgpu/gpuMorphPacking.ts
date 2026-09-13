import type { GpuMorphSource, GpuMorphWeights, PreparedMorphInput } from "./gpuMorphTypes.js";
import { GPU_MORPH_DELTA_STRIDE, GPU_MORPH_FLAG_NORMAL, GPU_MORPH_FLAG_TANGENT,
  GPU_MORPH_VERTEX_STRIDE } from "./gpuMorphWgsl.js";

const MAX_VERTICES = 4_000_000, MAX_TARGETS = 256, MAX_PACKED_BYTES = 256 * 1024 * 1024;
const EPSILON = 1e-8;

export function prepareMorphInput(source: GpuMorphSource, weights: GpuMorphWeights): PreparedMorphInput {
  validateRevision(source?.revision, "Morph source revision");
  validateRevision(weights?.revision, "Morph weights revision");
  if (!(source?.positions instanceof Float32Array) || !(weights?.values instanceof Float32Array)) {
    throw new Error("Morph source and weight arrays must be Float32Array values.");
  }
  owned([source.positions, weights.values]);
  if (source.positions.length === 0 || source.positions.length % 3 !== 0) throw new Error("Morph positions must contain complete vertices.");
  const vertexCount = source.positions.length / 3, primitive = source.primitive;
  if (vertexCount > MAX_VERTICES || !primitive || primitive.vertexCount !== vertexCount
    || !Array.isArray(primitive.targets) || primitive.targets.length < 1 || primitive.targets.length > MAX_TARGETS) {
    throw new Error("Morph primitive dimensions are invalid or exceed supported limits.");
  }
  const targetCount = primitive.targets.length;
  if (weights.values.length !== targetCount) throw new Error("Morph weight count must equal target count.");
  const normal = optionalStream(source.normals, vertexCount * 3, "normal");
  const tangent = optionalStream(source.tangents, vertexCount * 4, "tangent");
  const targetBytes = checkedBytes(vertexCount, targetCount, GPU_MORPH_DELTA_STRIDE);
  const baseBytes = checkedBytes(vertexCount, 1, GPU_MORPH_VERTEX_STRIDE);
  if (baseBytes + targetBytes + targetCount * 4 > MAX_PACKED_BYTES) throw new Error("Morph packed data exceeds the supported byte budget.");
  const flags = (normal ? GPU_MORPH_FLAG_NORMAL : 0) | (tangent ? GPU_MORPH_FLAG_TANGENT : 0);
  validateTargets(source, Boolean(normal), Boolean(tangent));
  const vertices = packVertices(source, vertexCount, normal, tangent);
  const deltas = packDeltas(source, vertexCount, targetCount, targetBytes / 4);
  const packedWeights = packMorphWeights(weights, targetCount);
  const maximumBaseMagnitude = maximumMagnitude(new Float32Array(vertices));
  const maximumDeltaMagnitude = maximumMagnitude(deltas);
  assertMorphWeightRange(packedWeights, maximumBaseMagnitude, maximumDeltaMagnitude);
  return Object.freeze({ vertexCount, targetCount, flags, vertices, deltas, weights: packedWeights,
    maximumBaseMagnitude, maximumDeltaMagnitude });
}

export function packMorphWeights(weights: GpuMorphWeights, targetCount: number): Float32Array<ArrayBuffer> {
  validateRevision(weights?.revision, "Morph weights revision");
  if (!(weights?.values instanceof Float32Array) || !(weights.values.buffer instanceof ArrayBuffer)
    || weights.values.length !== targetCount) throw new Error("Morph weight layout is invalid.");
  const output = new Float32Array(targetCount);
  for (let index = 0; index < targetCount; index += 1) {
    const value = weights.values[index]!;
    if (!Number.isFinite(value)) throw new Error(`Morph weight ${index} is not finite.`);
    output[index] = value;
  }
  return output;
}

export function assertMorphWeightRange(weights: Float32Array, maximumBaseMagnitude: number, maximumDeltaMagnitude: number): void {
  let absoluteWeightSum = 0;
  for (const weight of weights) absoluteWeightSum += Math.abs(weight);
  const conservativeBound = maximumBaseMagnitude + maximumDeltaMagnitude * absoluteWeightSum;
  if (!Number.isFinite(conservativeBound) || !Number.isFinite(Math.fround(conservativeBound))) {
    throw new Error("Morph weights can overflow finite float32 deformation output.");
  }
}

export function cpuDeformMorphVertices(input: PreparedMorphInput): Float32Array<ArrayBuffer> {
  const base = new Float32Array(input.vertices), output = new Float32Array(input.vertexCount * 12);
  const hasNormal = (input.flags & GPU_MORPH_FLAG_NORMAL) !== 0, hasTangent = (input.flags & GPU_MORPH_FLAG_TANGENT) !== 0;
  for (let vertex = 0; vertex < input.vertexCount; vertex += 1) {
    const offset = vertex * 12;
    let px = base[offset]!, py = base[offset + 1]!, pz = base[offset + 2]!;
    let nx = base[offset + 4]!, ny = base[offset + 5]!, nz = base[offset + 6]!;
    let tx = base[offset + 8]!, ty = base[offset + 9]!, tz = base[offset + 10]!;
    for (let target = 0; target < input.targetCount; target += 1) {
      const delta = (target * input.vertexCount + vertex) * 12, weight = input.weights[target]!;
      px += input.deltas[delta]! * weight; py += input.deltas[delta + 1]! * weight; pz += input.deltas[delta + 2]! * weight;
      nx += input.deltas[delta + 4]! * weight; ny += input.deltas[delta + 5]! * weight; nz += input.deltas[delta + 6]! * weight;
      tx += input.deltas[delta + 8]! * weight; ty += input.deltas[delta + 9]! * weight; tz += input.deltas[delta + 10]! * weight;
    }
    const normal = hasNormal ? normalized(nx, ny, nz, base[offset + 4]!, base[offset + 5]!, base[offset + 6]!) : [0, 0, 0];
    let tangentOut = [0, 0, 0];
    if (hasTangent) {
      let fallback = [base[offset + 8]!, base[offset + 9]!, base[offset + 10]!];
      if (hasNormal) {
        fallback = orthogonalized(fallback, normal); const perpendicular = perpendicularTo(normal);
        fallback = normalized(fallback[0]!, fallback[1]!, fallback[2]!, perpendicular[0]!, perpendicular[1]!, perpendicular[2]!);
        const orthogonalTangent = orthogonalized([tx, ty, tz], normal);
        tx = orthogonalTangent[0]!; ty = orthogonalTangent[1]!; tz = orthogonalTangent[2]!;
      }
      tangentOut = normalized(tx, ty, tz, fallback[0]!, fallback[1]!, fallback[2]!);
    }
    output.set([px, py, pz, 1, ...normal, 0, ...tangentOut, hasTangent ? base[offset + 11]! : 0], offset);
  }
  return output;
}

function packVertices(source: GpuMorphSource, vertexCount: number, normals?: Float32Array, tangents?: Float32Array): ArrayBuffer {
  const result = new ArrayBuffer(vertexCount * GPU_MORPH_VERTEX_STRIDE), output = new Float32Array(result);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const src3 = vertex * 3, src4 = vertex * 4, dst = vertex * 12;
    finite3(source.positions, src3, `Morph position ${vertex}`);
    output.set([source.positions[src3]!, source.positions[src3 + 1]!, source.positions[src3 + 2]!, 1], dst);
    let normal: number[] | undefined;
    if (normals) { finite3(normals, src3, `Morph normal ${vertex}`); normal = normalizedStrict(normals, src3, `Morph normal ${vertex}`); output.set([...normal, 0], dst + 4); }
    if (tangents) {
      finite3(tangents, src4, `Morph tangent ${vertex}`); const sign = tangents[src4 + 3]!;
      if (!Number.isFinite(sign) || Math.abs(Math.abs(sign) - 1) > 1e-5) throw new Error(`Morph tangent ${vertex} has invalid handedness.`);
      let tangent = normalizedStrict(tangents, src4, `Morph tangent ${vertex}`);
      if (normal) { tangent = orthogonalized(tangent, normal); tangent = normalizedStrict(tangent, 0, `Morph tangent ${vertex}`); }
      output.set([...tangent, sign], dst + 8);
    }
  }
  return result;
}

function packDeltas(source: GpuMorphSource, vertexCount: number, targetCount: number, floats: number): Float32Array<ArrayBuffer> {
  const output = new Float32Array(floats), expected = vertexCount * 3;
  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    const target = source.primitive.targets[targetIndex]!;
    if (target.index !== targetIndex) throw new Error("Morph target indices must match stable target order.");
    for (const [semanticOffset, stream] of [[0, target.positionDeltas], [4, target.normalDeltas], [8, target.tangentDeltas]] as const) {
      if (!stream) continue;
      if (!(stream instanceof Float32Array) || !(stream.buffer instanceof ArrayBuffer) || stream.length !== expected) throw new Error("Morph target delta layout is invalid.");
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const src = vertex * 3, dst = (targetIndex * vertexCount + vertex) * 12 + semanticOffset;
        finite3(stream, src, `Morph target ${targetIndex}`); output.set(stream.subarray(src, src + 3), dst);
      }
    }
  }
  return output;
}

function validateTargets(source: GpuMorphSource, hasNormal: boolean, hasTangent: boolean): void {
  for (const target of source.primitive.targets) {
    if (!target || typeof target !== "object" || ![target.positionDeltas, target.normalDeltas, target.tangentDeltas].some(Boolean)) throw new Error("Morph target is empty or invalid.");
    if (target.normalDeltas && !hasNormal) throw new Error("Morph normal deltas require base normals.");
    if (target.tangentDeltas && !hasTangent) throw new Error("Morph tangent deltas require base tangents.");
  }
}
function optionalStream(value: Float32Array<ArrayBuffer> | undefined, length: number, label: string): Float32Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Float32Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== length) throw new Error(`Morph ${label} layout is invalid.`);
  return value;
}
function checkedBytes(vertices: number, targets: number, stride: number): number {
  const bytes = vertices * targets * stride;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_PACKED_BYTES) throw new Error("Morph packed data exceeds the supported byte budget.");
  return bytes;
}
function maximumMagnitude(values: Float32Array): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}
function finite3(values: ArrayLike<number>, offset: number, label: string): void {
  if (![values[offset], values[offset + 1], values[offset + 2]].every(Number.isFinite)) throw new Error(`${label} contains a non-finite value.`);
}
function normalizedStrict(values: ArrayLike<number>, offset: number, label: string): number[] {
  const length = Math.hypot(values[offset]!, values[offset + 1]!, values[offset + 2]!);
  if (!Number.isFinite(length) || length < EPSILON) throw new Error(`${label} is degenerate.`);
  return [values[offset]! / length, values[offset + 1]! / length, values[offset + 2]! / length];
}
function normalized(x: number, y: number, z: number, fx: number, fy: number, fz: number): number[] {
  const length = Math.hypot(x, y, z); return length >= EPSILON ? [x / length, y / length, z / length] : [fx, fy, fz];
}
function orthogonalized(value: readonly number[], normal: readonly number[]): number[] {
  const dot = value[0]! * normal[0]! + value[1]! * normal[1]! + value[2]! * normal[2]!;
  return [value[0]! - normal[0]! * dot, value[1]! - normal[1]! * dot, value[2]! - normal[2]! * dot];
}
function perpendicularTo(normal: readonly number[]): number[] {
  const axis = Math.abs(normal[0]!) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  return normalized(normal[1]! * axis[2]! - normal[2]! * axis[1]!, normal[2]! * axis[0]! - normal[0]! * axis[2]!,
    normal[0]! * axis[1]! - normal[1]! * axis[0]!, 1, 0, 0);
}
function validateRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
}
function owned(values: readonly ArrayBufferView[]): void {
  if (values.some((value) => !(value.buffer instanceof ArrayBuffer))) throw new Error("Morph inputs require unshared owned arrays.");
}
