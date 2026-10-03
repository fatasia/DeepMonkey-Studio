/**
 * F6 切片:四面体软体表面自碰撞 CPU 参考。
 *
 * 语义与边界(如实声明):自碰撞只作用于**表面粒子**(体积约束保内部结构,
 * 内部粒子不参与);共享任意四面体的 1 跳拓扑邻接对被 CSR 邻接表显式排除
 * (它们由边/体积约束负责);投影式单遍近似,与布料自碰撞同族边界
 * (不承诺完全无穿透、与 contacts 顺序固定 contacts→self)。
 * 表面提取与邻接在构建期一次完成(零每帧开销);分离复用 createParticleSeparation。
 */
import { createParticleSeparation, type ParticleSeparationSet } from "./clothSelfCollision.js";

export interface SoftBodySurfaceTopology {
  /** 表面粒子索引(升序去重)。 */
  readonly surfaceIndices: Int32Array;
  /** CSR 邻接:offsets 长 count+1(含非表面粒子占位),data 为排序邻居。 */
  readonly adjacencyOffsets: Int32Array;
  readonly adjacencyData: Int32Array;
}

/** 表面 = 恰被一个四面体拥有的三角面;1 跳邻接 = 共享任一四面体的粒子对。
 * 输入索引合法性由调用方(SoftBodySolver 构造)保证,这里不做二次校验。 */
export function extractSoftBodySurfaceTopology(tets: readonly (readonly number[])[], count: number): SoftBodySurfaceTopology {
  const faceCount = new Map<number, number>();
  const key3 = (a: number, b: number, c: number): number => {
    let x = a; let y = b; let z = c;
    if (y < x) { const t = x!; x = y; y = t; }
    if (z < x) { const t = x!; x = z; z = t; }
    if (z < y) { const t = y!; y = z; z = t; }
    return (x * count + y) * count + z;
  };
  for (const tet of tets) {
    const [i0, i1, i2, i3] = tet as readonly [number, number, number, number];
    for (const [a, b, c] of [[i0, i1, i2], [i0, i1, i3], [i0, i2, i3], [i1, i2, i3]] as const) {
      const key = key3(a, b, c);
      faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
    }
  }
  const surfaceSet = new Set<number>();
  for (const [key, occurrences] of faceCount) {
    if (occurrences !== 1) continue;
    const z = key % count; const rest = (key - z) / count;
    const y = rest % count; const x = (rest - y) / count;
    surfaceSet.add(x); surfaceSet.add(y); surfaceSet.add(z);
  }
  const surfaceIndices = Int32Array.from([...surfaceSet].sort((a, b) => a - b));
  const isSurface = new Uint8Array(count);
  for (const index of surfaceIndices) isSurface[index] = 1;
  // 1 跳邻接:同 tet 内全部粒子对(不限表面;查询时非表面对不会被用到)。
  const neighborSets: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (const tet of tets) {
    const [i0, i1, i2, i3] = tet as readonly [number, number, number, number];
    for (const a of [i0, i1, i2, i3]) {
      for (const b of [i0, i1, i2, i3]) {
        if (a !== b) neighborSets[a]!.add(b);
      }
    }
  }
  const adjacencyOffsets = new Int32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    adjacencyOffsets[i] = total;
    if (!isSurface[i]) continue;
    total += neighborSets[i]!.size;
  }
  adjacencyOffsets[count] = total;
  const adjacencyData = new Int32Array(total);
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    if (!isSurface[i]) continue;
    for (const neighbor of [...neighborSets[i]!].sort((a, b) => a - b)) adjacencyData[cursor] = neighbor, cursor += 1;
  }
  return { surfaceIndices, adjacencyOffsets, adjacencyData };
}

export interface SoftBodySelfCollisionConfig {
  readonly topology: SoftBodySurfaceTopology;
  readonly count: number;
  readonly radius: number;
  /** 最短四面体边长(构建期已算);合同 2r ≤ 它,保证被排除的 1 跳对距离 ≥ 2r 不自相矛盾。 */
  readonly minEdgeLength: number;
}

export interface SoftBodySelfCollisionResolver {
  resolve(px: Float64Array, py: Float64Array, pz: Float64Array, inverseMass: Float64Array): void;
}

/** 软体表面自碰撞 resolver:skipPair 线性扫 CSR(1 跳邻居典型 12-20 个)。 */
export function createSoftBodySelfCollision(
  config: SoftBodySelfCollisionConfig,
): SoftBodySelfCollisionResolver {
  const radius = config.radius;
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`SoftBodySelfCollision: radius must be positive finite, got ${config.radius}.`);
  }
  if (!(2 * radius <= config.minEdgeLength)) {
    throw new Error(`SoftBodySelfCollision: 2r (${2 * radius}) must be <= min tet edge (${config.minEdgeLength}).`);
  }
  const { surfaceIndices, adjacencyOffsets, adjacencyData } = config.topology;
  const offsets = adjacencyOffsets;
  const isSurface = new Uint8Array(config.count);
  for (const index of surfaceIndices) isSurface[index] = 1;
  const isAdjacent = (i: number, j: number): boolean => {
    for (let k = offsets[i]!; k < offsets[i + 1]!; k += 1) {
      if (adjacencyData[k] === j) return true;
    }
    return false;
  };
  // 自碰撞只作用于表面粒子对:含任一内部粒子的对一律跳过(内部由体积约束负责);
  // 表面 1 跳邻接对跳过(由边约束负责)。
  const skipPair = (i: number, j: number): boolean =>
    !(isSurface[i] === 1 && isSurface[j] === 1 && !isAdjacent(i, j));
  const buffers: { -readonly [K in keyof ParticleSeparationSet]: ParticleSeparationSet[K] } = {
    px: new Float64Array(0), py: new Float64Array(0), pz: new Float64Array(0),
    inverseMass: new Float64Array(0), count: config.count,
    skipPair,
  };
  const separation = createParticleSeparation({ sets: [buffers], diameter: 2 * radius, crossOnly: false });
  return { resolve(px, py, pz, inverseMass): void {
    buffers.px = px;
    buffers.py = py;
    buffers.pz = pz;
    buffers.inverseMass = inverseMass;
    separation.resolve();
  } };
}
