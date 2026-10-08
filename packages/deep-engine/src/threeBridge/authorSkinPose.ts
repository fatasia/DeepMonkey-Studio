import type { SkinningPalette } from "../webgpu/gpuSkinningTypes.js";

interface GenericPaletteState {
  readonly source: unknown;
  readonly inputs: readonly number[];
  readonly matrices: Float32Array;
  readonly normalMatrices: Float32Array;
}
const genericPaletteStates = new WeakMap<SkinningPalette, GenericPaletteState>();

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
  const identityBind = isIdentity(bind) && isIdentity(bindInverse);
  const positions = new Array<number>(bones.length * 16), normals = new Array<number>(bones.length * 12);
  const worldInverse = new Float64Array(16), bound = new Float64Array(16), local = new Float64Array(16);
  for (let joint = 0; joint < bones.length; joint++) {
    const bone = record(bones[joint], `bones[${joint}]`);
    if (bone.isBone !== true) fail(`bones[${joint}].isBone`);
    const world = matrix(bone.matrixWorld, `bones[${joint}].matrixWorld`);
    const inverse = matrix(inverses[joint], `boneInverses[${joint}]`);
    writeJointPose(world, inverse, bind, bindInverse, identityBind, joint, positions, normals, worldInverse, bound, local);
  }
  const matrices = Object.freeze(positions), normalMatrices = Object.freeze(normals);
  return Object.freeze({ revision, jointCount: bones.length, matrices, normalMatrices,
    normalRule: "three-linear" as const,
    copyPalette: (): SkinningPalette => Object.freeze({ revision,
      matrices: new Float32Array(matrices), normalMatrices: new Float32Array(normalMatrices) }),
  });
}

export function captureAuthorSkinPalette(source: unknown, revision: number, previous?: SkinningPalette): SkinningPalette {
  if (!Number.isSafeInteger(revision) || revision < 0) fail("revision");
  const mesh = record(source, "mesh");
  if (mesh.isSkinnedMesh !== true) fail("SkinnedMesh");
  const skeleton = record(mesh.skeleton, "skeleton");
  const bones = skeleton.bones, inverses = skeleton.boneInverses;
  if (!Array.isArray(bones) || !Array.isArray(inverses) || bones.length < 1
    || bones.length > 65_535 || bones.length !== inverses.length) fail("bone/inverse count");
  const bind = matrix(mesh.bindMatrix, "bindMatrix"), bindInverse = matrix(mesh.bindMatrixInverse, "bindMatrixInverse");
  if (!isIdentity(bind) || !isIdentity(bindInverse)) return captureGenericSkinPalette(source, revision, previous);
  // The accepted palette belongs to this mesh's poseId; no cross-mesh reuse.
  const old = previous?.matrices.length === bones.length * 16 && previous.normalMatrices?.length === bones.length * 12 ? previous : undefined;
  let matrices: Float32Array<ArrayBuffer> | undefined, normalMatrices: Float32Array<ArrayBuffer> | undefined;
  for (let joint = 0; joint < bones.length; joint++) {
    const bone = record(bones[joint], `bones[${joint}]`);
    if (bone.isBone !== true) fail(`bones[${joint}].isBone`);
    const world = matrix(bone.matrixWorld, `bones[${joint}].matrixWorld`);
    const inverse = matrix(inverses[joint], `boneInverses[${joint}]`);
    if (!isIdentity(inverse)) return captureGenericSkinPalette(source, revision, previous);
    const start = joint * 16;
    let changed = !old;
    for (let index = 0; index < 16; index++) {
      const value = Math.fround(world[index]!);
      if (!Number.isFinite(value)) fail(`joint ${joint} float32 range`);
      if (old && value !== old.matrices[start + index]) changed = true;
    }
    if (!changed) continue;
    if (!matrices) { matrices = old ? new Float32Array(old.matrices) : new Float32Array(bones.length * 16);
      normalMatrices = old ? new Float32Array(old.normalMatrices!) : new Float32Array(bones.length * 12); }
    for (let index = 0; index < 16; index++) matrices[start + index] = Math.fround(world[index]!);
    for (let row = 0; row < 3; row++) {
      const offset = joint * 12 + row * 4;
      normalMatrices![offset] = matrices[start + row]!;
      normalMatrices![offset + 1] = matrices[start + row + 4]!;
      normalMatrices![offset + 2] = matrices[start + row + 8]!;
      normalMatrices![offset + 3] = 0;
    }
  }
  return matrices ? { revision, matrices, normalMatrices: normalMatrices! } : old!;
}

/** Reuse only this mesh's unchanged validated source and an unmodified owned result. */
function captureGenericSkinPalette(source: unknown, revision: number, previous: SkinningPalette | undefined): SkinningPalette {
  const mesh = record(source, "mesh"), skeleton = record(mesh.skeleton, "skeleton");
  const bones = skeleton.bones as unknown[], inverses = skeleton.boneInverses as unknown[];
  const cached = previous && genericPaletteStates.get(previous);
  let same = cached?.source === source, offset = 0;
  const inputMatrices: ArrayLike<number>[] = [];
  const observe = (values: ArrayLike<number>): void => {
    inputMatrices.push(values);
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      if (cached?.inputs[offset++] !== value) same = false;
    }
  };
  observe(matrix(mesh.bindMatrix, "bindMatrix")); observe(matrix(mesh.bindMatrixInverse, "bindMatrixInverse"));
  for (let joint = 0; joint < bones.length; joint++) {
    const bone = record(bones[joint], `bones[${joint}]`);
    if (bone.isBone !== true) fail(`bones[${joint}].isBone`);
    observe(matrix(bone.matrixWorld, `bones[${joint}].matrixWorld`));
    observe(matrix(inverses[joint], `boneInverses[${joint}]`));
  }
  if (same && cached && cached.inputs.length === offset
    && samePaletteValues(previous!.matrices, cached.matrices)
    && samePaletteValues(previous!.normalMatrices, cached.normalMatrices)) return previous!;
  const matrices = new Float32Array(bones.length * 16), normalMatrices = new Float32Array(bones.length * 12);
  const bind = inputMatrices[0]!, bindInverse = inputMatrices[1]!;
  const identityBind = isIdentity(bind) && isIdentity(bindInverse);
  const worldInverse = new Float64Array(16), bound = new Float64Array(16), local = new Float64Array(16);
  for (let joint = 0; joint < bones.length; joint++) writeJointPose(inputMatrices[2 + joint * 2]!,
    inputMatrices[3 + joint * 2]!, bind, bindInverse, identityBind, joint, matrices, normalMatrices, worldInverse, bound, local);
  const palette = Object.freeze({ revision, matrices, normalMatrices });
  genericPaletteStates.set(palette, { source, inputs: inputMatrices.flatMap(values => Array.from(values)),
    matrices: palette.matrices.slice(), normalMatrices: palette.normalMatrices!.slice() });
  return palette;
}

/** The public immutable snapshot and dynamic typed snapshot share exactly the same bone math. */
function writeJointPose(world: ArrayLike<number>, inverse: ArrayLike<number>, bind: ArrayLike<number>,
  bindInverse: ArrayLike<number>, identityBind: boolean, joint: number,
  positions: number[] | Float32Array, normals: number[] | Float32Array,
  worldInverse: Float64Array, bound: Float64Array, local: Float64Array): void {
  const directWorld = identityBind && isIdentity(inverse);
  if (!directWorld) multiplyInto(worldInverse, world, inverse);
  if (!identityBind) { multiplyInto(bound, worldInverse, bind); multiplyInto(local, bindInverse, bound); }
  const poseMatrix = directWorld ? world : identityBind ? worldInverse : local;
  const positionStart = joint * 16, normalStart = joint * 12;
  for (let component = 0; component < 16; component++) {
    const result = Math.fround(poseMatrix[component]!);
    if (!Number.isFinite(result)) fail(`joint ${joint} float32 range`);
    positions[positionStart + component] = result;
  }
  // Match Three's linear normal transform, including legal zero-scale bones.
  for (let row = 0; row < 3; row++) {
    const offset = normalStart + row * 4;
    normals[offset] = positions[positionStart + row]!;
    normals[offset + 1] = positions[positionStart + row + 4]!;
    normals[offset + 2] = positions[positionStart + row + 8]!;
    normals[offset + 3] = 0;
  }
}

function samePaletteValues(a: Float32Array | undefined, b: Float32Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let index = 0; index < b.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}

function matrix(value: unknown, label: string): ArrayLike<number> {
  const elements = record(value, label).elements;
  if (!(Array.isArray(elements) || elements instanceof Float32Array || elements instanceof Float64Array)
    || elements.length !== 16) fail(`${label} dimensions`);
  if (ArrayBuffer.isView(elements) && typeof SharedArrayBuffer !== "undefined"
    && elements.buffer instanceof SharedArrayBuffer) fail(`${label} shared storage`);
  const values = elements as ArrayLike<number>;
  for (let index = 0; index < 16; index++) {
    const component = values[index];
    if (typeof component !== "number" || !Number.isFinite(component)) fail(`${label} components`);
  }
  if (values[3] !== 0 || values[7] !== 0 || values[11] !== 0 || values[15] !== 1) fail(`${label} affine matrix`);
  return values;
}

function multiplyInto(result: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let value = 0;
    for (let axis = 0; axis < 4; axis++) value += a[axis * 4 + row]! * b[column * 4 + axis]!;
    if (!Number.isFinite(value)) fail("matrix product overflow");
    result[column * 4 + row] = value;
  }
}

function isIdentity(matrix: ArrayLike<number>): boolean {
  for (let index = 0; index < 16; index++) {
    if (matrix[index] !== (index % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
}

function fail(label: string): never { throw new Error(`Invalid author skin pose: ${label}.`); }
