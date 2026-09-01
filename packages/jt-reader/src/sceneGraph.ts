import { BinaryReader, JtFormatError } from "./binaryReader.js";
import type {
  JtByteOrder,
  JtLogicalElement,
  JtLateLoadedSegment,
  JtPropertyValue,
  JtReadLimits,
  JtSceneGraph,
  JtSceneNode,
} from "./types.js";
import type { LogicalElementSections } from "./logicalElements.js";

const TYPE_NAMES: Readonly<Record<string, string>> = {
  "10dd103e-2ac8-11d1-9b6b-0080c7bb5997": "partition",
  "10dd1035-2ac8-11d1-9b6b-0080c7bb5997": "base",
  "10dd101b-2ac8-11d1-9b6b-0080c7bb5997": "group",
  "10dd102a-2ac8-11d1-9b6b-0080c7bb5997": "instance",
  "10dd102c-2ac8-11d1-9b6b-0080c7bb5997": "lod",
  "ce357245-38fb-11d1-a506-006097bdc6e1": "metadata",
  "ce357244-38fb-11d1-a506-006097bdc6e1": "part",
  "10dd1077-2ac8-11d1-9b6b-0080c7bb5997": "tri-strip-shape",
  "10dd104c-2ac8-11d1-9b6b-0080c7bb5997": "range-lod",
};

const GROUP_TYPES = new Set(["partition", "group", "lod", "metadata", "part", "range-lod"]);
const STRING_ATOM = "10dd106e-2ac8-11d1-9b6b-0080c7bb5997";
const INTEGER_ATOM = "10dd102b-2ac8-11d1-9b6b-0080c7bb5997";
const FLOAT_ATOM = "10dd1019-2ac8-11d1-9b6b-0080c7bb5997";
const MATERIAL_ATTRIBUTE = "10dd1030-2ac8-11d1-9b6b-0080c7bb5997";
const TRANSFORM_ATTRIBUTE = "10dd1083-2ac8-11d1-9b6b-0080c7bb5997";
const LATE_LOADED_ATOM = "e0b05be5-fbbd-11d1-a3a7-00aa00d10954";

function readCountedIds(reader: BinaryReader, offset: number, limit: number, label: string): { ids: number[]; next: number } {
  const count = reader.i32(offset, `${label}数量`);
  if (count < 0 || count > limit) throw new JtFormatError(`${label}数量 ${count} 无效`);
  reader.ensure(offset + 4, count * 4, label);
  const ids = Array.from({ length: count }, (_, index) => reader.i32(offset + 4 + index * 4, label));
  return { ids, next: offset + 4 + count * 4 };
}

function parseNode(element: JtLogicalElement, byteOrder: JtByteOrder, majorVersion: number): JtSceneNode | undefined {
  const kind = TYPE_NAMES[element.objectTypeId];
  if (!kind) return undefined;
  const reader = new BinaryReader(element.payload, byteOrder);
  reader.ensure(0, 10, `节点 ${element.objectId} 基础数据`);
  const localVersionBytes = majorVersion >= 10 ? 1 : 2;
  const attributes = readCountedIds(reader, majorVersion >= 10 ? 5 : 6, 100_000, "节点属性");
  let childObjectIds: number[] = [];
  if (kind === "instance") {
    reader.ensure(attributes.next, localVersionBytes + 4, "实例节点数据");
    childObjectIds = [reader.i32(attributes.next + localVersionBytes, "实例子节点 ID")];
  } else if (GROUP_TYPES.has(kind)) {
    reader.ensure(attributes.next, localVersionBytes + 4, "组节点数据");
    childObjectIds = readCountedIds(reader, attributes.next + localVersionBytes, 1_000_000, "子节点").ids;
  }
  return {
    objectId: element.objectId,
    kind,
    label: `${kind} ${element.objectId}`,
    childObjectIds,
    attributeObjectIds: attributes.ids,
    properties: {},
  };
}

function readMbString(reader: BinaryReader, offset: number): string {
  const length = reader.i32(offset, "MbString 长度");
  if (length < 0 || length > 10_000_000) throw new JtFormatError(`MbString 长度 ${length} 无效`);
  const data = reader.bytes(offset + 4, length * 2, "MbString 内容");
  return new TextDecoder("utf-16le").decode(data).replace(/\0+$/g, "");
}

function parsePropertyAtom(element: JtLogicalElement, byteOrder: JtByteOrder, majorVersion: number): JtPropertyValue | undefined {
  const reader = new BinaryReader(element.payload, byteOrder);
  reader.ensure(0, 6, `属性原子 ${element.objectId}`);
  // JT 9.x 的本地版本号为 U16，JT 10 起压缩为 U8，因此属性值起点相差 2 字节。
  const valueOffset = majorVersion >= 10 ? 6 : 8;
  if (element.objectTypeId === STRING_ATOM) return readMbString(reader, valueOffset);
  if (element.objectTypeId === INTEGER_ATOM) return reader.i32(valueOffset, "整数属性");
  if (element.objectTypeId === FLOAT_ATOM) return reader.f32(valueOffset, "浮点属性");
  return undefined;
}

function parseLateLoadedAtom(
  element: JtLogicalElement,
  byteOrder: JtByteOrder,
  majorVersion: number,
): JtLateLoadedSegment | undefined {
  if (element.objectTypeId !== LATE_LOADED_ATOM) return undefined;
  const reader = new BinaryReader(element.payload, byteOrder);
  const referenceOffset = majorVersion >= 10 ? 6 : 8;
  reader.ensure(referenceOffset, majorVersion >= 10 ? 24 : 28, `延迟加载属性 ${element.objectId}`);
  const reference: JtLateLoadedSegment = {
    id: reader.guid(referenceOffset, "延迟加载数据段 ID"),
    type: reader.i32(referenceOffset + 16, "延迟加载数据段类型"),
  };
  if (majorVersion < 10) reference.payloadObjectId = reader.i32(referenceOffset + 20, "延迟加载对象 ID");
  return reference;
}

function parseMaterialAttribute(
  element: JtLogicalElement,
  byteOrder: JtByteOrder,
  majorVersion: number,
): Record<string, JtPropertyValue> | undefined {
  if (element.objectTypeId !== MATERIAL_ATTRIBUTE) return undefined;
  const reader = new BinaryReader(element.payload, byteOrder);
  // 逻辑元素头已经读取 objectId；JT 9.5 使用 U16 本地版本与 U32 抑制标志，
  // JT 10 使用 U8 本地版本与 U64 抑制标志，二者的颜色起点不同。
  const colorOffset = majorVersion >= 10 ? 13 : 11;
  const hasReflectivity = majorVersion >= 10 || reader.u16(7, "材质版本") === 2;
  reader.ensure(0, colorOffset + 16 * 4 + 4 + (hasReflectivity ? 4 : 0), `材质属性 ${element.objectId}`);
  const rgba = Array.from({ length: 4 }, (_, index) => reader.f32(colorOffset + 16 + index * 4));
  return {
    "material.diffuseR": rgba[0] ?? 0,
    "material.diffuseG": rgba[1] ?? 0,
    "material.diffuseB": rgba[2] ?? 0,
    "material.opacity": rgba[3] ?? 1,
    "material.shininess": reader.f32(colorOffset + 64, "材质光泽度"),
    "material.reflectivity": hasReflectivity ? reader.f32(colorOffset + 68, "材质反射率") : 0,
  };
}

function parseTransformAttribute(
  element: JtLogicalElement,
  byteOrder: JtByteOrder,
  majorVersion: number,
): number[] | undefined {
  if (element.objectTypeId !== TRANSFORM_ATTRIBUTE) return undefined;
  const reader = new BinaryReader(element.payload, byteOrder);
  const baseBytes = majorVersion >= 10 ? 10 : 7;
  const versionBytes = majorVersion >= 10 ? 1 : 2;
  const maskOffset = baseBytes + versionBytes;
  reader.ensure(0, maskOffset + 2, `变换属性 ${element.objectId}`);
  const storedMask = reader.u16(maskOffset, "变换矩阵存储掩码");
  const storedCount = Array.from({ length: 16 }, (_, index) => (storedMask & (0x8000 >>> index)) !== 0)
    .filter(Boolean).length;
  const valuesOffset = maskOffset + 2;
  const remaining = reader.length - valuesOffset;
  const bytesPerValue = storedCount === 0 || remaining === storedCount * 4 ? 4
    : remaining === storedCount * 8 ? 8
      : 0;
  if (bytesPerValue === 0) throw new JtFormatError(`变换属性 ${element.objectId} 的矩阵长度无效`);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let cursor = valuesOffset;
  for (let index = 0; index < 16; index += 1) {
    if ((storedMask & (0x8000 >>> index)) === 0) continue;
    const value = bytesPerValue === 8 ? reader.f64(cursor, "变换矩阵值") : reader.f32(cursor, "变换矩阵值");
    if (!Number.isFinite(value)) throw new JtFormatError(`变换属性 ${element.objectId} 包含非有限数值`);
    matrix[index] = value;
    cursor += bytesPerValue;
  }
  return matrix;
}

function parsePropertyTable(
  bytes: Uint8Array,
  offset: number,
  byteOrder: JtByteOrder,
  limits: JtReadLimits,
): Map<number, Array<[number, number]>> {
  const reader = new BinaryReader(bytes, byteOrder);
  reader.ensure(offset, 6, "属性表头");
  const count = reader.i32(offset + 2, "属性表元素数量");
  if (count < 0 || count > limits.maxLogicalElements) throw new JtFormatError(`属性表元素数量 ${count} 无效`);
  const table = new Map<number, Array<[number, number]>>();
  let cursor = offset + 6;
  for (let index = 0; index < count; index += 1) {
    const objectId = reader.i32(cursor, "属性表对象 ID");
    cursor += 4;
    const pairs: Array<[number, number]> = [];
    while (true) {
      const keyId = reader.i32(cursor, "属性键 ID");
      cursor += 4;
      if (keyId === 0) break;
      if (pairs.length >= limits.maxPropertiesPerElement) throw new JtFormatError("单个元素属性数量超过安全上限");
      const valueId = reader.i32(cursor, "属性值 ID");
      cursor += 4;
      pairs.push([keyId, valueId]);
    }
    table.set(objectId, pairs);
  }
  return table;
}

function preferredLabel(properties: Record<string, JtPropertyValue>, fallback: string): string {
  const keys = ["JT_PROP_NAME", "Name", "NAME", "名称", "Part Name"];
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export function buildSceneGraph(
  bytes: Uint8Array,
  sections: LogicalElementSections,
  byteOrder: JtByteOrder,
  limits: JtReadLimits,
  majorVersion = 10,
): JtSceneGraph {
  const atoms = new Map<number, JtPropertyValue>();
  const lateLoaded = new Map<number, JtLateLoadedSegment>();
  for (const atom of sections.propertyAtoms) {
    const value = parsePropertyAtom(atom, byteOrder, majorVersion);
    if (value !== undefined) atoms.set(atom.objectId, value);
    const reference = parseLateLoadedAtom(atom, byteOrder, majorVersion);
    if (reference) lateLoaded.set(atom.objectId, reference);
  }
  const propertyTable = parsePropertyTable(bytes, sections.propertyTableOffset, byteOrder, limits);
  const attributes = new Map<number, Record<string, JtPropertyValue>>();
  const transforms = new Map<number, number[]>();
  for (const element of sections.sceneElements) {
    const attribute = parseMaterialAttribute(element, byteOrder, majorVersion);
    if (attribute) attributes.set(element.objectId, attribute);
    const transform = parseTransformAttribute(element, byteOrder, majorVersion);
    if (transform) transforms.set(element.objectId, transform);
  }
  const nodes: JtSceneNode[] = [];
  const unknown = new Set<string>();
  for (const element of sections.sceneElements) {
    const node = parseNode(element, byteOrder, majorVersion);
    if (!node) {
      if (element.objectTypeId !== MATERIAL_ATTRIBUTE && element.objectTypeId !== TRANSFORM_ATTRIBUTE) {
        unknown.add(element.objectTypeId);
      }
      continue;
    }
    for (const [keyId, valueId] of propertyTable.get(node.objectId) ?? []) {
      const key = atoms.get(keyId);
      const value = atoms.get(valueId);
      if (typeof key === "string" && value !== undefined) node.properties[key] = value;
      const reference = lateLoaded.get(valueId);
      if (reference) (node.lateLoadedSegments ??= []).push({ ...reference });
    }
    for (const attributeId of node.attributeObjectIds) {
      Object.assign(node.properties, attributes.get(attributeId));
      const transform = transforms.get(attributeId);
      if (transform) node.transform = [...transform];
    }
    node.label = preferredLabel(node.properties, node.label);
    nodes.push(node);
  }
  const childIds = new Set(nodes.flatMap((node) => node.childObjectIds));
  return {
    nodes,
    rootObjectIds: nodes.filter((node) => !childIds.has(node.objectId)).map((node) => node.objectId),
    propertyAtomCount: sections.propertyAtoms.length,
    unknownElementTypeIds: [...unknown].sort(),
  };
}
