/**
 * RayBackend WGSL storage buffer 布局（波次4 软件执行器）。
 *
 * == BvhNode 字节映射合同（与 bvhBuilder.ts 序列化逐字节对应，stride 48B） ==
 * WGSL struct 对齐 16B（vec4f 成员），stride 48B = 3×16B，满足 array<BvhNode> 步长合同。
 * 每节点 12 个 u32 槽位（words），f32 槽与 u32 槽共用同一 buffer 双视图写入：
 *
 *   byte  0..15  boundMin: vec4f  = (minX, minY, minZ, 0)   ← w 为 pad（CPU bounds 无 w）
 *   byte 16..31  boundMax: vec4f  = (maxX, maxY, maxZ, 0)   ← w 为 pad
 *   byte 32..35  leftFirst : u32  内部=左子节点索引；叶=首三角形槽位（order 基址）
 *   byte 36..39  count     : u32  叶=三角形数（>0）；内部=0
 *   byte 40..43  rightChild: u32  内部=右子节点索引；叶=0xFFFFFFFF（BVH_LEAF_SENTINEL）
 *   byte 44..47  pad0      : u32  恒 0
 *
 * 节点 i 起始于字节 i×48（words i×12）；根恒为节点 0；内部节点 count=0 且 rightChild 有效
 * （递归构建中与 leftFirst 不相邻，遍历不得假设相邻）。
 *
 * == 三角形缓冲 ==
 * vertices: array<f32>（stride 4B，blas.vertices 原样拷贝，顶点 v 在字节 v×12）；
 * indices: array<u32>（blas.indices 原样拷贝，全局三角 t 的三顶点 = indices[3t..3t+2]）；
 * triangleOrder: array<u32>（buildBvh 重排表 order 原样拷贝，槽位→全局三角索引）。
 *
 * == 射线/命中记录 ==
 * rayStream: array<vec4f>（stride 16B，每射线 2 槽 32B）：
 *   槽 [2i]   = (ox, oy, oz, tMax)，槽 [2i+1] = (dx, dy, dz, 0)。
 * hitRecords: array<HitRecord>（stride 16B）：t: f32 @0 / primitiveIndex: u32 @4 /
 *   status: u32 @8 / pad: u32 @12。status 合同：0=miss（t 恒 -1）、1=hit、
 *   2=栈溢出 fail-closed（t/primitiveIndex 无效，整批作废）。
 * CPU 参考合同（rayTrace.traceClosest）不计算重心坐标（barycentric 恒 0），GPU 同语义。
 */

import type { BvhBuildResult } from "./bvhBuilder.js";
import type { RayBatchQuery } from "./rayBackendTypes.js";

/** BvhNode storage stride：48 字节 = 12 words。 */
export const BVH_NODE_STRIDE_BYTES = 48;
export const BVH_NODE_STRIDE_WORDS = 12;
/** 叶节点 rightChild 哨兵（CPU 侧 undefined 的显式化）。 */
export const BVH_LEAF_SENTINEL = 0xffff_ffff;
/** 命中记录 stride：16 字节 = 4 words。 */
export const HIT_RECORD_STRIDE_BYTES = 16;
/** 每射线打包 words：2×vec4f = 8 floats = 32 字节。 */
export const RAY_RECORD_WORDS = 8;

/** 遍历栈深上限（words/节点数）。中位分裂最坏深度 ≤ ceil(log2(maxBlasTriangles)) = 22 < 32；超限 fail-closed 记 STATUS_STACK_OVERFLOW，禁止静默截断。 */
export const RAY_TRACE_STACK_CAPACITY = 32;
/** kernel workgroup 尺寸（x 维，每 lane 一射线）。 */
export const RAY_TRACE_WORKGROUP_SIZE = 64;

export const HIT_STATUS = Object.freeze({ miss: 0, hit: 1, stackOverflow: 2 } as const);
export type HitStatus = (typeof HIT_STATUS)[keyof typeof HIT_STATUS];

// —— BvhNode 槽位偏移（words，相对节点基址） ——
export const BVH_NODE_WORD = Object.freeze({
  boundMinX: 0, boundMinY: 1, boundMinZ: 2, boundMinPad: 3,
  boundMaxX: 4, boundMaxY: 5, boundMaxZ: 6, boundMaxPad: 7,
  leftFirst: 8, count: 9, rightChild: 10, pad0: 11,
} as const);
// —— HitRecord 槽位偏移（words） ——
export const HIT_RECORD_WORD = Object.freeze({ t: 0, primitiveIndex: 1, status: 2, pad0: 3 } as const);

export interface SerializedBvhNode {
  readonly leftFirst: number;
  readonly count: number;
  /** 叶节点为 null（buffer 中为 BVH_LEAF_SENTINEL）。 */
  readonly rightChild: number | null;
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
}

/** BvhBuildResult → storage buffer 字节（见头注释映射；空 BVH 产出零长度 buffer）。 */
export function serializeBvhNodes(built: BvhBuildResult): ArrayBuffer {
  const buffer = new ArrayBuffer(built.nodes.length * BVH_NODE_STRIDE_BYTES);
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const w = BVH_NODE_WORD;
  for (const [index, node] of built.nodes.entries()) {
    const base = index * BVH_NODE_STRIDE_WORDS;
    floats[base + w.boundMinX] = node.minX;
    floats[base + w.boundMinY] = node.minY;
    floats[base + w.boundMinZ] = node.minZ;
    floats[base + w.boundMinPad] = 0;
    floats[base + w.boundMaxX] = node.maxX;
    floats[base + w.boundMaxY] = node.maxY;
    floats[base + w.boundMaxZ] = node.maxZ;
    floats[base + w.boundMaxPad] = 0;
    words[base + w.leftFirst] = node.leftFirst;
    words[base + w.count] = node.count;
    words[base + w.rightChild] = node.rightChild ?? BVH_LEAF_SENTINEL;
    words[base + w.pad0] = 0;
  }
  return buffer;
}

/** 反序列化（roundtrip/对拍验证用；与 serializeBvhNodes 严格互逆）。 */
export function deserializeBvhNodes(buffer: ArrayBuffer): readonly SerializedBvhNode[] {
  if (buffer.byteLength % BVH_NODE_STRIDE_BYTES !== 0) {
    throw new Error(`BVH node buffer must be a multiple of ${BVH_NODE_STRIDE_BYTES} bytes.`);
  }
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const w = BVH_NODE_WORD;
  const nodes: SerializedBvhNode[] = [];
  for (let base = 0; base < words.length; base += BVH_NODE_STRIDE_WORDS) {
    const rightChild = words[base + w.rightChild]!;
    nodes.push({
      leftFirst: words[base + w.leftFirst]!,
      count: words[base + w.count]!,
      rightChild: rightChild === BVH_LEAF_SENTINEL ? null : rightChild,
      minX: floats[base + w.boundMinX]!, minY: floats[base + w.boundMinY]!, minZ: floats[base + w.boundMinZ]!,
      maxX: floats[base + w.boundMaxX]!, maxY: floats[base + w.boundMaxY]!, maxZ: floats[base + w.boundMaxZ]!,
    });
  }
  return nodes;
}

/** RayBatchQuery → 交错 rayStream（fail-closed：流长度不一致或 tMax 非有限正数即抛错）。 */
export function packRayBatch(query: RayBatchQuery): Float32Array {
  const rayCount = query.tMax.length;
  if (query.origins.length !== rayCount * 3 || query.directions.length !== rayCount * 3) {
    throw new Error("Ray batch streams must be 3 floats per ray and agree in length.");
  }
  const packed = new Float32Array(rayCount * RAY_RECORD_WORDS);
  for (let index = 0; index < rayCount; index++) {
    const tMax = query.tMax[index]!;
    if (!(tMax > 0) || !Number.isFinite(tMax)) {
      throw new Error(`Ray batch tMax must be finite and positive at ray ${index}.`);
    }
    packed[index * RAY_RECORD_WORDS] = query.origins[index * 3]!;
    packed[index * RAY_RECORD_WORDS + 1] = query.origins[index * 3 + 1]!;
    packed[index * RAY_RECORD_WORDS + 2] = query.origins[index * 3 + 2]!;
    packed[index * RAY_RECORD_WORDS + 3] = tMax;
    packed[index * RAY_RECORD_WORDS + 4] = query.directions[index * 3]!;
    packed[index * RAY_RECORD_WORDS + 5] = query.directions[index * 3 + 1]!;
    packed[index * RAY_RECORD_WORDS + 6] = query.directions[index * 3 + 2]!;
  }
  return packed;
}

export interface RawHitRecord {
  readonly index: number;
  readonly t: number;
  readonly primitiveIndex: number;
  readonly status: HitStatus | number;
}

/** 命中记录缓冲 → 逐射线记录（status 不做归一，校验由执行器 fail-closed）。 */
export function unpackHitRecords(buffer: ArrayBuffer): readonly RawHitRecord[] {
  if (buffer.byteLength % HIT_RECORD_STRIDE_BYTES !== 0) {
    throw new Error(`Hit record buffer must be a multiple of ${HIT_RECORD_STRIDE_BYTES} bytes.`);
  }
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const w = HIT_RECORD_WORD;
  const records: RawHitRecord[] = [];
  for (let index = 0; index < words.length / 4; index++) {
    const base = index * 4;
    records.push({
      index,
      t: floats[base + w.t]!,
      primitiveIndex: words[base + w.primitiveIndex]!,
      status: words[base + w.status]!,
    });
  }
  return records;
}

/** 栈溢出计数缓冲（单个 atomic<u32>）→ 数值。非零即整批 fail-closed。 */
export function unpackStackOverflows(buffer: ArrayBuffer): number {
  if (buffer.byteLength !== 4) throw new Error("Stack overflow buffer must be exactly 4 bytes.");
  return new Uint32Array(buffer)[0]!;
}
