import type { SkinningPalette } from "../webgpu/gpuSkinningTypes.js";

export interface AuthorSkinPose {
  readonly revision: number;
  readonly jointCount: number;
  /** 每关节的 mesh-local 位置矩阵，column-major；不包含实例 matrixWorld。 */
  readonly matrices: readonly number[];
  /** Three 使用线性方向变换，不是默认 GPU skin 的 inverse-transpose。 */
  readonly normalRule: "three-linear";
  readonly normalMatrices: readonly number[];
  /** GPU 接口需要 TypedArray；每次复制，调用者写入不影响快照。 */
  copyPalette(): SkinningPalette;
}

/**
 * 作者必须先更新 world matrices。只读当前姿态，不推进动画或刷新 skeleton 缓存。
 * 消费者须搭配 SkinningSource.weightMode="preserve"；本模块不验证顶点权重，
 * 也不改变既有 GPU 对零总权重的拒绝，不代表完整 SkinnedMesh 已可渲染。
 */
export function captureAuthorSkinPose(source: unknown, revision: number): AuthorSkinPose {
  if (!Number.isSafeInteger(revision) || revision < 0) fail("revision");
  const mesh = record(source, "mesh");
  if (mesh.isSkinnedMesh !== true) fail("SkinnedMesh");
  const skeleton = record(mesh.skeleton, "skeleton");
  const bones = skeleton.bones, inverses = skeleton.boneInverses;
  if (!Array.isArray(bones) || !Array.isArray(inverses) || bones.length < 1
    || bones.length > 65_535 || bones.length !== inverses.length) fail("bone/inverse count");
  const bind = matrix(mesh.bindMatrix, "bindMatrix"), bindInverse = matrix(mesh.bindMatrixInverse, "bindMatrixInverse");
  const positions: number[] = [], normals: number[] = [];
  for (let joint = 0; joint < bones.length; joint++) {
    const bone = record(bones[joint], `bones[${joint}]`);
    if (bone.isBone !== true) fail(`bones[${joint}].isBone`);
    const world = matrix(bone.matrixWorld, `bones[${joint}].matrixWorld`);
    const inverse = matrix(inverses[joint], `boneInverses[${joint}]`);
    const local = multiply(bindInverse, multiply(multiply(world, inverse), bind));
    const packed = local.map(value => {
      const result = Math.fround(value);
      if (!Number.isFinite(result)) fail(`joint ${joint} float32 range`);
      return result;
    });
    positions.push(...packed);
    // 与 Three skinnormal_vertex 相同：bindInverse * weightedBoneMatrix * bind。
    normals.push(packed[0]!, packed[4]!, packed[8]!, 0,
      packed[1]!, packed[5]!, packed[9]!, 0, packed[2]!, packed[6]!, packed[10]!, 0);
  }
  const matrices = Object.freeze(positions), normalMatrices = Object.freeze(normals);
  return Object.freeze({ revision, jointCount: bones.length, matrices, normalMatrices,
    normalRule: "three-linear" as const,
    copyPalette: (): SkinningPalette => Object.freeze({ revision,
      matrices: new Float32Array(matrices), normalMatrices: new Float32Array(normalMatrices) }),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}

function matrix(value: unknown, label: string): number[] {
  const elements = record(value, label).elements;
  if (!(Array.isArray(elements) || elements instanceof Float32Array || elements instanceof Float64Array)
    || elements.length !== 16) fail(`${label} dimensions`);
  if (ArrayBuffer.isView(elements) && typeof SharedArrayBuffer !== "undefined"
    && elements.buffer instanceof SharedArrayBuffer) fail(`${label} shared storage`);
  const copy = Array.from(elements as ArrayLike<number>);
  if (!copy.every(value => typeof value === "number" && Number.isFinite(value))) fail(`${label} components`);
  if (copy[3] !== 0 || copy[7] !== 0 || copy[11] !== 0 || copy[15] !== 1) fail(`${label} affine matrix`);
  return copy;
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let value = 0;
    for (let axis = 0; axis < 4; axis++) value += a[axis * 4 + row]! * b[column * 4 + axis]!;
    if (!Number.isFinite(value)) fail("matrix product overflow");
    result[column * 4 + row] = value;
  }
  return result;
}

function fail(label: string): never { throw new Error(`Invalid author skin pose: ${label}.`); }
