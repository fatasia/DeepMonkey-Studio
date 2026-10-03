/**
 * F6/T18 软体 GPU 并行核·第一刀:体积约束四面体着色(CPU 参考)。
 *
 * 语义:体积约束投影动 4 个粒子——同子步内,共享任一粒子的两个四面体不得同色批
 * (每粒子每子步只被一个体积约束投影)。确定性贪心(按构建序取最小可用色),
 * 输出形态与 ClothColoring 同构(colorRanges/order 供并行 dispatch 编排直用)。
 * 邻接经粒子→tet 倒排一次构建(构建期一次,零每帧开销);全部 f64/整数,无随机源。
 */
export interface SoftBodyVolumeColoring {
  /** 每个四面体的色号(原 tet 索引序)。 */
  readonly colors: Uint16Array;
  readonly colorCount: number;
  /** 色桶排序后的 tet 原索引(桶序 = 色号升序,桶内 = 原索引升序)。 */
  readonly order: Uint32Array;
  /** 每色在桶排序 tet 数组中的 [start, end) 区间(end 独占)。 */
  readonly colorRanges: ReadonlyArray<readonly [number, number]>;
  /** 最大 tet 邻接度(诊断;着色上界依据)。 */
  readonly maxTetDegree: number;
}

export function colorSoftBodyVolumes(
  tets: ReadonlyArray<readonly [number, number, number, number]>,
  particleCount: number,
): SoftBodyVolumeColoring {
  if (!Number.isSafeInteger(particleCount) || particleCount < 1) {
    throw new Error(`soft-body volume coloring: particleCount must be an integer >= 1, got ${particleCount}.`);
  }
  for (let t = 0; t < tets.length; t += 1) {
    for (const index of tets[t]!) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= particleCount) {
        throw new Error(`soft-body volume coloring: tet ${t} references particle ${index} out of range [0,${particleCount}).`);
      }
    }
  }
  // 粒子→tet 倒排;邻接对 = 倒排桶内所有 tet 对(共享该粒子即冲突)。
  const particleTets: number[][] = Array.from({ length: particleCount }, () => []);
  for (let t = 0; t < tets.length; t += 1) {
    for (const index of tets[t]!) particleTets[index]!.push(t);
  }
  const adjacency: Set<number>[] = Array.from({ length: tets.length }, () => new Set<number>());
  let maxTetDegree = 0;
  for (let p = 0; p < particleCount; p += 1) {
    const bucket = particleTets[p]!;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        adjacency[bucket[i]!]!.add(bucket[j]!);
        adjacency[bucket[j]!]!.add(bucket[i]!);
      }
    }
  }
  for (let t = 0; t < tets.length; t += 1) {
    if (adjacency[t]!.size > maxTetDegree) maxTetDegree = adjacency[t]!.size;
  }
  // 确定性贪心:原序遍历,取不与已着色邻接冲突的最小色号。
  const colors = new Uint16Array(tets.length);
  for (let t = 0; t < tets.length; t += 1) {
    const used = new Set<number>();
    for (const neighbor of adjacency[t]!) if (neighbor < t) used.add(colors[neighbor]!);
    let color = 0;
    while (used.has(color)) color += 1;
    colors[t] = color;
  }
  let colorCount = 0;
  for (let t = 0; t < tets.length; t += 1) if (colors[t]! + 1 > colorCount) colorCount = colors[t]! + 1;
  // 桶排序:计数 → 起点 → scatter(原索引升序 scatter = 桶内稳定)。
  const bucketStart = new Int32Array(colorCount + 1);
  for (let t = 0; t < tets.length; t += 1) bucketStart[colors[t]!]! += 1;
  let prefix = 0;
  for (let c = 0; c < colorCount; c += 1) {
    const size = bucketStart[c]!;
    bucketStart[c] = prefix;
    prefix += size;
  }
  bucketStart[colorCount] = prefix;
  const order = new Uint32Array(tets.length);
  for (let t = 0; t < tets.length; t += 1) {
    order[bucketStart[colors[t]!]!] = t;
    bucketStart[colors[t]!]! += 1;
  }
  const colorRanges: Array<readonly [number, number]> = [];
  let previous = 0;
  for (let c = 0; c < colorCount; c += 1) {
    colorRanges.push([previous, bucketStart[c]!]);
    previous = bucketStart[c]!;
  }
  return { colors, colorCount, order, colorRanges, maxTetDegree };
}
