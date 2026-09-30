/**
 * I 级 C1 3DGS——CPU 深度排序口径(首刀合同:排序在 CPU,不在 GPU radix)。
 *
 * 视空间深度 = -(view · pos).z(列主序 view 矩阵,第三行取 z);
 * 相机前方 depth>0,越大越远。计数排序 65536 桶,O(n) 一趟直方图 +
 * 一趟前缀和 + 一趟散列;桶内按原始顺序稳定(同深度不闪序)。
 * 输出 far→near 索引,供 alpha 混合 back-to-front 绘制。
 */
import { SPLAT_RECORD_FLOAT_STRIDE, SplatParseError } from "./splatFormatContract.js";

export const SPLAT_DEPTH_SORT_BUCKET_COUNT = 65536;

/** 计算每粒视空间深度(列主序 4×4 view 矩阵,含相机平移项 m14)。 */
export function computeSplatViewDepths(
  records: Float32Array,
  splatCount: number,
  viewMatrix: ArrayLike<number>,
): Float32Array {
  const depths = new Float32Array(splatCount);
  const rowZ0 = viewMatrix[2]!, rowZ1 = viewMatrix[6]!, rowZ2 = viewMatrix[10]!;
  const rowZTranslation = viewMatrix[14]!;
  for (let splatIndex = 0; splatIndex < splatCount; splatIndex++) {
    const base = splatIndex * SPLAT_RECORD_FLOAT_STRIDE;
    const viewZ = rowZ0 * records[base]! + rowZ1 * records[base + 1]! + rowZ2 * records[base + 2]!
      + rowZTranslation;
    const depth = -viewZ;
    if (!Number.isFinite(depth)) {
      throw new SplatParseError(`Splat #${splatIndex} produced a non-finite view depth; view matrix or position is invalid.`);
    }
    depths[splatIndex] = depth;
  }
  return depths;
}

/**
 * far→near 排序索引。相机后方(深度为负)落最深桶最先绘制,
 * 被近处混合覆盖,视觉安全;同深度稳定。
 */
export function sortSplatIndicesByDepth(
  records: Float32Array,
  splatCount: number,
  viewMatrix: ArrayLike<number>,
): Uint32Array {
  const depths = computeSplatViewDepths(records, splatCount, viewMatrix);
  if (splatCount === 0) return new Uint32Array(0);

  let minDepth = Infinity, maxDepth = -Infinity;
  for (let index = 0; index < splatCount; index++) {
    const depth = depths[index]!;
    if (depth < minDepth) minDepth = depth;
    if (depth > maxDepth) maxDepth = depth;
  }
  const range = Math.max(maxDepth - minDepth, Number.EPSILON);
  const scale = (SPLAT_DEPTH_SORT_BUCKET_COUNT - 1) / range;

  const histogram = new Uint32Array(SPLAT_DEPTH_SORT_BUCKET_COUNT);
  const bucketOf = new Uint32Array(splatCount);
  for (let index = 0; index < splatCount; index++) {
    const bucket = ((depths[index]! - minDepth) * scale) | 0;
    bucketOf[index] = bucket;
    histogram[bucket]!++;
  }

  // far→near:深桶(大下标)排前;桶内保持原顺序(稳定)。
  const offsets = new Uint32Array(SPLAT_DEPTH_SORT_BUCKET_COUNT);
  for (let bucket = SPLAT_DEPTH_SORT_BUCKET_COUNT - 1; bucket > 0; bucket--) {
    offsets[bucket - 1] = offsets[bucket]! + histogram[bucket]!;
  }
  const order = new Uint32Array(splatCount);
  for (let index = 0; index < splatCount; index++) {
    const bucket = bucketOf[index]!;
    order[offsets[bucket]!++] = index;
  }
  return order;
}
