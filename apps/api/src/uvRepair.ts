import { Document, NodeIO, type Accessor, type Primitive, type TypedArray } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import { decodeScalarIndices, decodeVec3Attribute } from "./meshProcessingShared.js";
import { compareUvChannelNames, decodeVec2Attribute } from "./uvInspection.js";

/**
 * T12 几何处理切片之 UV 修复:**默认全部关闭,调用方显式启用**;所有操作逐一记录
 * (修了什么/多少),不静默。输入永不 mutate,输出为深拷贝;同输入两次调用逐位一致。
 *
 * 操作语义(同图元内先折回、后焊接,焊接键基于折回后的值):
 * - UV_WRAP_NORMALIZE:仅对 <0 或 >1 的分量做 v - floor(v) 折回 [0,1);[0,1] 内不动。
 *   仅在通道具备平铺(wrapping)语义时无损——对 CLAMP_TO_EDGE 采样,折回会改变采样结果,
 *   调用方应先跑 uvInspection 确认越界与声明状态(操作 detail 恒标 assumesWrappingSemantics)。
 * - UV_WELD_DUPLICATES:合并「键属性全部一致」的重复顶点并重建索引。核心链键 =
 *   POSITION + 全部 TEXCOORD 通道;GLB 适配器经 weldKeyColumns 传入该图元**全部属性**
 *   (含 NORMAL/COLOR 等,防止跨属性差异被错误合并导致着色损坏)。
 *   同位置不同 UV 的真实接缝不会被合并。
 */

export type UvRepairOperationName = "UV_WRAP_NORMALIZE" | "UV_WELD_DUPLICATES";

export interface UvRepairOptions {
  wrapNormalize?: boolean | undefined;
  weldDuplicates?: boolean | undefined;
  /** 焊接键的附加属性列(GLB 适配器传全部属性;列数据按旧顶点序,长度须为 elementSize×顶点数)。 */
  weldKeyColumns?: WeldAttributeColumn[] | undefined;
}

export interface WeldAttributeColumn {
  name: string;
  elementSize: number;
  data: ArrayLike<number>;
}

export interface UvRepairablePrimitive {
  primitiveId: string;
  /** 连续 XYZ(3N)。 */
  positions: Float32Array;
  /** 三角列表索引(3M)。 */
  indices: Uint32Array;
  /** 通道名 → 连续 UV(2N)。 */
  uvChannels: Record<string, Float32Array>;
}

export interface UvRepairOperation {
  primitiveId: string;
  operation: UvRepairOperationName;
  /** 作用范围:折回为单个通道;焊接为键属性列表(排序逗号连接)。 */
  scope: string;
  /** 是否产生实际改动;false = 检查后无需改动(显式记录,不是静默跳过)。 */
  applied: boolean;
  /** 机器可读计数(修改分量数/修改顶点数/合并顶点数/前后顶点数等)。 */
  counts: Record<string, number>;
  detail: string;
}

export interface UvWeldMapping {
  vertexMapping: Uint32Array;
  vertexCountAfter: number;
  keyColumns: string[];
}

export interface UvRepairPrimitiveResult {
  /** 修复后的新数组;被拒绝时为输入的深拷贝(未改动)。 */
  primitive: UvRepairablePrimitive;
  operations: UvRepairOperation[];
  /** 输入畸形无法安全修复时的拒绝原因;正常为 undefined。 */
  rejected?: string | undefined;
  /** 焊接生效时的顶点映射,供调用方重映射附加属性列(GLB 全属性重建)。 */
  weld?: UvWeldMapping | undefined;
}

export interface UvGlbRepairPrimitiveRecord {
  primitiveId: string;
  /** 是否产生任何几何改动(供调用方判断是否需要重传/重写产物)。 */
  changed: boolean;
  operations: UvRepairOperation[];
  rejection?: string | undefined;
}

export interface UvGlbRepairReport {
  primitiveCount: number;
  changedPrimitiveCount: number;
  outputWritten: boolean;
  outputPath: string;
  primitives: UvGlbRepairPrimitiveRecord[];
  /** 全部操作记录(含 applied:false),按图元 id → 操作名排序。 */
  operations: UvRepairOperation[];
}

/** 模 1 折回单个通道:返回新数组(不 mutate 输入),记录修改分量数与修改顶点数。 */
export function wrapNormalizeChannel(uvs: Float32Array): {
  data: Float32Array;
  valuesChanged: number;
  verticesChanged: number;
} {
  const data = new Float32Array(uvs.length);
  let valuesChanged = 0;
  let verticesChanged = 0;
  for (let vertex = 0; vertex * 2 < uvs.length; vertex += 1) {
    let changed = false;
    for (let axis = 0; axis < 2; axis += 1) {
      const value = uvs[vertex * 2 + axis]!;
      if (value < 0 || value > 1) {
        data[vertex * 2 + axis] = value - Math.floor(value);
        valuesChanged += 1;
        changed = true;
      } else {
        data[vertex * 2 + axis] = value;
      }
    }
    if (changed) verticesChanged += 1;
  }
  return { data, valuesChanged, verticesChanged };
}

/**
 * 通用顶点去重:按给定列(调用方固定列序即可复现)构造精确键(-0 归一化),
 * 首见顶点保持原序,重复顶点重映射到首见。列长不一致或索引越界时抛错
 * (核心链捕获转为 rejected;GLB 链逐图元捕获转为 rejection 记录)。
 */
export function dedupeVerticesByAttributeKeys(
  columns: WeldAttributeColumn[],
  indices: Uint32Array,
): { indices: Uint32Array; vertexMapping: Uint32Array; vertexCountBefore: number; vertexCountAfter: number; mergedCount: number } {
  if (columns.length === 0) throw new Error("dedupeVerticesByAttributeKeys: 至少需要一列属性");
  const vertexCount = columns[0]!.data.length / columns[0]!.elementSize;
  for (const column of columns) {
    if (!Number.isInteger(column.elementSize) || column.elementSize <= 0) {
      throw new Error(`dedupeVerticesByAttributeKeys: 列 ${column.name} elementSize 非法`);
    }
    if (column.data.length !== vertexCount * column.elementSize) {
      throw new Error(`dedupeVerticesByAttributeKeys: 列 ${column.name} 长度 ${column.data.length} 与顶点数 ${vertexCount} 不一致`);
    }
  }
  const vertexMapping = new Uint32Array(vertexCount);
  const firstSeen = new Map<string, number>();
  const parts: string[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    parts.length = 0;
    for (const column of columns) {
      for (let element = 0; element < column.elementSize; element += 1) {
        const value = column.data[vertex * column.elementSize + element]!;
        parts.push(value === 0 ? "0" : String(value));
      }
    }
    const key = parts.join("|");
    const seen = firstSeen.get(key);
    if (seen === undefined) {
      firstSeen.set(key, vertex);
      vertexMapping[vertex] = vertex;
    } else {
      vertexMapping[vertex] = seen;
    }
  }
  const rebuilt = new Uint32Array(indices.length);
  for (let offset = 0; offset < indices.length; offset += 1) {
    const mapped = vertexMapping[indices[offset]!];
    if (mapped === undefined) {
      throw new Error(`dedupeVerticesByAttributeKeys: 索引 ${indices[offset]} 越界(顶点数 ${vertexCount})`);
    }
    rebuilt[offset] = mapped;
  }
  return {
    indices: rebuilt,
    vertexMapping,
    vertexCountBefore: vertexCount,
    vertexCountAfter: firstSeen.size,
    mergedCount: vertexCount - firstSeen.size,
  };
}

function countNonFinite(values: ArrayLike<number>): number {
  let count = 0;
  for (let offset = 0; offset < values.length; offset += 1) {
    if (!Number.isFinite(values[offset]!)) count += 1;
  }
  return count;
}

function validateRepairable(primitive: UvRepairablePrimitive): string | undefined {
  if (primitive.positions.length % 3 !== 0) {
    return `POSITION 长度 ${primitive.positions.length} 不是 3 的倍数`;
  }
  if (countNonFinite(primitive.positions) > 0) return "POSITION 含非有限值";
  const vertexCount = primitive.positions.length / 3;
  if (primitive.indices.length % 3 !== 0) return `索引长度 ${primitive.indices.length} 不是 3 的倍数`;
  for (let offset = 0; offset < primitive.indices.length; offset += 1) {
    const value = primitive.indices[offset]!;
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
      return `索引 ${value} 越界(顶点数 ${vertexCount})`;
    }
  }
  for (const channel of Object.keys(primitive.uvChannels).sort(compareUvChannelNames)) {
    const uvs = primitive.uvChannels[channel]!;
    if (uvs.length !== vertexCount * 2) {
      return `${channel} 长度 ${uvs.length} 与顶点数*2=${vertexCount * 2} 不一致`;
    }
    if (countNonFinite(uvs) > 0) return `${channel} 含非有限值`;
  }
  return undefined;
}

/** 单图元修复:折回(先)→ 焊接(后,键基于折回后的值);输入永不 mutate。畸形输入拒绝并原样返回,不抛异常。 */
export function repairPrimitiveUvs(
  primitive: UvRepairablePrimitive,
  options: UvRepairOptions,
): UvRepairPrimitiveResult {
  const operations: UvRepairOperation[] = [];
  const invalid = validateRepairable(primitive);
  if (invalid !== undefined) {
    return { primitive: copyPrimitive(primitive), operations, rejected: invalid };
  }
  const working = copyPrimitive(primitive);
  const channelNames = Object.keys(primitive.uvChannels).sort(compareUvChannelNames);

  if (options.wrapNormalize === true) {
    let anyChanged = false;
    let valuesChangedTotal = 0;
    let verticesChangedTotal = 0;
    for (const channel of channelNames) {
      const wrapped = wrapNormalizeChannel(primitive.uvChannels[channel]!);
      working.uvChannels[channel] = wrapped.data;
      valuesChangedTotal += wrapped.valuesChanged;
      verticesChangedTotal += wrapped.verticesChanged;
      if (wrapped.valuesChanged > 0) {
        anyChanged = true;
        operations.push({
          primitiveId: primitive.primitiveId,
          operation: "UV_WRAP_NORMALIZE",
          scope: channel,
          applied: true,
          counts: { valuesChanged: wrapped.valuesChanged, verticesChanged: wrapped.verticesChanged },
          detail: `channel:${channel} valuesChanged:${wrapped.valuesChanged}`
            + ` verticesChanged:${wrapped.verticesChanged} assumesWrappingSemantics:true(折回仅在平铺采样语义下无损)`,
        });
      }
    }
    if (!anyChanged) {
      operations.push({
        primitiveId: primitive.primitiveId,
        operation: "UV_WRAP_NORMALIZE",
        scope: channelNames.join(","),
        applied: false,
        counts: { valuesChanged: 0, verticesChanged: 0, channels: channelNames.length },
        detail: `channels:${channelNames.join(",")} 无越界分量,未改动`,
      });
    }
  }

  if (options.weldDuplicates === true) {
    try {
      // 键列:调用方提供 weldKeyColumns 时完全取代默认键(GLB 链传全部属性);
      // 缺省键 = POSITION + 全部 TEXCOORD 通道,且基于折回后的 working 值
      // (语义:先折回、后焊接;u=2 与 u=0 折回后同键可合并)。
      const keyColumns: WeldAttributeColumn[] = options.weldKeyColumns ?? [
        { name: "POSITION", elementSize: 3, data: primitive.positions },
        ...channelNames.map((channel) => ({ name: channel, elementSize: 2, data: working.uvChannels[channel]! })),
      ];
      const deduped = dedupeVerticesByAttributeKeys(keyColumns, primitive.indices);
      working.indices = deduped.indices;
      working.positions = gatherRows(primitive.positions, 3, deduped.vertexMapping, deduped.vertexCountAfter);
      for (const channel of channelNames) {
        working.uvChannels[channel] = gatherRows(working.uvChannels[channel]!, 2, deduped.vertexMapping, deduped.vertexCountAfter);
      }
      operations.push({
        primitiveId: primitive.primitiveId,
        operation: "UV_WELD_DUPLICATES",
        scope: keyColumns.map((column) => column.name).join(","),
        applied: deduped.mergedCount > 0,
        counts: {
          mergedVertices: deduped.mergedCount,
          verticesBefore: deduped.vertexCountBefore,
          verticesAfter: deduped.vertexCountAfter,
          keyAttributes: keyColumns.length,
        },
        detail: `keys:${keyColumns.map((column) => column.name).join(",")}`
          + ` verticesBefore:${deduped.vertexCountBefore} verticesAfter:${deduped.vertexCountAfter}`
          + ` merged:${deduped.mergedCount}(同位置不同 UV 的真实接缝不会被合并)`,
      });
      return {
        primitive: working,
        operations,
        weld: {
          vertexMapping: deduped.vertexMapping,
          vertexCountAfter: deduped.vertexCountAfter,
          keyColumns: keyColumns.map((column) => column.name),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { primitive: copyPrimitive(primitive), operations, rejected: `焊接失败:${message}` };
    }
  }

  return { primitive: working, operations };
}

function gatherRows(data: Float32Array, elementSize: number, mapping: Uint32Array, newCount: number): Float32Array {
  const out = new Float32Array(newCount * elementSize);
  for (let oldVertex = 0; oldVertex < mapping.length; oldVertex += 1) {
    const newVertex = mapping[oldVertex]!;
    for (let element = 0; element < elementSize; element += 1) {
      out[newVertex * elementSize + element] = data[oldVertex * elementSize + element]!;
    }
  }
  return out;
}

function copyPrimitive(primitive: UvRepairablePrimitive): UvRepairablePrimitive {
  const uvChannels: Record<string, Float32Array> = {};
  for (const [channel, uvs] of Object.entries(primitive.uvChannels)) {
    uvChannels[channel] = new Float32Array(uvs);
  }
  return {
    primitiveId: primitive.primitiveId,
    positions: new Float32Array(primitive.positions),
    indices: new Uint32Array(primitive.indices),
    uvChannels,
  };
}

/** GLB 适配器:读取 → 逐图元修复(焊接键 = 全部属性)→ 写出新文件 → 返回操作记录。输入文件不被修改。 */
export async function repairGlbUvs(
  inputPath: string,
  outputPath: string,
  options: UvRepairOptions,
): Promise<UvGlbRepairReport> {
  const io = await glbIo();
  const document = await io.read(inputPath);
  const buffer = document.getRoot().listBuffers()[0];
  const records: UvGlbRepairPrimitiveRecord[] = [];
  document.getRoot().listMeshes().forEach((mesh, meshIndex) => {
    mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
      const record = repairGlbPrimitive(document, primitive, `mesh:${meshIndex}/primitive:${primitiveIndex}`, options, buffer);
      records.push(record);
    });
  });
  await io.write(outputPath, document);
  const operations = records.flatMap((record) => record.operations)
    .sort((left, right) => left.primitiveId.localeCompare(right.primitiveId)
      || left.operation.localeCompare(right.operation));
  return {
    primitiveCount: records.length,
    changedPrimitiveCount: records.filter((record) => record.changed).length,
    outputWritten: true,
    outputPath,
    primitives: records,
    operations,
  };
}

function repairGlbPrimitive(
  document: Document,
  primitive: Primitive,
  primitiveId: string,
  options: UvRepairOptions,
  buffer: import("@gltf-transform/core").Buffer | undefined,
): UvGlbRepairPrimitiveRecord {
  try {
    if (primitive.getMode() !== 4 || !primitive.getAttribute("POSITION")) {
      return { primitiveId, changed: false, operations: [], rejection: "非 TRIANGLES 图元或缺 POSITION,跳过修复" };
    }
    const positionAccessor = primitive.getAttribute("POSITION")!;
    const uvChannels: Record<string, Float32Array> = {};
    for (const semantic of primitive.listSemantics()) {
      if (!/^TEXCOORD_\d+$/.test(semantic)) continue;
      const accessor = primitive.getAttribute(semantic);
      if (!accessor) continue;
      uvChannels[semantic] = decodeVec2Attribute(accessor);
    }
    // GLB 焊接键 = 全部属性(含 NORMAL/COLOR 等),防止跨属性差异顶点被错误合并;
    // UV 键列与核心链同序先折回,保证「折回→焊接」语义跨链一致。
    const semantics = primitive.listSemantics();
    const accessors = primitive.listAttributes();
    const oldCount = accessors[0]!.getCount();
    const uvChannelNames = new Set(Object.keys(uvChannels));
    const weldKeyColumns = options.weldDuplicates === true
      ? semantics.map((semantic, index) => {
        const accessor = accessors[index]!;
        const data = readColumn(accessor, oldCount);
        if (options.wrapNormalize === true && uvChannelNames.has(semantic)) {
          for (let offset = 0; offset < data.length; offset += 1) {
            const value = data[offset]!;
            if (value < 0 || value > 1) data[offset] = value - Math.floor(value);
          }
        }
        return { name: semantic, elementSize: accessor.getElementSize(), data };
      })
      : undefined;
    const result = repairPrimitiveUvs({
      primitiveId,
      positions: decodeVec3Attribute(positionAccessor),
      indices: primitive.getIndices() ? decodeScalarIndices(primitive.getIndices()!) : sequence(oldCount),
      uvChannels,
    }, { ...options, weldKeyColumns });
    if (result.rejected !== undefined) {
      return { primitiveId, changed: false, operations: result.operations, rejection: result.rejected };
    }
    let changed = false;
    // 折回:替换发生改动的 TEXCOORD 通道(输出统一 FLOAT VEC2)。
    for (const operation of result.operations) {
      if (operation.operation !== "UV_WRAP_NORMALIZE" || !operation.applied) continue;
      changed = true;
      replaceUvChannel(document, primitive, operation.scope, result.primitive.uvChannels[operation.scope]!, buffer);
    }
    // 焊接生效:UV 通道直接落核心链产出的最终数组(已折回+已重映射);
    // 其余属性(NORMAL/COLOR 等)按顶点映射从原 accessor 重建;索引替换为焊接后结果。
    if (result.weld && result.operations.some((operation) => operation.operation === "UV_WELD_DUPLICATES" && operation.applied)) {
      changed = true;
      const weld = result.weld;
      semantics.forEach((semantic, index) => {
        if (uvChannelNames.has(semantic)) {
          const current = primitive.getAttribute(semantic)!;
          current.dispose();
          primitive.setAttribute(semantic, newBufferedAccessor(document, buffer, "VEC2",
            result.primitive.uvChannels[semantic]!));
          return;
        }
        rebuildAccessorRows(document, primitive, semantic, accessors[index]!, weld.vertexMapping, weld.vertexCountAfter, buffer);
      });
      const indicesNext = newBufferedAccessor(document, buffer, "SCALAR", result.primitive.indices);
      primitive.getIndices()?.dispose();
      primitive.setIndices(indicesNext);
    }
    return { primitiveId, changed, operations: result.operations };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { primitiveId, changed: false, operations: [], rejection: `修复异常:${message}` };
  }
}

function replaceUvChannel(
  document: Document,
  primitive: Primitive,
  channel: string,
  data: Float32Array,
  buffer: import("@gltf-transform/core").Buffer | undefined,
): void {
  const original = primitive.getAttribute(channel);
  if (!original) return;
  primitive.setAttribute(channel, newBufferedAccessor(document, buffer, "VEC2", data));
  original.dispose();
}

function newBufferedAccessor(
  document: Document,
  buffer: import("@gltf-transform/core").Buffer | undefined,
  type: "VEC2" | "SCALAR",
  data: Float32Array | Uint32Array,
): Accessor {
  const accessor = document.createAccessor().setType(type).setArray(data as unknown as TypedArray);
  if (buffer) accessor.setBuffer(buffer);
  return accessor;
}

/** 按顶点映射重写单个 accessor(保留类型/normalized/数组构造器),原 accessor dispose。 */
function rebuildAccessorRows(
  document: Document,
  primitive: Primitive,
  semantic: string,
  accessor: Accessor,
  mapping: Uint32Array,
  newCount: number,
  buffer: import("@gltf-transform/core").Buffer | undefined,
): void {
  const elementSize = accessor.getElementSize();
  const sourceArray = accessor.getArray();
  const element: number[] = new Array(elementSize).fill(0);
  const rows: Array<number[] | undefined> = new Array(newCount);
  for (let oldVertex = 0; oldVertex < mapping.length; oldVertex += 1) {
    accessor.getElement(oldVertex, element);
    const newVertex = mapping[oldVertex]!;
    if (rows[newVertex] === undefined) rows[newVertex] = [...element];
  }
  const ArrayConstructor = sourceArray && sourceArray.constructor !== Array
    ? sourceArray.constructor as new(length: number) => Float32Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array
    : Float32Array;
  const flat = new ArrayConstructor(newCount * elementSize);
  for (let newVertex = 0; newVertex < newCount; newVertex += 1) {
    const row = rows[newVertex];
    if (row === undefined) continue;
    for (let elementIndex = 0; elementIndex < elementSize; elementIndex += 1) {
      flat[newVertex * elementSize + elementIndex] = row[elementIndex]!;
    }
  }
  const next = document.createAccessor()
    .setType(accessor.getType())
    .setNormalized(accessor.getNormalized())
    .setArray(flat as unknown as TypedArray);
  if (buffer) next.setBuffer(buffer);
  primitive.setAttribute(semantic, next);
  accessor.dispose();
}

/** 逐元素读取属性列为 Float64(保留原值精度;重建输出按原 accessor 数组构造器落盘)。 */
function readColumn(accessor: Accessor, count: number): Float64Array {
  const elementSize = accessor.getElementSize();
  const out = new Float64Array(count * elementSize);
  const element: number[] = new Array(elementSize).fill(0);
  for (let index = 0; index < count; index += 1) {
    accessor.getElement(index, element);
    for (let elementIndex = 0; elementIndex < elementSize; elementIndex += 1) {
      out[index * elementSize + elementIndex] = element[elementIndex]!;
    }
  }
  return out;
}

function sequence(count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) out[index] = index;
  return out;
}

let glbIoPromise: Promise<NodeIO> | undefined;

async function glbIo(): Promise<NodeIO> {
  glbIoPromise ??= draco3d.createDecoderModule().then((decoder) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder }));
  return glbIoPromise;
}
