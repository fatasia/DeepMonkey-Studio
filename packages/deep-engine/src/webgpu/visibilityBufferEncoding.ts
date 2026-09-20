import { unpackLocalTriangle } from "../geometry/localTriangle.js";
import type { MeshletBuildResult } from "../geometry/types.js";

/**
 * P0-2 可见性（visibility）buffer 编码合同 —— 对标 Nanite 延迟材质核心的第一切片。
 *
 * 附件格式 `rg32uint`（R32G32Uint 布局：两个 32-bit uint 通道），每像素两个 u32，loadOp clear 为全 1 哨兵：
 * - `.x` = `visibilitySlot`：本帧 meshlet 间接绘制记录的槽位 id（u32 全域，0xFFFFFFFF 保留为哨兵）。
 *   一个 slot 唯一对应一个（batch × 选中层级 × 实例）meshlet draw group，同时是 resolve 材质
 *   参数表（storage 数组）的下标。层级内的"源 meshlet id"在 constant instance mapping 下
 *   不可达 shader（firstInstance 恒 0，instance 数据经 vertex buffer 偏移承载），因此它不属于
 *   本切片编码——这是诚实边界，补齐需要 per-meshlet 实例展开（deferred）。
 * - `.y` = 位 [7:0] `triangleLocalIndex`：meshlet 内三角局部索引（0..125，meshlet 上限 126 三角；
 *   位 [31:8] 保留为 0）。
 *
 * WGSL 无法直接取 primitive index，且展开索引的顶点 id 在 meshlet 间共享全局槽位，
 * `vertex_index` 既不是三角形序号也无法局部化（共享 executor 的 baseVertex 固定为 0，
 * per-command 偏移不可表达）。本合同因此采用**无共享三角主序顶点布局**（见
 * `buildVisibilityMeshletLayout`）：每个 meshlet 的三角形按序展开为独立顶点槽，
 * 伴随 uint32 `carrier` 顶点属性直接携带"meshlet 内三角局部索引"直达 fragment——
 * 不伪造 primitive id，也不依赖 sequential 索引技巧。三角内重心坐标重建（需要第三
 * 通道或屏幕空间导数恢复）不属于本切片（deferred）。
 */

export const VISIBILITY_ATTACHMENT_FORMAT = "rg32uint" as const;
/** 每通道哨兵：clear 值不可能命中合法 slot（表容量有限）或合法三角索引。 */
export const VISIBILITY_CLEAR_SLOT = 0xffff_ffff;
export const VISIBILITY_MAX_TRIANGLES_PER_MESHLET = 126;
export const VISIBILITY_TRIANGLE_BITS = 8;
export const VISIBILITY_TRIANGLE_MASK = (1 << VISIBILITY_TRIANGLE_BITS) - 1;

/** `.y` 通道位打包：三角局部索引置于低 8 位，保留位必须为 0。 */
export function packVisibilityTriangle(triangleLocal: number): number {
  if (!Number.isSafeInteger(triangleLocal) || triangleLocal < 0
    || triangleLocal >= VISIBILITY_MAX_TRIANGLES_PER_MESHLET) {
    throw new RangeError(`Visibility triangle index must be an integer in [0, ${VISIBILITY_MAX_TRIANGLES_PER_MESHLET}).`);
  }
  return triangleLocal & VISIBILITY_TRIANGLE_MASK;
}

export function unpackVisibilityTriangle(packed: number): number {
  if (!Number.isSafeInteger(packed)) throw new RangeError("Visibility channel must be a safe integer.");
  return packed & VISIBILITY_TRIANGLE_MASK;
}

/** Resolve 侧合法像素判定：与 WGSL `isVisibilityCovered` 逐条对拍。 */
export function isValidVisibilityPixel(slot: number, packedTriangle: number): boolean {
  return slot !== VISIBILITY_CLEAR_SLOT && Number.isSafeInteger(slot)
    && (packedTriangle & ~VISIBILITY_TRIANGLE_MASK) === 0
    && unpackVisibilityTriangle(packedTriangle) < VISIBILITY_MAX_TRIANGLES_PER_MESHLET;
}

/** 实例行 36 浮点（144 字节）：[0..11] 模型行、[12..23] 法线行、[24..27] colorMetal、
 * [28..31] material、[32..35] emissiveAlpha —— 与 forward 顶点属性 locations 2..9/12 一致。 */
export const INSTANCE_ROW_FLOATS = 36;
/** Slot 表行 16 浮点（64 字节）：与 WGSL `VisibilityMaterialSlot` 逐字段对拍。 */
export const VISIBILITY_SLOT_ROW_FLOATS = 16;

export interface VisibilitySlotRow {
  /** colorMetal：rgb = 基础色，w = metal。 */
  readonly colorMetal: readonly [number, number, number, number];
  /** material：x = roughness，y = alphaCutoff，z = doubleSided，w = flags。 */
  readonly material: readonly [number, number, number, number];
  /** emissiveAlpha：rgb = 自发光，w = alpha。 */
  readonly emissiveAlpha: readonly [number, number, number, number];
}

/** 从实例行提取 slot 表行：与 forward plain 着色读取的实例数据完全同源，per-instance 语义无损。 */
export function visibilitySlotRowFromInstance(instanceRow: Float32Array): VisibilitySlotRow {
  if (instanceRow.length < INSTANCE_ROW_FLOATS) throw new Error("Visibility slot row needs a full 36-float instance row.");
  const quad = (offset: number): [number, number, number, number] =>
    [instanceRow[offset]!, instanceRow[offset + 1]!, instanceRow[offset + 2]!, instanceRow[offset + 3]!];
  return { colorMetal: quad(24), material: quad(28), emissiveAlpha: quad(32) };
}

export function packVisibilitySlotRow(row: VisibilitySlotRow, target = new Float32Array(VISIBILITY_SLOT_ROW_FLOATS)): Float32Array {
  target.set(row.colorMetal, 0); target.set(row.material, 4); target.set(row.emissiveAlpha, 8);
  target.set([0, 0, 0, 0], 12);
  return target;
}

export function unpackVisibilitySlotRow(packed: Float32Array, slot: number): VisibilitySlotRow {
  if (packed.length < VISIBILITY_SLOT_ROW_FLOATS) throw new Error("Visibility slot table row is truncated.");
  const quad = (offset: number): [number, number, number, number] =>
    [packed[offset]!, packed[offset + 1]!, packed[offset + 2]!, packed[offset + 3]!];
  void slot;
  return { colorMetal: quad(0), material: quad(4), emissiveAlpha: quad(8) };
}

export interface VisibilityMeshletLayout {
  /** 恒等索引 [0..slotCount)：无共享布局下索引值即顶点槽位，整个层级一条 drawIndexed 即可。 */
  readonly indices: Uint32Array<ArrayBuffer>;
  /** 无共享三角主序 position：槽位值 = 真实顶点位置的拷贝（跨 meshlet 重复以解除共享）。 */
  readonly positions: Float32Array<ArrayBuffer>;
  /** carrier 顶点属性：每个槽位携带所属 meshlet 内的三角局部索引（0..125）。 */
  readonly triangleCarriers: Uint32Array<ArrayBuffer>;
}

/**
 * 由 meshlet 构建结果推导可见性光栅化专用布局。遍历顺序与 `expandMeshletIndices` 完全一致
 * （meshlet 顺序 × 三角顺序），winding=flip 与展开路径同步交换 b/c，保证面朝向一致。
 * position 数值逐位等于源顶点：可见性 pass 与 forward 的 clip 深度由同一公式、同一数值算出。
 */
export function buildVisibilityMeshletLayout(value: MeshletBuildResult, positions: Float32Array,
  winding: "preserve" | "flip" = "preserve"): VisibilityMeshletLayout {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
    throw new Error("Visibility meshlet layout needs tightly packed XYZ positions.");
  }
  const total = value.sourceTriangleCount * 3;
  const indices = new Uint32Array(total);
  const swizzled = new Float32Array(total * 3);
  const carriers = new Uint32Array(total);
  let slot = 0;
  for (let meshlet = 0; meshlet < value.meshletCount; meshlet += 1) {
    const descriptor = meshlet * 4;
    const vertexOffset = value.descriptors[descriptor]!;
    const triangleOffset = value.descriptors[descriptor + 2]!;
    const triangleCount = value.descriptors[descriptor + 3]!;
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const local = unpackLocalTriangle(value.localTriangleIndices[triangleOffset + triangle]!);
      const corners = winding === "flip" ? [local[0], local[2], local[1]] : [local[0], local[1], local[2]];
      for (let corner = 0; corner < 3; corner += 1) {
        indices[slot] = slot;
        carriers[slot] = triangle;
        const realVertex = value.vertexRemap[vertexOffset + corners[corner]!]!;
        if (realVertex * 3 + 2 >= positions.length) throw new Error("Visibility layout vertex remap leaves position bounds.");
        swizzled.set(positions.subarray(realVertex * 3, realVertex * 3 + 3), slot * 3);
        slot += 1;
      }
    }
  }
  return { indices, positions: swizzled, triangleCarriers: carriers };
}

/** 列主序 4×4 一般求逆（WebGPU/uniform 约定）：m[column*4+row]。用于 resolve 从深度重建世界位置。 */
export function invertMat4(m: ArrayLike<number>): Float32Array<ArrayBuffer> {
  if (m.length < 16) throw new Error("Matrix inversion needs 16 elements.");
  const at = (index: number): number => m[index]!;
  const [a00, a01, a02, a03] = [at(0), at(1), at(2), at(3)];
  const [a10, a11, a12, a13] = [at(4), at(5), at(6), at(7)];
  const [a20, a21, a22, a23] = [at(8), at(9), at(10), at(11)];
  const [a30, a31, a32, a33] = [at(12), at(13), at(14), at(15)];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error("Visibility resolve cannot invert a singular view-projection.");
  }
  const inverse = new Float32Array(16);
  const set = (index: number, numerator: number): void => { inverse[index] = numerator / determinant; };
  set(0, a11 * b11 - a12 * b10 + a13 * b09); set(1, a02 * b10 - a01 * b11 - a03 * b09);
  set(2, a31 * b05 - a32 * b04 + a33 * b03); set(3, a22 * b04 - a21 * b05 - a23 * b03);
  set(4, a12 * b08 - a10 * b11 - a13 * b07); set(5, a00 * b11 - a02 * b08 + a03 * b07);
  set(6, a32 * b02 - a30 * b05 - a33 * b01); set(7, a20 * b05 - a22 * b02 + a23 * b01);
  set(8, a10 * b10 - a11 * b08 + a13 * b06); set(9, a01 * b08 - a00 * b10 - a03 * b06);
  set(10, a30 * b04 - a31 * b02 + a33 * b00); set(11, a21 * b02 - a22 * b01 - a23 * b00);
  set(12, a11 * b07 - a10 * b09 - a12 * b06); set(13, a00 * b09 - a01 * b07 + a02 * b06);
  set(14, a31 * b01 - a30 * b03 - a32 * b00); set(15, a22 * b00 - a21 * b01 + a20 * b03);
  return inverse;
}
