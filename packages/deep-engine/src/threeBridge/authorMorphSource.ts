import type { GpuMorphSource, GpuMorphWeights } from "../webgpu/gpuMorphTypes.js";
import { assertMorphWeightRange } from "../webgpu/gpuMorphPacking.js";
import { attribute, component, type AttributeView } from "./attributes.js";

export interface AuthorMorphSourceOptions {
  readonly id: string;
  readonly revision: number;
  /** 输出顶点→作者顶点；允许重复，调用者负责与最终渲染几何保持一致。 */
  readonly vertexRemap?: readonly number[] | Uint32Array;
}

export interface AuthorMorphSource {
  readonly source: GpuMorphSource;
  readonly targetCount: number;
  /** 只读此刻权重，不调用动画更新；返回独立数组。 */
  captureWeights(mesh: unknown, revision: number): GpuMorphWeights;
}

/** 独立静态资源快照；数组归消费者所有，作者 attribute 后续变动需重新捕获并递增 revision。 */
export function captureAuthorMorphSource(geometry: unknown, options: AuthorMorphSourceOptions): AuthorMorphSource {
  validRevision(options?.revision);
  if (typeof options.id !== "string" || !options.id.trim()) fail("source id");
  const g = object(geometry, "geometry");
  if (g.isBufferGeometry !== true || g.isInstancedBufferGeometry) fail("geometry type");
  if (typeof g.morphTargetsRelative !== "boolean") fail("morphTargetsRelative");
  const attributes = object(g.attributes, "attributes"), morph = object(g.morphAttributes, "morphAttributes");
  if (Object.keys(morph).some(key => key !== "position" && key !== "normal")) fail("unsupported morph semantic");
  const position = attribute(attributes.position, 3, "position");
  if (position.count < 1 || position.count > 4_000_000) fail("vertex count");
  const normal = optionalAttribute(attributes.normal, 3, position.count, "normal");
  const tangent = optionalAttribute(attributes.tangent, 4, position.count, "tangent");
  const positions = targetViews(morph.position, position.count, "position");
  const normals = targetViews(morph.normal, position.count, "normal");
  const targetCount = Math.max(positions.length, normals.length);
  if (!targetCount || targetCount > 256 || positions.length && positions.length !== targetCount
    || normals.length && normals.length !== targetCount || normals.length && !normal) fail("target counts");
  const remap = remapIndices(options.vertexRemap, position.count);
  const vertexCount = remap?.length ?? position.count;
  if (vertexCount * 48 * (targetCount + 1) + targetCount * 4 > 256 * 1024 * 1024) fail("GPU byte budget");
  const basePositions = stream(position, 3, remap), baseNormals = normal ? stream(normal, 3, remap) : undefined;
  const baseTangents = tangent ? stream(tangent, 4, remap) : undefined;
  // 既有GPU打包会归一化base normal；非单位作者normal会改变morph基值，先明确拒绝。
  if (baseNormals) for (let i = 0; i < baseNormals.length; i += 3) {
    if (Math.abs(Math.hypot(baseNormals[i]!, baseNormals[i + 1]!, baseNormals[i + 2]!) - 1) > 1e-5) fail("non-unit base normal");
  }
  if (baseTangents) for (let i = 0; i < baseTangents.length; i += 4) {
    const length = Math.hypot(baseTangents[i]!, baseTangents[i + 1]!, baseTangents[i + 2]!);
    if (Math.abs(length - 1) > 1e-5 || Math.abs(baseTangents[i + 3]!) !== 1) fail("base tangent");
    if (baseNormals) {
      const n = i / 4 * 3;
      if (Math.abs(baseTangents[i]! * baseNormals[n]! + baseTangents[i + 1]! * baseNormals[n + 1]!
        + baseTangents[i + 2]! * baseNormals[n + 2]!) > 1e-5) fail("non-orthogonal tangent");
    }
  }
  let maximumDeltaMagnitude = 0;
  const targets = Array.from({ length: targetCount }, (_, index) => {
    const delta = (view: AttributeView | undefined, base: Float32Array | undefined) => {
      if (!view) return undefined;
      const values = stream(view, 3, remap);
      for (let i = 0; i < values.length; i++) {
        values[i] = finite32(values[i]! - (g.morphTargetsRelative ? 0 : base![i]!));
        maximumDeltaMagnitude = Math.max(maximumDeltaMagnitude, Math.abs(values[i]!));
      }
      return values;
    };
    const positionDeltas = delta(positions[index], basePositions), normalDeltas = delta(normals[index], baseNormals);
    return Object.freeze({ index, name: `target-${index}`,
      ...(positionDeltas ? { positionDeltas } : {}), ...(normalDeltas ? { normalDeltas } : {}) });
  });
  let maximumBaseMagnitude = 1;
  for (const values of [basePositions, baseNormals, baseTangents]) if (values) {
    for (const value of values) maximumBaseMagnitude = Math.max(maximumBaseMagnitude, Math.abs(value));
  }
  const source: GpuMorphSource = Object.freeze({ revision: options.revision, positions: basePositions,
    ...(baseNormals ? { normals: baseNormals } : {}), ...(baseTangents ? { tangents: baseTangents } : {}),
    // Three对象不是原始glTF索引；这两个字段仅为当前独立primitive的局部序号。
    primitive: Object.freeze({ id: options.id, sourceMeshIndex: 0, sourcePrimitiveIndex: 0,
      vertexCount, targets: Object.freeze(targets) }),
  });
  return Object.freeze({ source, targetCount, captureWeights(mesh: unknown, revision: number): GpuMorphWeights {
    validRevision(revision);
    const owner = object(mesh, "mesh");
    if (owner.geometry !== geometry) fail("weight source geometry");
    const weights = owner.morphTargetInfluences;
    if (!Array.isArray(weights) || weights.length !== targetCount) fail("weight count/type");
    const values = new Float32Array(targetCount);
    for (let i = 0; i < targetCount; i++) values[i] = finite32(weights[i]);
    assertMorphWeightRange(values, maximumBaseMagnitude, maximumDeltaMagnitude);
    return Object.freeze({ revision, values });
  } });
}

function targetViews(value: unknown, count: number, label: string): AttributeView[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) fail(`${label} target type/count`);
  return Array.from(value, item => optionalAttribute(item, 3, count, `morph ${label}`) ?? fail(`missing ${label} target`));
}
function optionalAttribute(value: unknown, size: number, count: number, label: string): AttributeView | undefined {
  if (value === undefined) return undefined;
  const view = attribute(value, size, label);
  if (view.count !== count) fail(`${label} count`);
  return view;
}
function remapIndices(value: AuthorMorphSourceOptions["vertexRemap"], count: number): number[] | undefined {
  if (value === undefined) return undefined;
  if (!(Array.isArray(value) || value instanceof Uint32Array) || value.length < 1 || value.length > 4_000_000) fail("vertexRemap type/count");
  if (value instanceof Uint32Array && !(value.buffer instanceof ArrayBuffer)) fail("vertexRemap shared storage");
  return Array.from(value, index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) fail("vertexRemap index");
    return index;
  });
}
function stream(view: AttributeView, size: number, remap: number[] | undefined): Float32Array<ArrayBuffer> {
  const values = new Float32Array((remap?.length ?? view.count) * size);
  for (let i = 0; i < values.length / size; i++) for (let axis = 0; axis < size; axis++) {
    values[i * size + axis] = finite32(component(view, remap?.[i] ?? i, axis));
  }
  return values;
}
function finite32(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) fail("float32 components");
  return Math.fround(value as number);
}
function validRevision(value: number): void { if (!Number.isSafeInteger(value) || value < 0) fail("revision"); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}
function fail(label: string): never { throw new Error(`Invalid author morph source: ${label}.`); }
