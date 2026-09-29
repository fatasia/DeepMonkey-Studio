/**
 * T18 A3 并行切片:布料距离约束的确定性图着色(greedy edge coloring)。
 *
 * 目的:把串行 Gauss-Seidel 投影并行化 —— 同色约束两两不共享端点,因此同一
 * 色内所有约束可以安全并行读写粒子位置;色间按固定色号顺序串行(dispatch
 * 边界定序,clusterLightCulling 三有序 pass 同款纪律)。着色结果决定执行序,
 * 所以着色本身必须跨端逐位确定:
 * - 按约束索引升序贪心;每个约束取其两端点已占用色掩码并集的最小未用色;
 * - 占用掩码是纯整型位运算(u32,每粒子一个),无浮点、无哈希序依赖;
 * - 布料网格最大粒子度 = 8(右/左/上/下 + 四对角),Vizing 上界 Δ+1 = 9 色,
 *   u32 掩码(32 色)有充足余量;超界显式 fail-closed。
 *
 * 产物 `colorRanges`(按色连续的约束索引区间)同时决定 GPU 侧约束缓冲的
 * 桶排序布局:同一色的约束连续存放,每个色一个 dispatch,色序即 dispatch 序。
 */

export interface ClothColoring {
  /** 每条约束的色号(原约束索引序)。 */
  readonly colors: Uint16Array;
  /** 色数。 */
  readonly colorCount: number;
  /** 色桶排序后的约束原索引(桶序 = 色号升序,桶内 = 原索引升序)。 */
  readonly order: Uint32Array;
  /** 每色在桶排序约束数组中的 [start, end) 区间(end 独占)。 */
  readonly colorRanges: ReadonlyArray<readonly [number, number]>;
  /** 最大粒子度(诊断;着色上界依据)。 */
  readonly maxDegree: number;
}

/** 确定性贪心边着色:同色约束不共享端点;结果由约束索引序唯一决定。 */
export function colorClothConstraints(a: ReadonlyArray<number>, b: ReadonlyArray<number>, particleCount: number): ClothColoring {
  if (a.length !== b.length) throw new Error("cloth coloring: constraint endpoint arrays must have equal length.");
  const degree = new Uint32Array(particleCount);
  for (let k = 0; k < a.length; k += 1) {
    degree[a[k]!]! += 1;
    degree[b[k]!]! += 1;
  }
  let maxDegree = 0;
  for (let i = 0; i < particleCount; i += 1) if (degree[i]! > maxDegree) maxDegree = degree[i]!;
  const colors = new Uint16Array(a.length);
  const used: Uint32Array[] = new Array(particleCount);
  for (let i = 0; i < particleCount; i += 1) used[i] = new Uint32Array(1);
  let colorCount = 0;
  for (let k = 0; k < a.length; k += 1) {
    const endpointA = a[k]!;
    const endpointB = b[k]!;
    if (endpointA === endpointB) throw new Error(`cloth coloring: constraint ${k} is degenerate (a === b).`);
    const forbidden = used[endpointA]![0]! | used[endpointB]![0]!;
    let color = 0;
    while (color < 32 && (forbidden & (1 << color)) !== 0) color += 1;
    if (color >= 32) throw new Error(`cloth coloring: constraint ${k} needs a color >= 32 (degree overflow; fail-closed).`);
    colors[k] = color;
    if (color + 1 > colorCount) colorCount = color + 1;
    used[endpointA]![0]! |= 1 << color;
    used[endpointB]![0]! |= 1 << color;
  }
  // 计数排序式桶分:colorCount 小(≤9),两次线性扫描,桶内保持原索引升序。
  const bucketSize = new Uint32Array(colorCount);
  for (let k = 0; k < a.length; k += 1) bucketSize[colors[k]!]! += 1;
  const bucketStart = new Uint32Array(colorCount);
  let cursor = 0;
  for (let c = 0; c < colorCount; c += 1) {
    bucketStart[c] = cursor;
    cursor += bucketSize[c]!;
  }
  const order = new Uint32Array(a.length);
  const fill = Uint32Array.from(bucketStart);
  for (let k = 0; k < a.length; k += 1) order[fill[colors[k]!]!++] = k;
  const colorRanges: Array<[number, number]> = [];
  for (let c = 0; c < colorCount; c += 1) colorRanges.push([bucketStart[c]!, bucketStart[c]! + bucketSize[c]!]);
  return { colors, colorCount, order, colorRanges, maxDegree };
}

/** 断言同色约束两两不共享端点(着色正确性 O(K·deg) 抽查/全查)。 */
export function assertColoringValid(coloring: ClothColoring, a: ReadonlyArray<number>, b: ReadonlyArray<number>): void {
  const seen = new Set<number>();
  for (let c = 0; c < coloring.colorCount; c += 1) {
    seen.clear();
    for (let i = coloring.colorRanges[c]![0]; i < coloring.colorRanges[c]![1]; i += 1) {
      const k = coloring.order[i]!;
      for (const endpoint of [a[k]!, b[k]!]) {
        if (seen.has(endpoint)) throw new Error(`cloth coloring: color ${c} shares particle ${endpoint} across constraints.`);
        seen.add(endpoint);
      }
    }
  }
}
