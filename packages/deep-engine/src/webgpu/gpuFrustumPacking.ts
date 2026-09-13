export const GPU_CULL_INSTANCE_STRIDE = 144;
export const GPU_CULL_PREVIOUS_TRANSFORM_STRIDE = 48;
export const GPU_CULL_INDIRECT_STRIDE = 20;
const INSTANCE_FLOATS = GPU_CULL_INSTANCE_STRIDE / 4;

export interface CullingInstance {
  /** Full 144-byte Deep instance row when the result will be bound as a vertex buffer. */
  readonly instanceData?: Float32Array | number[];
  /** Previous model rows; defaults to the current model rows for a newly resident object. */
  readonly previousTransform?: Float32Array | number[];
  readonly bounds: readonly [number, number, number, number];
  readonly modelMatrix?: Float32Array | number[];
  readonly normalMatrix?: Float32Array | number[];
  readonly metadata?: readonly [number, number, number, number];
}

export interface Frustum {
  readonly planes: ReadonlyArray<readonly [number, number, number, number]>;
}

export interface IndirectDrawArgs {
  readonly indexCount: number;
  readonly firstIndex: number;
  readonly baseVertex: number;
  readonly firstInstance: number;
}

export function packCullingInstances(instances: readonly CullingInstance[]): ArrayBuffer {
  if (instances.length > 1_048_576) throw new Error("Culling input exceeds the instance budget.");
  const out = new ArrayBuffer(instances.length * GPU_CULL_INSTANCE_STRIDE);
  const floats = new Float32Array(out), uints = new Uint32Array(out);
  instances.forEach((item, index) => {
    const offset = index * INSTANCE_FLOATS;
    if (item.instanceData !== undefined) {
      if (item.instanceData.length !== INSTANCE_FLOATS || !item.instanceData.every(Number.isFinite)) {
        throw new Error("instanceData must contain 36 finite values");
      }
      floats.set(item.instanceData, offset);
    } else {
      const matrix = item.modelMatrix;
      if (!matrix || matrix.length !== 16 || !matrix.every(Number.isFinite)) throw new Error("modelMatrix must contain 16 finite values");
      floats.set(modelRows(matrix), offset);
      const normal = item.normalMatrix ?? inverseTranspose3x3(matrix);
      if (normal.length !== 9 || !normal.every(Number.isFinite)) throw new Error("normalMatrix must contain 9 finite values");
      for (let column = 0; column < 3; column++) floats.set(normal.slice(column * 3, column * 3 + 3), offset + 12 + column * 4);
      const metadata = item.metadata ?? [0, 0, 0, 0];
      if (metadata.length !== 4 || !metadata.every(Number.isInteger)
        || metadata.some(value => value < 0 || value > 0xffffffff)) throw new Error("metadata must contain four uint32 values");
      uints.set(metadata, offset + 32);
    }
    if (item.bounds.length !== 4 || !item.bounds.every(Number.isFinite) || item.bounds[3]! < 0) {
      throw new Error("bounds must contain finite xyz and a nonnegative radius");
    }
  });
  return out;
}

export function packPreviousTransforms(instances: readonly CullingInstance[]): ArrayBuffer {
  const packed = new Float32Array(instances.length * 12);
  instances.forEach((item, index) => {
    const offset = index * 12, supplied = item.previousTransform;
    if (supplied !== undefined) {
      if (supplied.length !== 12 || !supplied.every(Number.isFinite)) throw new Error("previousTransform must contain 12 finite values");
      packed.set(supplied, offset); return;
    }
    const row = item.instanceData;
    if (row) { for (let i = 0; i < 12; i++) packed[offset + i] = row[i]!; return; }
    packed.set(modelRows(item.modelMatrix!), offset);
  });
  return packed.buffer;
}

export function cpuFrustumCull(instances: readonly CullingInstance[], frustum: Frustum): number[] {
  const planes = normalizePlanes(frustum);
  return instances.flatMap((item, index) => {
    const m = matrixOf(item), [x, y, z, radius] = item.bounds;
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    return planes.every(([a, b, c, d]) => {
      const support = radius * Math.hypot(m[0]! * a + m[1]! * b + m[2]! * c,
        m[4]! * a + m[5]! * b + m[6]! * c, m[8]! * a + m[9]! * b + m[10]! * c);
      return a * cx + b * cy + c * cz + d >= -support;
    }) ? [index] : [];
  });
}

export function packBounds(instances: readonly CullingInstance[]): ArrayBuffer {
  return new Float32Array(instances.flatMap(item => [...item.bounds])).buffer;
}

export function packFrustum(frustum: Frustum): ArrayBuffer {
  return new Float32Array(normalizePlanes(frustum).flat()).buffer;
}

export function packIndirectArgs(defaultIndexCount: number, args: Partial<IndirectDrawArgs>): ArrayBuffer {
  const indexCount = args.indexCount ?? defaultIndexCount, firstIndex = args.firstIndex ?? 0;
  const baseVertex = args.baseVertex ?? 0, firstInstance = args.firstInstance ?? 0;
  if (!Number.isInteger(indexCount) || indexCount < 0 || indexCount > 0xffffffff
    || !Number.isInteger(firstIndex) || firstIndex < 0 || firstIndex > 0xffffffff
    || !Number.isInteger(baseVertex) || baseVertex < -0x80000000 || baseVertex > 0x7fffffff
    || !Number.isInteger(firstInstance) || firstInstance < 0 || firstInstance > 0xffffffff) {
    throw new Error("Invalid drawIndexedIndirect arguments.");
  }
  const packed = new ArrayBuffer(GPU_CULL_INDIRECT_STRIDE), view = new DataView(packed);
  view.setUint32(0, indexCount, true); view.setUint32(4, 0, true); view.setUint32(8, firstIndex, true);
  view.setInt32(12, baseVertex, true); view.setUint32(16, firstInstance, true);
  return packed;
}

function modelRows(matrix: Float32Array | number[]): readonly number[] {
  return [matrix[0]!, matrix[4]!, matrix[8]!, matrix[12]!, matrix[1]!, matrix[5]!, matrix[9]!, matrix[13]!,
    matrix[2]!, matrix[6]!, matrix[10]!, matrix[14]!];
}

function matrixOf(item: CullingInstance): readonly number[] {
  if (item.modelMatrix) return Array.from(item.modelMatrix);
  const row = item.instanceData;
  if (!row || row.length < 12) throw new Error("modelMatrix or instanceData is required");
  return [row[0]!, row[4]!, row[8]!, 0, row[1]!, row[5]!, row[9]!, 0,
    row[2]!, row[6]!, row[10]!, 0, row[3]!, row[7]!, row[11]!, 1];
}

function normalizePlanes(frustum: Frustum): readonly (readonly [number, number, number, number])[] {
  if (frustum.planes.length !== 6) throw new Error("Frustum must contain exactly six planes.");
  return frustum.planes.map((plane) => {
    if (plane.length !== 4 || !plane.every(Number.isFinite)) throw new Error("Frustum planes must contain finite values.");
    const length = Math.hypot(plane[0]!, plane[1]!, plane[2]!);
    if (length < 1e-8) throw new Error("Frustum plane normal must be nonzero.");
    return [plane[0]! / length, plane[1]! / length, plane[2]! / length, plane[3]! / length] as const;
  });
}

function inverseTranspose3x3(matrix: Float32Array | number[]): number[] {
  const a = matrix[0]!, b = matrix[4]!, c = matrix[8]!, d = matrix[1]!, e = matrix[5]!, f = matrix[9]!;
  const g = matrix[2]!, h = matrix[6]!, i = matrix[10]!;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const D = c * h - b * i, E = a * i - c * g, F = b * g - a * h;
  const G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) throw new Error("modelMatrix has a singular basis");
  return [A, D, G, B, E, H, C, F, I].map(value => value / determinant);
}
