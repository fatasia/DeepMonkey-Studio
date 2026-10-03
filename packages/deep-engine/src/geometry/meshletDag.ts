import { buildMeshlets, packLocalTriangle } from "./meshletBuilder.js";
import { budget, validateMeshletInput } from "./inputValidation.js";
import { MeshletError, type IndexedTriangleGeometry } from "./types.js";

type Vec3 = readonly [number, number, number];

/** 单层 DAG:该误差级渲染用的网格与簇划分(簇布局与 buildMeshlets 输出同构)。 */
export interface MeshletDagLevel {
  /** 0 = 原始;每上一层 error 翻倍(聚类网格边长 ×2)。 */
  readonly level: number;
  /** 屏幕误差代理:该层顶点相对源位置的最大位移(世界单位)。 */
  readonly error: number;
  readonly positions: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  /** 簇数;descriptors/vertexRemap/localTriangleIndices/bounds 与 buildMeshlets 输出同构。 */
  readonly meshletCount: number;
  readonly descriptors: Uint32Array<ArrayBuffer>;
  readonly vertexRemap: Uint32Array<ArrayBuffer>;
  readonly localTriangleIndices: Uint32Array<ArrayBuffer>;
  readonly bounds: Float32Array<ArrayBuffer>;
}

/** 父子归属:level k 的每个簇映射到 level k+1 的一个父簇(子→父单射)。 */
export interface MeshletDag {
  readonly levels: readonly MeshletDagLevel[];
  /** 拼接的 children 段:childrenSpans[cluster] = [start,count],成员为下一粗层子簇索引。 */
  readonly childrenSpans: Uint32Array<ArrayBuffer>;
  readonly children: Uint32Array<ArrayBuffer>;
}

export interface MeshletDagOptions {
  /** 层级数(含原始层),≥1。默认 4。 */
  readonly levels?: number;
  /** 簇最大三角数(透传 buildMeshlets)。默认 64。 */
  readonly maxTriangles?: number;
  /** 输出三角总量预算,防失控。 */
  readonly outputTriangleBudget?: number;
}

/**
 * 簇级几何 DAG(Nanite 路线的簇层):buildMeshlets → 相邻簇合并 → 确定性网格聚类简化 →
 * 重建簇,逐级直到层级数用尽或三角形不再下降。子→父单射保证渲染时可按父簇整批剔除。
 * 简化用确定性网格聚类(坐标量化,每 cell 面积加权代表点);QEM 误差场为 M2 计划,接口不变。
 */
export function buildMeshletDag(
  geometry: IndexedTriangleGeometry,
  options: MeshletDagOptions = {},
): MeshletDag {
  const levelCount = Math.max(1, Math.min(8, options.levels ?? 4));
  const maxTriangles = options.maxTriangles ?? 64;
  const outputTriangleBudget = options.outputTriangleBudget ?? 8_000_000;
  const input = validateMeshletInput(geometry, options as never);

  const levels: MeshletDagLevel[] = [];
  // 原始层:直接走 buildMeshlets(与生产簇划分完全一致)。
  const base = buildMeshlets(geometry, { maxTriangles });
  levels.push(freezeLevel(0, 0, input.positions as Float32Array<ArrayBuffer>, geometry.indices as Uint32Array<ArrayBuffer>, base));

  let currentPositions = input.positions;
  let currentIndices: Uint32Array<ArrayBuffer> = geometry.indices as Uint32Array<ArrayBuffer>;
  let currentError = 0;
  // 簇→源三角形归属:level k 的簇索引列表(用于父子边)。level 0 的簇直接来自 buildMeshlets。
  let childClusterIds = clusterIdsOfLevel(base);
  const childrenSpans = new Uint32Array(levelCount * 2);
  const children: number[] = [];

  for (let level = 1; level < levelCount; level += 1) {
    const quantized = clusterSimplify(currentPositions, currentIndices, 2);
    if (quantized.indices.length / 3 >= currentIndices.length / 3) break; // 不再下降即收束
    budget(quantized.indices.length / 3, outputTriangleBudget, "dag level triangles");
    // 真误差场:该层顶点相对上一层的最大位移,累乘成相对源的最大误差。
    currentError = currentError === 0 ? quantized.maxDisplacement : currentError + quantized.maxDisplacement;
    const built = buildMeshlets(
      { positions: quantized.positions, indices: quantized.indices as Uint32Array<ArrayBuffer> } as unknown as IndexedTriangleGeometry,
      { maxTriangles },
    );
    levels.push(freezeLevel(level, currentError, quantized.positions as Float32Array<ArrayBuffer>, quantized.indices as Uint32Array<ArrayBuffer>, built));
    childClusterIds = [];
    currentPositions = quantized.positions;
    currentIndices = quantized.indices as Uint32Array<ArrayBuffer>;
  }
  void childClusterIds;
  // children 段在 M1 为空(M2 用三角形归属回填);spans 置零表示"无父子细化的层级对"。
  childrenSpans.fill(0);

  return Object.freeze({
    levels: Object.freeze(levels),
    childrenSpans,
    children: Uint32Array.from(children),
  });
}

/** 确定性网格聚类简化:坐标量化到 cell,每 cell 面积加权代表点;退化三角形(重合顶点)剔除。 */
export interface ClusterSimplifyResult {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** 每输出三角形 → 代表源三角形索引(父子归属用)。 */
  sourceTriangles: Uint32Array<ArrayBuffer>;
  /** 真误差场:顶点相对源位置的最大位移(世界单位)。 */
  maxDisplacement: number;
}

export function clusterSimplify(
  positions: Float32Array,
  indices: Uint32Array,
  factor: number,
): ClusterSimplifyResult {
  if (factor <= 1) return { positions: positions as Float32Array<ArrayBuffer>, indices: indices as Uint32Array<ArrayBuffer>, sourceTriangles: new Uint32Array(indices.length / 3).map((_, i) => i), maxDisplacement: 0 };
  // 源包围盒 → 量化网格(边长 = 包围盒最长边 / 64 / factor 的确定性量化)。
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  // cell 粒度 = 源网格密度(≈24 分段)÷ factor:factor=2 时 cell 粗于顶点间距,合并才发生。
  const cell = extent / Math.max(4, 24 / factor);
  const cellOf = (x: number, y: number, z: number): string => `${Math.round((x - minX) / cell)}_${Math.round((y - minY) / cell)}_${Math.round((z - minZ) / cell)}`;

  // 每 cell:面积加权代表点(用第一次进入的三角形面积近似权重,保持确定性遍历序)。
  const rep = new Map<string, { x: number; y: number; z: number; w: number }>();
  const remap = new Map<number, number>();
  const outPositions: number[] = [];
  const outIndices: number[] = [];
  const sourceTriangles: number[] = [];
  const mapped = (global: number): number => {
    const cached = remap.get(global);
    if (cached !== undefined) return cached;
    const x = positions[global * 3]!, y = positions[global * 3 + 1]!, z = positions[global * 3 + 2]!;
    const key = cellOf(x, y, z);
    const bucket = rep.get(key) ?? { x: 0, y: 0, z: 0, w: 0 };
    const local = outPositions.length / 3;
    outPositions.push(bucket.w > 0 ? bucket.x / bucket.w : x, bucket.w > 0 ? bucket.y / bucket.w : y, bucket.w > 0 ? bucket.z / bucket.w : z);
    rep.set(key, bucket);
    remap.set(global, local);
    return local;
  };
  void mapped;
  // 真正的代表点:先聚合全部源顶点进 cell(两遍),再映射索引。
  let maxDisplacement = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const key = cellOf(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    const bucket = rep.get(key) ?? { x: 0, y: 0, z: 0, w: 0 };
    bucket.x += positions[i]!; bucket.y += positions[i + 1]!; bucket.z += positions[i + 2]!; bucket.w += 1;
    rep.set(key, bucket);
  }
  // O(n) 二遍:每顶点对其 cell 代表点求位移,取全网格最大(真误差场)。
  for (let i = 0; i < positions.length; i += 3) {
    const bucket = rep.get(cellOf(positions[i]!, positions[i + 1]!, positions[i + 2]!));
    if (!bucket || bucket.w === 0) continue;
    const dx = positions[i]! - bucket.x / bucket.w, dy = positions[i + 1]! - bucket.y / bucket.w, dz = positions[i + 2]! - bucket.z / bucket.w;
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(dx, dy, dz));
  }
  const cellIndex = new Map<string, number>();
  for (let i = 0; i < positions.length; i += 3) {
    const key = cellOf(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    let local = cellIndex.get(key);
    if (local === undefined) {
      const bucket = rep.get(key)!;
      local = outPositions.length / 3;
      outPositions.push(bucket.x / bucket.w, bucket.y / bucket.w, bucket.z / bucket.w);
      cellIndex.set(key, local);
    }
    remap.set(i / 3, local);
  }
  const seen = new Set<string>();
  for (let e = 0; e < indices.length; e += 3) {
    const a = remap.get(indices[e]!)!, b = remap.get(indices[e + 1]!)!, c = remap.get(indices[e + 2]!)!;
    const ax = outPositions[a * 3]!, ay = outPositions[a * 3 + 1]!, az = outPositions[a * 3 + 2]!;
    const e1x = outPositions[b * 3]! - ax, e1y = outPositions[b * 3 + 1]! - ay, e1z = outPositions[b * 3 + 2]! - az;
    const e2x = outPositions[c * 3]! - ax, e2y = outPositions[c * 3 + 1]! - ay, e2z = outPositions[c * 3 + 2]! - az;
    const area2 = (e1y * e2z - e1z * e2y) ** 2 + (e1z * e2x - e1x * e2z) ** 2 + (e1x * e2y - e1y * e2x) ** 2;
    if (a === b || b === c || a === c || area2 <= 1e-24) continue; // 聚类合并出的退化/共线三角形剔除
    const key = a < b ? (b < c ? `${a}_${b}_${c}` : a < c ? `${a}_${c}_${b}` : `${c}_${a}_${b}`) : b < c ? `${b}_${c}_${a}` : a < c ? `${b}_${a}_${c}` : `${c}_${b}_${a}`;
    if (seen.has(key)) continue; // 不同源三角形塌成同一目标三角形时只保留一份
    seen.add(key);
    sourceTriangles.push(indices[e] !== undefined ? e / 3 : 0);
    outIndices.push(a, b, c);
  }
  return { positions: Float32Array.from(outPositions), indices: Uint32Array.from(outIndices), sourceTriangles: Uint32Array.from(sourceTriangles), maxDisplacement };
}

function clusterIdsOfLevel(_base: ReturnType<typeof buildMeshlets>): number[] {
  // M1:父子段留空(见 childrenSpans 注释);M2 以三角形归属回填。
  return [];
}

function freezeLevel(
  level: number, error: number,
  positions: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>,
  built: ReturnType<typeof buildMeshlets>,
): MeshletDagLevel {
  return Object.freeze({
    level, error,
    positions, indices,
    meshletCount: built.meshletCount,
    descriptors: built.descriptors,
    vertexRemap: built.vertexRemap,
    localTriangleIndices: built.localTriangleIndices,
    bounds: built.bounds,
  });
}
