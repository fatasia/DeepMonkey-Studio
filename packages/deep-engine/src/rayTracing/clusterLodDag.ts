/**
 * Cluster LOD DAG 数据合同 v0（波次1）：bake 期产出的层级结构，GPU 选层（波次3）只消费。
 * 语义：叶子层 = 编译期 meshlet cluster（现状分页产物）；上层 = 下层簇的简化合并。
 * 误差标量单调不变量是合同的硬门槛——GPU 按"屏幕误差阈值 vs 节点误差"选层依赖它。
 */

import { RAY_BACKEND_LIMITS } from "./rayBackendTypes.js";

export interface ClusterLodNodeDescriptor {
  readonly id: string;
  /** 层级 0 = 编译期 meshlet cluster；越大越粗糙。 */
  readonly level: number;
  /** 屏幕空间误差标量（对数空间或线性空间由 bake 统一约定，合同只要求单调）。 */
  readonly error: number;
  /** 简化后三角形引用区间（bake 输出的扁平三角形缓冲）。 */
  readonly firstTriangle: number;
  readonly triangleCount: number;
  /** 直接子节点（level-1）；叶子为空。 */
  readonly children: readonly string[];
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
}

export interface ClusterLodDagDescriptor {
  readonly geometryId: string;
  /** 三角形总数必须与 meshlet 编译一致；跨层共享引用不重复计数。 */
  readonly leafTriangleTotal: number;
  readonly nodes: readonly ClusterLodNodeDescriptor[];
}

export type ClusterLodDagValidation = { readonly valid: true } | { readonly valid: false; readonly reason: string };

export function validateClusterLodDag(dag: ClusterLodDagDescriptor): ClusterLodDagValidation {
  if (!dag.geometryId) return { valid: false, reason: "DAG geometry id is required." };
  if (dag.nodes.length === 0) return { valid: false, reason: "DAG must contain at least one node." };
  if (dag.nodes.length > RAY_BACKEND_LIMITS.maxBatchRays) return { valid: false, reason: "DAG node budget exceeded." };
  const byId = new Map<string, ClusterLodNodeDescriptor>();
  for (const node of dag.nodes) {
    if (byId.has(node.id)) return { valid: false, reason: `Duplicate DAG node id: ${node.id}.` };
    byId.set(node.id, node);
  }
  let leafTriangles = 0;
  let minLevel = Infinity;
  for (const node of dag.nodes) {
    if (node.level < 0 || !Number.isFinite(node.level)) return { valid: false, reason: `Node ${node.id} has an invalid level.` };
    minLevel = Math.min(minLevel, node.level);
    if (node.triangleCount > 0 && (node.firstTriangle < 0 || !Number.isSafeInteger(node.firstTriangle))) {
      return { valid: false, reason: `Node ${node.id} triangle range is invalid.` };
    }
    if (node.level === 0 && node.triangleCount > 0) leafTriangles += node.triangleCount;
  }
  for (const node of dag.nodes) {
    if (node.children.length > 0 && node.level <= minLevel) {
      return { valid: false, reason: `Node ${node.id} has children at the leaf level.` };
    }
    for (const child of node.children) {
      const childNode = byId.get(child);
      if (childNode === undefined) return { valid: false, reason: `Node ${node.id} references unknown child ${child}.` };
      if (childNode.level >= node.level) return { valid: false, reason: `Node ${node.id} child ${child} does not refine a coarser level.` };
    }
  }
  // 根（最粗层）应唯一且覆盖全部叶子三角形；多根允许（空间不相交的簇群），但覆盖必须闭合。
  let covered = 0;
  const reachable = new Set<string>();
  const visit = (node: ClusterLodNodeDescriptor): void => {
    if (reachable.has(node.id)) return;
    reachable.add(node.id);
    if (node.children.length === 0) { covered += node.triangleCount; return; }
    for (const child of node.children) {
      const childNode = byId.get(child);
      if (childNode !== undefined) visit(childNode);
    }
  };
  for (const node of dag.nodes) {
    const isChild = dag.nodes.some(other => other.children.includes(node.id));
    if (!isChild) visit(node);
  }
  if (covered !== dag.leafTriangleTotal) {
    return { valid: false, reason: `DAG leaves cover ${covered} triangles but the geometry declares ${dag.leafTriangleTotal}.` };
  }
  return { valid: true };
}
