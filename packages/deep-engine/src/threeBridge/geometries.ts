import type { GeometryResource } from "../renderPacket.js";
import { generateTangents, validateTangentBasis } from "../gltf/tangentSpace.js";
import { attribute, component, indexAttribute, sameStamp, type AttributeView } from "./attributes.js";
import { ProjectionFailure, invalid, limit, record, unsupported } from "./types.js";

export interface GeometrySlice { readonly start: number; readonly count: number; readonly material: unknown; readonly slot: number; }
export interface GeometryView {
  readonly source: object;
  readonly position: AttributeView;
  readonly normal: AttributeView;
  readonly uv0: AttributeView | undefined;
  readonly uv1: AttributeView | undefined;
  readonly tangent: AttributeView | undefined;
  readonly index: AttributeView | undefined;
  readonly slices: readonly GeometrySlice[];
}
export interface CachedGeometry { readonly stamp: readonly unknown[]; readonly resource: GeometryResource; }
function range(value: unknown, feature: string): { start: number; count: number } {
  const r = record(value, feature), start = r.start as number, count = r.count as number;
  if (!Number.isSafeInteger(start) || start < 0 || !(count === Infinity || Number.isSafeInteger(count) && count >= 0)) invalid(feature);
  return { start, count };
}
export function geometryView(value: unknown, material: unknown): GeometryView {
  const g = record(value, "geometry");
  if (g.isBufferGeometry !== true || g.isInstancedBufferGeometry) unsupported("geometry type");
  const morph = record(g.morphAttributes, "morph attributes");
  if (Object.keys(morph).length) unsupported("morph targets");
  const attributes = record(g.attributes, "geometry attributes");
  const position = attribute(attributes.position, 3, "position"), normal = attribute(attributes.normal, 3, "normal");
  if (position.count !== normal.count) invalid("normal count");
  const uv0 = attributes.uv == null ? undefined : attribute(attributes.uv, 2, "uv");
  const uv1 = attributes.uv1 == null ? undefined : attribute(attributes.uv1, 2, "uv1");
  if (uv0 && position.count !== uv0.count) invalid("uv count");
  if (uv1 && position.count !== uv1.count) invalid("uv1 count");
  const tangent = attributes.tangent == null ? undefined : attribute(attributes.tangent, 4, "tangent");
  if (tangent && position.count !== tangent.count) invalid("tangent count");
  const index = indexAttribute(g.index), total = index?.count ?? position.count;
  const draw = range(g.drawRange, "draw range");
  const slices: GeometrySlice[] = [];
  const add = (group: { start: number; count: number }, assigned: unknown, slot: number) => {
    const start = Math.max(draw.start, group.start), end = Math.min(total, draw.start + draw.count, group.start + group.count);
    // TRIANGLES 忽略末尾不足三个顶点的部分；start 可以落在原始三角序列内部。
    const count = Math.max(0, Math.floor((end - start) / 3) * 3);
    if (count) slices.push({ start, count, material: assigned, slot });
  };
  if (Array.isArray(material)) {
    if (!Array.isArray(g.groups)) invalid("geometry groups");
    if (g.groups.length > 4096) limit("geometry groups");
    g.groups.forEach((value, slot) => {
      const group = range(value, "geometry group"), materialIndex = record(value, "geometry group").materialIndex;
      if (!Number.isSafeInteger(materialIndex) || (materialIndex as number) < 0) invalid("group material index");
      // Three 跳过缺失的 group material；保留原作者的隐藏/空洞语义。
      const assigned = material[materialIndex as number];
      if (assigned) add(group, assigned, slot);
    });
  } else add({ start: 0, count: total }, material, 0);
  return { source: g, position, normal, uv0, uv1, tangent, index, slices };
}
export function projectGeometry(view: GeometryView, slice: GeometrySlice, id: string, previous?: CachedGeometry,
  normalTexCoord?: 0 | 1): CachedGeometry {
  const { position, normal, uv0: uv0View, uv1: uv1View, tangent, index } = view;
  const stamp = [...position.stamp, ...normal.stamp, ...(uv0View?.stamp ?? [null]), ...(uv1View?.stamp ?? [null]),
    ...(normalTexCoord !== undefined ? tangent?.stamp ?? [null] : []), ...(index?.stamp ?? [null]), slice.start, slice.count, normalTexCoord];
  if (previous && sameStamp(previous.stamp, stamp)) return previous;
  if (position.count * (24 + (uv0View ? 8 : 0) + (uv1View ? 8 : 0) + (normalTexCoord !== undefined ? 16 : 0))
    + slice.count * 4 > 128 * 1024 * 1024) limit("geometry bytes");
  const vertices = new Float32Array(position.count * 6), indices = new Uint32Array(slice.count);
  const uv0 = uv0View ? new Float32Array(position.count * 2) : undefined;
  const uv1 = uv1View ? new Float32Array(position.count * 2) : undefined;
  for (let i = 0; i < position.count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      vertices[i * 6 + axis] = component(position, i, axis);
      vertices[i * 6 + axis + 3] = component(normal, i, axis);
    }
    const base = i * 6;
    if (!Number.isFinite(vertices[base]! + vertices[base + 1]! + vertices[base + 2]!
      + vertices[base + 3]! + vertices[base + 4]! + vertices[base + 5]!)) invalid("geometry components");
    if (Math.hypot(vertices[base + 3]!, vertices[base + 4]!, vertices[base + 5]!) < 1e-8) invalid("zero geometry normal");
    if (uv0) {
      uv0[i * 2] = component(uv0View!, i, 0); uv0[i * 2 + 1] = component(uv0View!, i, 1);
      if (!Number.isFinite(uv0[i * 2]! + uv0[i * 2 + 1]!)) invalid("geometry uv components");
    }
    if (uv1) {
      uv1[i * 2] = component(uv1View!, i, 0); uv1[i * 2 + 1] = component(uv1View!, i, 1);
      if (!Number.isFinite(uv1[i * 2]! + uv1[i * 2 + 1]!)) invalid("geometry uv1 components");
    }
  }
  const restart = index?.array instanceof Uint8Array ? 255 : index?.array instanceof Uint16Array ? 65535 : 4294967295;
  for (let i = 0; i < indices.length; i++) {
    const value = index ? component(index, slice.start + i, 0) : slice.start + i;
    if (index && value === restart) unsupported("primitive restart index");
    if (!Number.isSafeInteger(value) || value < 0 || value >= position.count) invalid("geometry index");
    indices[i] = value;
  }
  let resource: Omit<GeometryResource, "id" | "revision"> = {
    vertices, ...(uv0 ? { uv0 } : {}), ...(uv1 ? { uv1 } : {}), indices,
  };
  if (normalTexCoord !== undefined) resource = normalMappedGeometry(resource, tangent, normalTexCoord);
  return { stamp, resource: { id, revision: previous ? previous.resource.revision + 1 : 0, ...resource } };
}

/** 仅法线贴图切片压紧顶点，避免 geometry group 未使用顶点让切线生成产生假失败。 */
function normalMappedGeometry(source: Omit<GeometryResource, "id" | "revision">,
  authored: AttributeView | undefined, texCoord: 0 | 1): Omit<GeometryResource, "id" | "revision"> {
  const selectedUv = texCoord === 1 ? source.uv1 : source.uv0;
  if (!selectedUv) invalid(`normal map UV${texCoord}`);
  const oldByNew: number[] = [], remap = new Map<number, number>(), indices = new Uint32Array(source.indices.length);
  source.indices.forEach((old, index) => {
    let projected = remap.get(old);
    if (projected === undefined) { projected = oldByNew.length; remap.set(old, projected); oldByNew.push(old); }
    indices[index] = projected;
  });
  const vertices = new Float32Array(oldByNew.length * 6);
  const uv0 = source.uv0 ? new Float32Array(oldByNew.length * 2) : undefined;
  const uv1 = source.uv1 ? new Float32Array(oldByNew.length * 2) : undefined;
  oldByNew.forEach((old, projected) => {
    vertices.set(source.vertices.subarray(old * 6, old * 6 + 6), projected * 6);
    if (uv0) uv0.set(source.uv0!.subarray(old * 2, old * 2 + 2), projected * 2);
    if (uv1) uv1.set(source.uv1!.subarray(old * 2, old * 2 + 2), projected * 2);
  });
  const tangentUv = texCoord === 1 ? uv1! : uv0!;
  try {
    let tangents: Float32Array<ArrayBuffer>;
    if (authored) {
      tangents = new Float32Array(oldByNew.length * 4);
      oldByNew.forEach((old, projected) => {
        for (let axis = 0; axis < 4; axis++) tangents[projected * 4 + axis] = component(authored, old, axis);
      });
    } else tangents = generateTangents(vertices, tangentUv, indices, `Three material.normalMap UV${texCoord}`);
    validateTangentBasis(vertices, tangents, indices, "Three material.normalMap");
    return { vertices, ...(uv0 ? { uv0 } : {}), ...(uv1 ? { uv1 } : {}), tangents, indices };
  } catch (error) {
    throw new ProjectionFailure("invalid", "normal tangent basis",
      `Invalid Three normal tangent basis: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
