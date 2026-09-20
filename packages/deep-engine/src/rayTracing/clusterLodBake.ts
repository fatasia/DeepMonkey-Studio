/**
 * Cluster LOD DAG bake 的 CPU 参考实现（波次1 合同层）。
 * 简化采用确定性顶点聚类（网格吸附到 cell 质心）：无 QEM 权重、同输入逐位同输出，
 * 作为 GPU/bake 管线简化结果的仲裁基准（对拍模式同 R2 DCIR）。
 * 产物直接符合 clusterLodDag 合同（validateClusterLodDag 可签核）。
 */

import type { ClusterLodDagDescriptor, ClusterLodNodeDescriptor } from "./clusterLodDag.js";
import { validateClusterLodDag } from "./clusterLodDag.js";
import { RAY_BACKEND_LIMITS } from "./rayBackendTypes.js";

export interface ClusterLodBakeInput {
  readonly geometryId: string;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  /** level0 的 meshlet 页大小（与分页编译一致的 cluster 粒度）。 */
  readonly level0ClusterSize: number;
  /** 生成层数（含 level0）；每层三角上限约上一层的 1/4。 */
  readonly levelCount?: number;
}

export interface ClusterLodBakeResult {
  readonly dag: ClusterLodDagDescriptor;
  /** 每层（含 level0）的简化几何：位置 XYZ 展平 + 重排索引。 */
  readonly levelGeometry: ReadonlyArray<{ readonly vertices: Float32Array; readonly indices: Uint32Array }>;
}

const DEFAULT_LEVEL_COUNT = 3;

export function bakeClusterLodDag(input: ClusterLodBakeInput): ClusterLodBakeResult {
  if (!Number.isSafeInteger(input.level0ClusterSize) || input.level0ClusterSize < 1
    || input.level0ClusterSize > 128) throw new RangeError("level0ClusterSize must be an integer in [1,128].");
  const levelCount = input.levelCount ?? DEFAULT_LEVEL_COUNT;
  if (!Number.isSafeInteger(levelCount) || levelCount < 1 || levelCount > 6) throw new RangeError("levelCount must be an integer in [1,6].");
  const triangles = input.indices.length / 3;
  if (!Number.isSafeInteger(triangles) || triangles < 1 || triangles > RAY_BACKEND_LIMITS.maxBlasTriangles) {
    throw new RangeError("Cluster LOD bake triangle count is out of the contract budget.");
  }

  const levelGeometry: Array<{ vertices: Float32Array; indices: Uint32Array }> = [];
  const nodes: ClusterLodNodeDescriptor[] = [];
  let currentVertices = input.vertices, currentIndices = input.indices;
  let previousClusterIds: string[] = [];

  for (let level = 0; level < levelCount; level++) {
    if (level > 0) {
      const simplified = simplifyByVertexClustering(currentVertices, currentIndices, clusterCellSize(currentVertices, level));
      currentVertices = simplified.vertices; currentIndices = simplified.indices;
    }
    levelGeometry.push({ vertices: currentVertices, indices: currentIndices });
    const clusterSize = input.level0ClusterSize * 4 ** level;
    const error = level === 0 ? 0 : clusterCellSize(currentVertices, level);
    for (let cluster = 0; cluster * clusterSize < currentIndices.length / 3; cluster++) {
      const first = cluster * clusterSize;
      const count = Math.min(clusterSize, currentIndices.length / 3 - first);
      const id = `l${level}-c${cluster}`;
      const bounds = clusterBounds(currentVertices, currentIndices, first, count);
      const children = level === 0 ? [] : previousClusterIds.slice(cluster * 4, cluster * 4 + 4);
      nodes.push({ id, level, error, firstTriangle: first, triangleCount: count,
        children, boundsMin: bounds.min, boundsMax: bounds.max });
    }
    previousClusterIds = nodes.filter(node => node.level === level).map(node => node.id);
  }

  // 叶子三角形覆盖闭合：合同要求每层语义明确，这里以 level0 总量声明。
  const dag: ClusterLodDagDescriptor = { geometryId: input.geometryId,
    leafTriangleTotal: input.indices.length / 3, nodes: Object.freeze(nodes) };
  const validation = validateClusterLodDag(dag);
  if (!validation.valid) throw new Error(`Cluster LOD bake produced an invalid DAG: ${validation.reason}`);
  return { dag, levelGeometry: Object.freeze(levelGeometry) };
}

/** 确定性顶点聚类：cell 键 = floor(pos / cellSize)，新顶点 = cell 内顶点质心（按索引序遍历）。 */
function simplifyByVertexClustering(vertices: Float32Array, indices: Uint32Array, cellSize: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const remap = new Map<string, { index: number; sum: [number, number, number]; count: number }>();
  const clusterOf: number[] = [];
  for (let vertex = 0; vertex < vertices.length / 3; vertex++) {
    const x = vertices[vertex * 3]!, y = vertices[vertex * 3 + 1]!, z = vertices[vertex * 3 + 2]!;
    const key = `${Math.floor(x / cellSize)}|${Math.floor(y / cellSize)}|${Math.floor(z / cellSize)}`;
    let cell = remap.get(key);
    if (cell === undefined) {
      cell = { index: remap.size, sum: [0, 0, 0], count: 0 };
      remap.set(key, cell);
    }
    clusterOf[vertex] = cell.index;
    cell.sum[0]! += x; cell.sum[1]! += y; cell.sum[2]! += z; cell.count += 1;
  }
  const output = new Float32Array(remap.size * 3);
  for (const cell of remap.values()) {
    output[cell.index * 3] = cell.sum[0]! / cell.count;
    output[cell.index * 3 + 1] = cell.sum[1]! / cell.count;
    output[cell.index * 3 + 2] = cell.sum[2]! / cell.count;
  }
  const outIndices: number[] = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const a = clusterOf[indices[triangle * 3]!]!, b = clusterOf[indices[triangle * 3 + 1]!]!,
      c = clusterOf[indices[triangle * 3 + 2]!]!;
    if (a === b || b === c || a === c) continue; // 退化三角形在简化中合法消失。
    outIndices.push(a, b, c);
  }
  return { vertices: output, indices: Uint32Array.from(outIndices) };
}

/** level1 聚类起步取包围盒 1/8（保证相对顶点密度有实质简化），逐层翻倍；误差标量与聚类 cell 同源。 */
function clusterCellSize(vertices: Float32Array, level: number): number {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < vertices.length; i++) { min = Math.min(min, vertices[i]!); max = Math.max(max, vertices[i]!); }
  const extent = Math.max(max - min, 1e-6);
  return (extent / 8) * 2 ** Math.max(0, level - 1);
}

function clusterBounds(vertices: Float32Array, indices: Uint32Array, first: number, count: number,
): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let triangle = first; triangle < first + count; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[triangle * 3 + corner]! * 3;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, vertices[v + axis]!);
        max[axis] = Math.max(max[axis]!, vertices[v + axis]!);
      }
    }
  }
  return { min, max };
}
