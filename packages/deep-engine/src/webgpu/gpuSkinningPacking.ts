import type { PreparedSkinningInput, SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";

const MAX_VERTICES = 16_000_000, MAX_JOINTS = 65_535;

export function prepareSkinningInput(source: SkinningSource, palette: SkinningPalette): PreparedSkinningInput {
  validateRevision(source?.revision, "Skinning source revision"); validateRevision(palette?.revision, "Skinning palette revision");
  sourceArrays(source); paletteArrays(palette);
  if (source.weightMode !== undefined && source.weightMode !== "normalize" && source.weightMode !== "preserve") {
    throw new Error("Skinning weight mode is invalid.");
  }
  if (source.positions.length % 3 !== 0 || source.positions.length === 0) throw new Error("Skinning positions must contain complete vertices.");
  const vertexCount = source.positions.length / 3;
  if (vertexCount > MAX_VERTICES || source.normals.length !== vertexCount * 3
    || source.joints.length !== vertexCount * 4 || source.weights.length !== vertexCount * 4) throw new Error("Skinning vertex attribute counts do not match.");
  validateSkinTangents(source.tangents, source.normals);
  if (palette.matrices.length % 16 !== 0 || palette.matrices.length === 0) throw new Error("Skinning palette matrices are invalid.");
  const jointCount = palette.matrices.length / 16;
  if (jointCount > MAX_JOINTS) throw new Error("Skinning joint count exceeds the supported limit.");
  if (palette.normalMatrices && palette.normalMatrices.length !== jointCount * 12) throw new Error("Skinning normal palette size is invalid.");
  const vertices = new ArrayBuffer(vertexCount * 64), floats = new Float32Array(vertices), uints = new Uint32Array(vertices);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const src3 = vertex * 3, src4 = vertex * 4, dst = vertex * 16;
    if (![source.positions[src3], source.positions[src3 + 1], source.positions[src3 + 2],
      source.normals[src3], source.normals[src3 + 1], source.normals[src3 + 2]].every(Number.isFinite)) {
      throw new Error(`Skinning vertex ${vertex} contains a non-finite value.`);
    }
    const normalLength = Math.hypot(source.normals[src3]!, source.normals[src3 + 1]!, source.normals[src3 + 2]!);
    if (normalLength < 1e-8) throw new Error(`Skinning normal ${vertex} is degenerate.`);
    floats.set([source.positions[src3]!, source.positions[src3 + 1]!, source.positions[src3 + 2]!, 1,
      source.normals[src3]! / normalLength, source.normals[src3 + 1]! / normalLength, source.normals[src3 + 2]! / normalLength, 0], dst);
    let weightSum = 0;
    for (let influence = 0; influence < 4; influence += 1) {
      const joint = source.joints[src4 + influence]!, weight = source.weights[src4 + influence]!;
      if (!Number.isSafeInteger(joint) || joint >= jointCount) throw new Error(`Skinning joint index ${joint} is out of range.`);
      if (!Number.isFinite(weight) || weight < 0) throw new Error(`Skinning weight ${vertex}:${influence} is invalid.`);
      uints[dst + 8 + influence] = joint; weightSum += weight;
    }
    if (weightSum < 1e-8) throw new Error(`Skinning vertex ${vertex} has zero total weight.`);
    const divisor = source.weightMode === "preserve" ? 1 : weightSum;
    for (let influence = 0; influence < 4; influence += 1) floats[dst + 12 + influence] = source.weights[src4 + influence]! / divisor;
  }
  const joints = packJointPalette(palette);
  return Object.freeze({ vertexCount, jointCount, vertices, joints,
    ...(source.tangents ? { tangents: source.tangents.slice() } : {}) });
}

export function packJointPalette(palette: SkinningPalette): Float32Array<ArrayBuffer> {
  validateRevision(palette?.revision, "Skinning palette revision"); paletteArrays(palette);
  if (palette.matrices.length % 16 !== 0 || palette.matrices.length === 0) throw new Error("Skinning palette matrices are invalid.");
  const count = palette.matrices.length / 16;
  if (count > MAX_JOINTS || palette.normalMatrices && palette.normalMatrices.length !== count * 12) throw new Error("Skinning normal palette size is invalid.");
  const packed = new Float32Array(count * 28);
  for (let joint = 0; joint < count; joint += 1) {
    const matrix = palette.matrices.subarray(joint * 16, joint * 16 + 16);
    if (![...matrix].every(Number.isFinite)) throw new Error(`Skinning joint matrix ${joint} contains a non-finite value.`);
    packed.set(matrix, joint * 28);
    const normal = palette.normalMatrices?.subarray(joint * 12, joint * 12 + 12) ?? inverseTransposeRows(matrix, joint);
    if (![...normal].every(Number.isFinite)) throw new Error(`Skinning normal matrix ${joint} contains a non-finite value.`);
    packed.set(normal, joint * 28 + 16);
  }
  return packed;
}

export function cpuSkinVertices(input: PreparedSkinningInput): Float32Array<ArrayBuffer> {
  const stride = input.tangents ? 12 : 8;
  const sourceF = new Float32Array(input.vertices), sourceU = new Uint32Array(input.vertices), output = new Float32Array(input.vertexCount * stride);
  for (let vertex = 0; vertex < input.vertexCount; vertex += 1) {
    const src = vertex * 16, dst = vertex * stride; let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    for (let influence = 0; influence < 4; influence += 1) {
      const weight = sourceF[src + 12 + influence]!, joint = sourceU[src + 8 + influence]! * 28;
      const x = sourceF[src]!, y = sourceF[src + 1]!, z = sourceF[src + 2]!;
      px += (input.joints[joint]! * x + input.joints[joint + 4]! * y + input.joints[joint + 8]! * z + input.joints[joint + 12]!) * weight;
      py += (input.joints[joint + 1]! * x + input.joints[joint + 5]! * y + input.joints[joint + 9]! * z + input.joints[joint + 13]!) * weight;
      pz += (input.joints[joint + 2]! * x + input.joints[joint + 6]! * y + input.joints[joint + 10]! * z + input.joints[joint + 14]!) * weight;
      const sx = sourceF[src + 4]!, sy = sourceF[src + 5]!, sz = sourceF[src + 6]!;
      nx += (input.joints[joint + 16]! * sx + input.joints[joint + 17]! * sy + input.joints[joint + 18]! * sz) * weight;
      ny += (input.joints[joint + 20]! * sx + input.joints[joint + 21]! * sy + input.joints[joint + 22]! * sz) * weight;
      nz += (input.joints[joint + 24]! * sx + input.joints[joint + 25]! * sy + input.joints[joint + 26]! * sz) * weight;
    }
    const length = Math.hypot(nx, ny, nz), sx = sourceF[src + 4]!, sy = sourceF[src + 5]!, sz = sourceF[src + 6]!;
    output.set([px, py, pz, 1, length > 1e-8 ? nx / length : sx, length > 1e-8 ? ny / length : sy,
      length > 1e-8 ? nz / length : sz, 0], dst);
    if (input.tangents) skinTangent(input, sourceF, sourceU, vertex, output, dst);
  }
  return output;
}

export function validateSkinTangents(tangents: Float32Array | undefined, normals: Float32Array): void {
  if (tangents === undefined) return;
  if (!(tangents instanceof Float32Array) || !(tangents.buffer instanceof ArrayBuffer)
    || tangents.length !== normals.length / 3 * 4) throw new Error("Skinning tangent layout is invalid.");
  for (let vertex = 0; vertex < tangents.length / 4; vertex++) {
    const t = vertex * 4, n = vertex * 3;
    const xyz = [tangents[t]!, tangents[t + 1]!, tangents[t + 2]!];
    if (!xyz.every(Number.isFinite) || Math.abs(Math.hypot(...xyz) - 1) > 1e-5
      || Math.abs(tangents[t + 3]!) !== 1) throw new Error("Skinning tangent must be unit length with handedness -1/+1.");
    const length = Math.hypot(normals[n]!, normals[n + 1]!, normals[n + 2]!);
    if (Math.abs((xyz[0]! * normals[n]! + xyz[1]! * normals[n + 1]! + xyz[2]! * normals[n + 2]!) / length) > 1e-5)
      throw new Error("Skinning tangent must be orthogonal to the normal.");
  }
}

function skinTangent(input: PreparedSkinningInput, floats: Float32Array, uints: Uint32Array,
  vertex: number, output: Float32Array, dst: number): void {
  const src = vertex * 16, t = vertex * 4, linear = new Array<number>(9).fill(0);
  for (let slot = 0; slot < 4; slot++) {
    const joint = uints[src + 8 + slot]! * 28, weight = floats[src + 12 + slot]!;
    for (let column = 0; column < 3; column++) for (let row = 0; row < 3; row++)
      linear[column * 3 + row]! += input.joints[joint + column * 4 + row]! * weight;
  }
  const direction = [0, 1, 2].map(row => linear[row]! * input.tangents![t]!
    + linear[3 + row]! * input.tangents![t + 1]! + linear[6 + row]! * input.tangents![t + 2]!);
  const normal = Array.from(output.subarray(dst + 4, dst + 7));
  const dot = direction.reduce((sum, value, axis) => sum + value * normal[axis]!, 0);
  const tangent = direction.map((value, axis) => value - dot * normal[axis]!);
  const length = Math.hypot(...tangent);
  const axis = Math.abs(normal[0]!) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const fallback = [normal[1]! * axis[2]! - normal[2]! * axis[1]!, normal[2]! * axis[0]! - normal[0]! * axis[2]!,
    normal[0]! * axis[1]! - normal[1]! * axis[0]!];
  const fallbackLength = Math.hypot(...fallback);
  const determinant = linear[0]! * (linear[4]! * linear[8]! - linear[7]! * linear[5]!)
    - linear[3]! * (linear[1]! * linear[8]! - linear[7]! * linear[2]!)
    + linear[6]! * (linear[1]! * linear[5]! - linear[4]! * linear[2]!);
  output.set([...(length > 1e-8 ? tangent.map(value => value / length) : fallback.map(value => value / fallbackLength)),
    input.tangents![t + 3]! * (determinant < -1e-8 ? -1 : 1)], dst + 8);
}

function inverseTransposeRows(matrix: Float32Array, joint: number): Float32Array<ArrayBuffer> {
  const a = matrix[0]!, b = matrix[4]!, c = matrix[8]!, d = matrix[1]!, e = matrix[5]!, f = matrix[9]!,
    g = matrix[2]!, h = matrix[6]!, i = matrix[10]!;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) throw new Error(`Skinning joint matrix ${joint} is singular.`);
  const inverse = [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f,
    C, b * g - a * h, a * e - b * d].map(value => value / determinant);
  return new Float32Array([inverse[0]!, inverse[3]!, inverse[6]!, 0, inverse[1]!, inverse[4]!, inverse[7]!, 0,
    inverse[2]!, inverse[5]!, inverse[8]!, 0]);
}
function validateRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
}
function sourceArrays(value: SkinningSource): void {
  if (!(value?.positions instanceof Float32Array) || !(value.normals instanceof Float32Array)
    || !(value.weights instanceof Float32Array) || !(value.joints instanceof Uint16Array || value.joints instanceof Uint32Array)) {
    throw new Error("Skinning source arrays have invalid element types.");
  }
  ownedArrays([value.positions, value.normals, value.joints, value.weights]);
}
function paletteArrays(value: SkinningPalette): void {
  if (!(value?.matrices instanceof Float32Array) || value.normalMatrices !== undefined && !(value.normalMatrices instanceof Float32Array)) {
    throw new Error("Skinning palette arrays have invalid element types.");
  }
  ownedArrays(value.normalMatrices ? [value.matrices, value.normalMatrices] : [value.matrices]);
}
function ownedArrays(values: readonly ArrayBufferView[]): void {
  if (values.some((item) => !(item.buffer instanceof ArrayBuffer))) throw new Error("Skinning inputs require unshared owned arrays.");
}
