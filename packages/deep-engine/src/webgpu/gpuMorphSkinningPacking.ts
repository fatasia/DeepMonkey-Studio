import { cpuDeformMorphVertices, prepareMorphInput } from "./gpuMorphPacking.js";
import type { GpuMorphSource, GpuMorphWeights } from "./gpuMorphTypes.js";
import type { PreparedMorphSkinningInput } from "./gpuMorphSkinningTypes.js";
import { GPU_MORPH_SKINNING_INFLUENCE_STRIDE } from "./gpuMorphSkinningWgsl.js";
import { prepareSkinningInput } from "./gpuSkinningPacking.js";
import type { SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";

const EPSILON = 1e-8;

export function prepareMorphSkinningInput(morph: GpuMorphSource, skinning: SkinningSource,
  morphWeights: GpuMorphWeights, palette: SkinningPalette): PreparedMorphSkinningInput {
  if (!(morph?.normals instanceof Float32Array)) throw new Error("Fused morph skinning requires base normals.");
  sameStream(morph.positions, skinning?.positions, "positions"); sameStream(morph.normals, skinning?.normals, "normals");
  const morphInput = prepareMorphInput(morph, morphWeights), skinInput = prepareSkinningInput(skinning, palette);
  if (morphInput.vertexCount !== skinInput.vertexCount) throw new Error("Morph and skinning vertex counts do not match.");
  const influences = new ArrayBuffer(skinInput.vertexCount * GPU_MORPH_SKINNING_INFLUENCE_STRIDE);
  const sourceFloats = new Float32Array(skinInput.vertices), sourceUints = new Uint32Array(skinInput.vertices);
  const outputFloats = new Float32Array(influences), outputUints = new Uint32Array(influences);
  for (let vertex = 0; vertex < skinInput.vertexCount; vertex += 1) {
    const sourceOffset = vertex * 16, outputOffset = vertex * 8;
    for (let slot = 0; slot < 4; slot += 1) {
      outputUints[outputOffset + slot] = sourceUints[sourceOffset + 8 + slot]!;
      outputFloats[outputOffset + 4 + slot] = sourceFloats[sourceOffset + 12 + slot]!;
    }
  }
  return Object.freeze({ vertexCount: morphInput.vertexCount, targetCount: morphInput.targetCount,
    jointCount: skinInput.jointCount, flags: morphInput.flags, vertices: morphInput.vertices, deltas: morphInput.deltas,
    morphWeights: morphInput.weights, influences, joints: skinInput.joints,
    maximumBaseMagnitude: morphInput.maximumBaseMagnitude, maximumDeltaMagnitude: morphInput.maximumDeltaMagnitude });
}

export function cpuDeformMorphSkinVertices(input: PreparedMorphSkinningInput): Float32Array<ArrayBuffer> {
  const morphed = cpuDeformMorphVertices({ vertexCount: input.vertexCount, targetCount: input.targetCount, flags: input.flags,
    vertices: input.vertices, deltas: input.deltas, weights: input.morphWeights,
    maximumBaseMagnitude: input.maximumBaseMagnitude, maximumDeltaMagnitude: input.maximumDeltaMagnitude });
  const output = new Float32Array(input.vertexCount * 12), influenceF = new Float32Array(input.influences),
    influenceU = new Uint32Array(input.influences);
  for (let vertex = 0; vertex < input.vertexCount; vertex += 1) {
    skinVertex(morphed, vertex * 12, influenceF, influenceU, vertex * 8, input.joints, output);
  }
  return output;
}

function skinVertex(source: Float32Array, sourceOffset: number, influenceF: Float32Array, influenceU: Uint32Array,
  influenceOffset: number, joints: Float32Array, output: Float32Array): void {
  const position = source.subarray(sourceOffset, sourceOffset + 3), normal = source.subarray(sourceOffset + 4, sourceOffset + 7),
    tangent = source.subarray(sourceOffset + 8, sourceOffset + 11);
  const skinnedPosition = [0, 0, 0], skinnedNormal = [0, 0, 0], skinnedTangent = [0, 0, 0];
  const columns = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let slot = 0; slot < 4; slot += 1) {
    const weight = influenceF[influenceOffset + 4 + slot]!, joint = influenceU[influenceOffset + slot]! * 28;
    addTransformedPoint(skinnedPosition, joints, joint, position, weight);
    addNormal(skinnedNormal, joints, joint, normal, weight);
    addDirection(skinnedTangent, joints, joint, tangent, weight);
    for (let column = 0; column < 3; column += 1) for (let row = 0; row < 3; row += 1) {
      columns[column * 3 + row]! += joints[joint + column * 4 + row]! * weight;
    }
  }
  const hasNormal = (source[sourceOffset + 7] ?? 0) === 0 && Math.hypot(...normal) > EPSILON;
  const finalNormal = hasNormal ? normalized(skinnedNormal, [...normal]) : [0, 0, 0];
  const hasTangent = Math.abs(source[sourceOffset + 11]!) > 0;
  let finalTangent = [0, 0, 0], handedness = 0;
  if (hasTangent) {
    if (hasNormal) skinnedTangent.splice(0, 3, ...orthogonalized(skinnedTangent, finalNormal));
    const fallback = hasNormal ? normalized(orthogonalized(skinnedTangent, finalNormal), perpendicularTo(finalNormal)) : [...skinnedTangent];
    finalTangent = normalized(skinnedTangent, fallback);
    const determinant = columns[0]! * (columns[4]! * columns[8]! - columns[7]! * columns[5]!)
      - columns[3]! * (columns[1]! * columns[8]! - columns[7]! * columns[2]!)
      + columns[6]! * (columns[1]! * columns[5]! - columns[4]! * columns[2]!);
    handedness = source[sourceOffset + 11]! * (determinant < -EPSILON ? -1 : 1);
  }
  output.set([...skinnedPosition, 1, ...finalNormal, 0, ...finalTangent, handedness], sourceOffset);
}

function addTransformedPoint(output: number[], matrix: Float32Array, offset: number, value: Float32Array, weight: number): void {
  for (let row = 0; row < 3; row += 1) output[row]! += (matrix[offset + row]! * value[0]!
    + matrix[offset + 4 + row]! * value[1]! + matrix[offset + 8 + row]! * value[2]! + matrix[offset + 12 + row]!) * weight;
}
function addDirection(output: number[], matrix: Float32Array, offset: number, value: Float32Array, weight: number): void {
  for (let row = 0; row < 3; row += 1) output[row]! += (matrix[offset + row]! * value[0]!
    + matrix[offset + 4 + row]! * value[1]! + matrix[offset + 8 + row]! * value[2]!) * weight;
}
function addNormal(output: number[], matrix: Float32Array, offset: number, value: Float32Array, weight: number): void {
  for (let row = 0; row < 3; row += 1) output[row]! += (matrix[offset + 16 + row * 4]! * value[0]!
    + matrix[offset + 17 + row * 4]! * value[1]! + matrix[offset + 18 + row * 4]! * value[2]!) * weight;
}
function sameStream(left: Float32Array, right: Float32Array, label: string): void {
  if (!(right instanceof Float32Array) || left.length !== right.length) throw new Error(`Morph and skinning ${label} do not match.`);
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) throw new Error(`Morph and skinning ${label} do not match.`);
}
function normalized(value: readonly number[], fallback: readonly number[]): number[] {
  const length = Math.hypot(...value); return length > EPSILON ? value.map((component) => component / length) : [...fallback];
}
function orthogonalized(value: readonly number[], normal: readonly number[]): number[] {
  const dot = value[0]! * normal[0]! + value[1]! * normal[1]! + value[2]! * normal[2]!;
  return [value[0]! - normal[0]! * dot, value[1]! - normal[1]! * dot, value[2]! - normal[2]! * dot];
}
function perpendicularTo(normal: readonly number[]): number[] {
  const axis = Math.abs(normal[0]!) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  return normalized([normal[1]! * axis[2]! - normal[2]! * axis[1]!, normal[2]! * axis[0]! - normal[0]! * axis[2]!,
    normal[0]! * axis[1]! - normal[1]! * axis[0]!], [1, 0, 0]);
}
