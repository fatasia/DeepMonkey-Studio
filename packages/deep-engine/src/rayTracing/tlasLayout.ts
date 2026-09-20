/**
 * RayBackend 两级（TLAS 实例层）存储布局。BvhNode 48B 布局与射线/单级 HitRecord 合同
 * 沿用 rayTraceLayout.ts（同文不重复）；本文件只定义实例层映射与多 BLAS 拼接方案。
 *
 * == TlasInstance 字节映射（stride 128B = 8×vec4 = 32 words，成员全 16B 对齐） ==
 *   byte   0..15  boundsMin: vec4f = (minX, minY, minZ, 0)   实例世界 AABB（tlas.buildTlas instanceBounds）
 *   byte  16..31  boundsMax: vec4f = (maxX, maxY, maxZ, 0)
 *   byte  32..47  row0: vec4f = worldToLocal 第 0 行 (m0,m1,m2,m3)   行主序 3×4：local = M × world
 *   byte  48..63  row1: vec4f = (m4,m5,m6,m7)
 *   byte  64..79  row2: vec4f = (m8,m9,m10,m11)
 *   byte  80..95  meta0: vec4u = (instanceIndex, mask, nodeBase, triangleBase)
 *       instanceIndex = 实例在 tlas.instances 的原始下标（= buildBvh order 值）；两级 HitRecord pad0 同值
 *       mask          = 实例可见性掩码（与射线 mask 按位与为 0 即整实例跳过）
 *       nodeBase      = 该实例 BLAS 节点段在全局 nodes 缓冲的基址（节点下标，非字节）；BLAS 遍历 nodes[nodeBase+i]
 *       triangleBase  = 该实例 BLAS 三角段基址（全局三角下标空间）；叶子槽位 = triangleBase + node.leftFirst + local
 *   byte  96..111 pad0: vec4u = 0
 *   byte 112..127 pad1: vec4u = 0
 * 记录按 TLAS BVH order 槽位排列：records[s] = instances[order[s]]——kernel 叶子直接
 * tlasInstances[leftFirst + local]，无需单独 order 绑定（省一条 storage binding，8 条封顶）。
 *
 * == 全局缓冲拼接（多 BLAS → 单一 storage buffer 的偏移方案） ==
 *   nodes    = [ TLAS 节点 (tlas.built) ][ BLAS 节点 0 ][ BLAS 节点 1 ]…（48B/节点，同 rayTraceLayout）
 *       TLAS 段恒在前，故 BLAS nodeBase ≥ TLAS 节点数；TLAS 段内遍历直接 nodes[i]（i < nodeBase）。
 *   vertices = [ BLAS 0 顶点 ][ BLAS 1 顶点 ]…（f32×3/顶点，全局顶点下标 = vertexBase + 局部下标）
 *   indices  = 打包时逐 BLAS 加 vertexBase 重映射后顺序拼接 ⇒ kernel fetchVertex 用全局下标，
 *       无需 per-instance 顶点基址；两级 HitRecord.primitiveIndex 即这里的全局三角下标。
 *   triangleOrder = [ triangleBase0 + blasOrder0 ][ triangleBase1 + blasOrder1 ]…（打包时合成全局三角下标）
 *
 * == 两级 HitRecord 附加合同（16B 布局同 rayTraceLayout） ==
 *   单级 pad0 恒 0；两级 pad0 = instanceIndex（命中实例原始下标；miss/溢出 = 0xFFFFFFFF）。
 */

import { buildBvh } from "./bvhBuilder.js";
import { BVH_LEAF_SENTINEL, serializeBvhNodes } from "./rayTraceLayout.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";
import type { TlasBuildResult } from "./tlas.js";

export const TLAS_INSTANCE_STRIDE_BYTES = 128;
export const TLAS_INSTANCE_STRIDE_WORDS = 32;
/** 两级 miss/溢出时 instanceIndex 槽位的哨兵（与 BVH_LEAF_SENTINEL 同值）。 */
export const TLAS_INSTANCE_SENTINEL = BVH_LEAF_SENTINEL;

// —— TlasInstance 槽位偏移（words，相对记录基址；row0/row1/row2 为 4-word 行起点） ——
export const TLAS_INSTANCE_WORD = Object.freeze({
  boundsMinX: 0, boundsMinY: 1, boundsMinZ: 2, boundsMinPad: 3,
  boundsMaxX: 4, boundsMaxY: 5, boundsMaxZ: 6, boundsMaxPad: 7,
  row0: 8, row1: 12, row2: 16,
  instanceIndex: 20, mask: 21, nodeBase: 22, triangleBase: 23,
} as const);

/** 单实例 BLAS 在全局拼接空间中的落位（下标 = TLAS order 槽位）。 */
export interface TlasBlasPlacement {
  readonly instanceIndex: number;
  readonly mask: number;
  readonly worldToLocal: readonly number[];
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
  readonly nodeBase: number;
  readonly triangleBase: number;
  readonly vertexBase: number;
  readonly triangleCount: number;
}

export interface TlasPackedScene {
  readonly instanceCount: number;
  readonly tlasNodeCount: number;
  readonly blasNodeCount: number;
  readonly triangleCount: number;
  /** instanceCount × 128B，按 TLAS order 槽位排列。 */
  readonly recordBytes: ArrayBuffer;
  /** (tlasNodeCount + blasNodeCount) × 48B，TLAS 段在前。 */
  readonly nodeBytes: ArrayBuffer;
  readonly vertices: Float32Array;
  /** 已按 vertexBase 重映射的全局索引。 */
  readonly indices: Uint32Array;
  /** 已按 triangleBase 合成的全局 order（值 = 全局三角下标）。 */
  readonly order: Uint32Array;
  /** 下标 = TLAS order 槽位（与 recordBytes 排列一致）。 */
  readonly placements: readonly TlasBlasPlacement[];
}

/** TLAS → 全 GPU 缓冲打包（纯函数，无 GPU 依赖）。order 引用的实例缺世界盒即 fail-closed。 */
export function packTlasScene(tlas: TlasBuildResult): TlasPackedScene {
  interface Slot { blas: RayBlasDescriptor; nodeBytes: ArrayBuffer; order: ReadonlyArray<number>;
    instanceIndex: number; mask: number; worldToLocal: readonly number[];
    bounds: NonNullable<TlasBuildResult["instanceBounds"][number]>; nodeBase: number; triangleBase: number; vertexBase: number }
  const tlasNodeCount = tlas.built.nodes.length;
  const slots: Slot[] = [];
  for (let slot = 0; slot < tlas.built.order.length; slot++) {
    const instanceIndex = tlas.built.order[slot]!;
    const instance = tlas.instances[instanceIndex]!;
    const bounds = tlas.instanceBounds[instanceIndex];
    if (bounds === undefined) throw new Error(`TLAS order references instance ${instanceIndex} without world bounds.`);
    const built = buildBvh({ vertices: instance.blas.vertices, indices: instance.blas.indices });
    slots.push({ blas: instance.blas, nodeBytes: serializeBvhNodes(built), order: built.order,
      instanceIndex, mask: instance.mask >>> 0, worldToLocal: instance.worldToLocal, bounds,
      nodeBase: 0, triangleBase: 0, vertexBase: 0 });
  }
  let nodeCursor = tlasNodeCount, triangleCursor = 0, vertexCursor = 0;
  for (const slot of slots) {
    slot.nodeBase = nodeCursor;
    slot.triangleBase = triangleCursor;
    slot.vertexBase = vertexCursor / 3;
    nodeCursor += slot.nodeBytes.byteLength / 48;
    triangleCursor += slot.order.length;
    vertexCursor += slot.blas.vertices.length;
  }
  const recordBytes = new ArrayBuffer(slots.length * TLAS_INSTANCE_STRIDE_BYTES);
  const recordFloats = new Float32Array(recordBytes);
  const recordWords = new Uint32Array(recordBytes);
  const w = TLAS_INSTANCE_WORD;
  slots.forEach((slot, recordSlot) => {
    const base = recordSlot * TLAS_INSTANCE_STRIDE_WORDS;
    recordFloats[base + w.boundsMinX] = slot.bounds.minX;
    recordFloats[base + w.boundsMinY] = slot.bounds.minY;
    recordFloats[base + w.boundsMinZ] = slot.bounds.minZ;
    recordFloats[base + w.boundsMaxX] = slot.bounds.maxX;
    recordFloats[base + w.boundsMaxY] = slot.bounds.maxY;
    recordFloats[base + w.boundsMaxZ] = slot.bounds.maxZ;
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 4; column++) {
        recordFloats[base + w.row0 + row * 4 + column] = slot.worldToLocal[row * 4 + column]!;
      }
    }
    recordWords[base + w.instanceIndex] = slot.instanceIndex;
    recordWords[base + w.mask] = slot.mask;
    recordWords[base + w.nodeBase] = slot.nodeBase;
    recordWords[base + w.triangleBase] = slot.triangleBase;
  });
  const blasNodeCount = slots.reduce((sum, slot) => sum + slot.nodeBytes.byteLength / 48, 0);
  const nodeBytes = new ArrayBuffer((tlasNodeCount + blasNodeCount) * 48);
  new Uint8Array(nodeBytes).set(new Uint8Array(serializeBvhNodes(tlas.built)), 0);
  let nodeByteCursor = tlasNodeCount * 48;
  const vertices = new Float32Array(vertexCursor);
  const indices = new Uint32Array(triangleCursor * 3);
  const order = new Uint32Array(triangleCursor);
  const placements: TlasBlasPlacement[] = [];
  slots.forEach((slot) => {
    new Uint8Array(nodeBytes).set(new Uint8Array(slot.nodeBytes), nodeByteCursor);
    nodeByteCursor += slot.nodeBytes.byteLength;
    vertices.set(slot.blas.vertices, slot.vertexBase * 3);
    // 全局三角 t 的索引段在 [t*3, t*3+3)；本 BLAS 段起点 = triangleBase*3（与顶点段独立计数）。
    for (let local = 0; local < slot.blas.indices.length; local++) {
      indices[slot.triangleBase * 3 + local] = slot.vertexBase + slot.blas.indices[local]!;
    }
    for (let local = 0; local < slot.order.length; local++) {
      order[slot.triangleBase + local] = slot.triangleBase + slot.order[local]!;
    }
    placements.push({ instanceIndex: slot.instanceIndex, mask: slot.mask, worldToLocal: slot.worldToLocal,
      minX: slot.bounds.minX, minY: slot.bounds.minY, minZ: slot.bounds.minZ,
      maxX: slot.bounds.maxX, maxY: slot.bounds.maxY, maxZ: slot.bounds.maxZ,
      nodeBase: slot.nodeBase, triangleBase: slot.triangleBase, vertexBase: slot.vertexBase,
      triangleCount: slot.order.length });
  });
  return {
    instanceCount: slots.length, tlasNodeCount, blasNodeCount, triangleCount: triangleCursor,
    recordBytes, nodeBytes, vertices, indices, order, placements,
  };
}

export interface SerializedTlasInstance {
  readonly instanceIndex: number;
  readonly mask: number;
  readonly nodeBase: number;
  readonly triangleBase: number;
  readonly worldToLocal: readonly number[];
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
}

/** 反序列化（roundtrip/对拍验证用；与 packTlasScene 的记录段严格互逆）。 */
export function deserializeTlasInstanceRecords(buffer: ArrayBuffer): readonly SerializedTlasInstance[] {
  if (buffer.byteLength % TLAS_INSTANCE_STRIDE_BYTES !== 0) {
    throw new Error(`TLAS instance buffer must be a multiple of ${TLAS_INSTANCE_STRIDE_BYTES} bytes.`);
  }
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const w = TLAS_INSTANCE_WORD;
  const records: SerializedTlasInstance[] = [];
  for (let base = 0; base < words.length; base += TLAS_INSTANCE_STRIDE_WORDS) {
    records.push({
      instanceIndex: words[base + w.instanceIndex]!, mask: words[base + w.mask]!,
      nodeBase: words[base + w.nodeBase]!, triangleBase: words[base + w.triangleBase]!,
      worldToLocal: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((offset) => floats[base + w.row0 + offset]!),
      minX: floats[base + w.boundsMinX]!, minY: floats[base + w.boundsMinY]!, minZ: floats[base + w.boundsMinZ]!,
      maxX: floats[base + w.boundsMaxX]!, maxY: floats[base + w.boundsMaxY]!, maxZ: floats[base + w.boundsMaxZ]!,
    });
  }
  return records;
}

export interface RawTlasHitRecord {
  readonly index: number;
  readonly t: number;
  readonly primitiveIndex: number;
  readonly status: number;
  /** 两级合同：命中实例原始下标；miss/溢出 = TLAS_INSTANCE_SENTINEL（单级该槽恒 0）。 */
  readonly instanceIndex: number;
}

/** 两级命中记录缓冲 → 逐射线记录（16B stride，pad0 读作 instanceIndex）。 */
export function unpackTlasHitRecords(buffer: ArrayBuffer): readonly RawTlasHitRecord[] {
  if (buffer.byteLength % 16 !== 0) throw new Error("Hit record buffer must be a multiple of 16 bytes.");
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const records: RawTlasHitRecord[] = [];
  for (let index = 0; index < words.length / 4; index++) {
    const base = index * 4;
    records.push({
      index, t: floats[base]!, primitiveIndex: words[base + 1]!, status: words[base + 2]!,
      instanceIndex: words[base + 3]!,
    });
  }
  return records;
}
