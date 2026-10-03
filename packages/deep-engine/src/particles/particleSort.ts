/**
 * T20 切片:透明粒子 back-to-front 排序(Unity Shuriken `Sort Mode: By Distance` 同语义)。
 *
 * 计数排序(O(n),稳定,确定性):按到视点的欧氏距离量化进 bins 个桶,远者先画。
 * 同桶内保持原索引顺序,最大排序误差 ≤ (maxDistance - minDistance) / bins。
 * 加色/最大值混合对顺序不敏感,调用方只需对 alpha 混合层启用,避免无谓开销。
 */

export interface ParticleSortScratch {
  readonly keys: Uint16Array;
  readonly histogram: Uint32Array;
}

export const PARTICLE_SORT_DEFAULT_BINS = 1_024;
const MAX_BINS = 65_535;

/** 预分配排序工作区,逐帧复用避免 GC。 */
export function createParticleSortScratch(capacity: number, bins: number = PARTICLE_SORT_DEFAULT_BINS): ParticleSortScratch {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer.");
  if (!Number.isSafeInteger(bins) || bins < 2 || bins > MAX_BINS) throw new RangeError(`bins must be an integer in 2..${MAX_BINS}.`);
  return { keys: new Uint16Array(capacity), histogram: new Uint32Array(bins + 1) };
}

/**
 * 对前 count 个粒子(xyz 紧排)按到 eye 的距离由远到近排序,把粒子索引写入 order[0..count)。
 * 返回 order 的前 count 项视图长度(即 count)。
 */
export function sortParticlesBackToFront(
  positions: ArrayLike<number>,
  count: number,
  eye: readonly [number, number, number],
  order: Uint32Array,
  scratch: ParticleSortScratch,
): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer.");
  if (count === 0) return 0;
  if (positions.length < count * 3) throw new RangeError("positions is shorter than count * 3.");
  if (order.length < count || scratch.keys.length < count) throw new RangeError("order/scratch capacity is smaller than count.");
  const { keys, histogram } = scratch;
  const bins = histogram.length - 1;
  const [ex, ey, ez] = eye;
  let minDistance = Infinity, maxDistance = -Infinity;
  for (let index = 0; index < count; index++) {
    const dx = positions[index * 3]! - ex, dy = positions[index * 3 + 1]! - ey, dz = positions[index * 3 + 2]! - ez;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // 非有限坐标当作最近处理,保证排序仍是全序且不抛错。
    const safe = Number.isFinite(distance) ? distance : 0;
    // 距离算两遍(先求范围再分桶),换取零额外内存。
    if (safe < minDistance) minDistance = safe;
    if (safe > maxDistance) maxDistance = safe;
  }
  const span = maxDistance - minDistance;
  const scale = span > 0 ? (bins - 1) / span : 0;
  histogram.fill(0);
  for (let index = 0; index < count; index++) {
    const dx = positions[index * 3]! - ex, dy = positions[index * 3 + 1]! - ey, dz = positions[index * 3 + 2]! - ez;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const safe = Number.isFinite(distance) ? distance : 0;
    // 远 → 近:桶号取反,使最远粒子落在桶 0。
    const bucket = (bins - 1) - Math.min(bins - 1, Math.round((safe - minDistance) * scale));
    keys[index] = bucket;
    histogram[bucket + 1]!++;
  }
  for (let bucket = 0; bucket < bins; bucket++) histogram[bucket + 1]! += histogram[bucket]!;
  for (let index = 0; index < count; index++) {
    const bucket = keys[index]!;
    order[histogram[bucket]!++] = index;
  }
  return count;
}
