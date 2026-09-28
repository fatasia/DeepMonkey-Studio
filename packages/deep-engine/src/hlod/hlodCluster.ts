/**
 * T26 HLOD 空间聚合树(BH 类定界八叉树 + 压缩下探 + 终端聚合,纯 CPU,确定性)。
 * 胞元几何原语见 hlodCellMath.ts;内容身份原语见 hlodIdentity.ts。
 *
 * == 聚合算法 ==
 * 根胞元由成员集逐位确定(hlodCellMath.rootCellOf);小范围移动不改根胞元
 * (越界/跨 2 的幂边界才重定根,见下)。胞元八分的边界几何与成员集合无关;
 * **压缩下探**:成员全落单一八分时直接收缩到该八分(不产生节点,side 逐次减半),
 * 直到胞元边界真正切开点云——保证簇有空间意义(单侧场景不退化为 id 树)。
 * 收缩到底(共点,side ≤ MIN)仍单八分 → 按 id 序对半 tie-split(确定性,深度 log2 n)。
 * 成员数 ≤ maxChildren → 终端聚合节点(子 = 成员实例叶);= 1 → 直接叶。
 *
 * == 确定性合同(algorithmVersion = "t26-hlod-cluster-v1") ==
 * 同输入 + 同选项 → 逐位同树:成员规范序 = (x,y,z,id) 字典序,与输入顺序无关;
 * 八分序固定 0..7;min/max 折叠与 max 半径精确可交换;无随机、无时钟。
 * 跨引擎 ULP 差异不在合同内(同 T13 诚实条款)。
 *
 * == 内容身份与增量 ==
 * 节点 id = FNV 双种子 64 位内容哈希(叶 = 实例指纹+胞元;内节点 = 子 id 序列+胞元)。
 * 子树内容不变 ⇒ id 不变 ⇒ 跨版本复用同一对象(哈希碰撞 fail-closed);
 * 增量失效(hlodIncremental.ts)与全量构建共用 buildHlodTreeCore 同一代码路径
 * → 增量结果 ≡ 全量重建。胞元边界与压缩下探都是成员集的纯函数 ⇒ 移动/增删
 * 实例只改其实例所在的新旧胞元路径及祖先,其余子树逐引用复用;
 * 重定根后含变更实例的子树必然重建,网格对齐的深子树经压缩下探收敛 → 部分复用。
 */

import {
  HLOD_ALGORITHM_VERSION,
  HLOD_CLUSTER_DEFAULTS,
  HlodError,
  type HlodCell,
  type HlodClusterConfiguration,
  type HlodClusterNode,
  type HlodClusterOptions,
  type HlodClusterStats,
  type HlodClusterTree,
  type HlodInstanceInput,
  type HlodTreeDelta,
} from "./hlodTypes.js";
import { bucketByOctant, enclosingSphere, MIN_ROOT_CELL_SIDE, rootCellOf, shrunkCell, type Cell } from "./hlodCellMath.js";
import { cellPayload, compareText, contentHash64, sameIds } from "./hlodIdentity.js";

type Instance = HlodInstanceInput;

export function resolveHlodClusterOptions(options: HlodClusterOptions = {}): HlodClusterConfiguration {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HlodError("invalid-options", "HLOD cluster options must be an object.");
  }
  const maxChildren = options.maxChildren ?? HLOD_CLUSTER_DEFAULTS.maxChildren;
  const maxDepth = options.maxDepth ?? HLOD_CLUSTER_DEFAULTS.maxDepth;
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 2 || maxChildren > 64) {
    throw new HlodError("invalid-options", "HLOD maxChildren must be an integer in [2, 64].");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1024) {
    throw new HlodError("invalid-options", "HLOD maxDepth must be an integer in [1, 1024].");
  }
  return Object.freeze({ maxChildren, maxDepth });
}

/** 校验并返回规范序((x,y,z,id) 字典序)的实例表;唯一性与数值合法性 fail-closed。 */
export function validateHlodInstances(instances: readonly Instance[]): readonly Instance[] {
  if (!Array.isArray(instances)) throw new HlodError("invalid-instance", "HLOD instances must be an array.");
  const byId = new Map<string, Instance>();
  for (const instance of instances) {
    if (!instance || typeof instance !== "object" || typeof instance.id !== "string" || instance.id.length === 0) {
      throw new HlodError("invalid-instance", "HLOD instance id must be a non-empty string.");
    }
    if (byId.has(instance.id)) throw new HlodError("duplicate-instance-id", `Duplicate HLOD instance id: ${instance.id}.`);
    if (!Array.isArray(instance.position) || instance.position.length !== 3
      || !instance.position.every(Number.isFinite)) {
      throw new HlodError("invalid-instance", `HLOD instance ${instance.id} position must be 3 finite numbers.`);
    }
    if (!Number.isFinite(instance.radius) || instance.radius < 0) {
      throw new HlodError("invalid-instance", `HLOD instance ${instance.id} radius must be finite and nonnegative.`);
    }
    byId.set(instance.id, instance);
  }
  return Object.freeze([...byId.values()].sort(compareInstance));
}

/** 成员规范序:(x,y,z,id) 字典序——与输入顺序无关的确定性基准。 */
export function compareInstance(left: Instance, right: Instance): number {
  for (let axis = 0; axis < 3; axis++) {
    if (left.position[axis] !== right.position[axis]) return left.position[axis]! - right.position[axis]!;
  }
  return compareText(left.id, right.id);
}

/**
 * 核心构建器(全量与增量共用同一条代码路径——增量结果 ≡ 全量重建的结构性保证)。
 * `cache` 提供前树节点(内容 id → 节点):内容 id 命中即复用前树对象,
 * 并以重算几何逐字段比对防哈希碰撞(不一致 fail-closed)。
 */
export function buildHlodTreeCore(members: readonly Instance[], options: HlodClusterConfiguration,
  cache?: ReadonlyMap<string, HlodClusterNode>): { tree: HlodClusterTree; delta: HlodTreeDelta } {
  const context: BuildContext = {
    options, cache: cache ?? new Map<string, HlodClusterNode>(),
    nodes: new Map<string, HlodClusterNode>(),
    leafByInstance: new Map<string, string>(),
    maxDepthSeen: 0, maxFanout: 0, reused: 0, rebuilt: 0,
  };
  const rootCell = rootCellOf(members);
  const rootId = members.length === 0 ? null
    : buildCell(context, members, { center: rootCell.center, side: rootCell.side }, 0).id;
  const parentByNode = buildParentMap(context.nodes, rootId);
  const stats: HlodClusterStats = Object.freeze({
    nodeCount: context.nodes.size,
    leafCount: members.length,
    internalCount: context.nodes.size - members.length,
    depth: context.maxDepthSeen,
    maxFanout: context.maxFanout,
  });
  return {
    tree: Object.freeze({
      algorithmVersion: HLOD_ALGORITHM_VERSION,
      options,
      rootCell: Object.freeze({ ...rootCell }),
      rootId,
      nodes: context.nodes,
      leafByInstance: context.leafByInstance,
      parentByNode,
      stats,
    }),
    delta: Object.freeze({ reusedNodes: context.reused, rebuiltNodes: context.rebuilt }),
  };
}

/** 全量构建入口。空实例集合法(rootId = null)。 */
export function buildHlodTree(instances: readonly Instance[],
  options: HlodClusterOptions = {}): HlodClusterTree {
  return buildHlodTreeCore(validateHlodInstances(instances), resolveHlodClusterOptions(options)).tree;
}

interface BuildContext {
  readonly options: HlodClusterConfiguration;
  readonly cache: ReadonlyMap<string, HlodClusterNode>;
  readonly nodes: Map<string, HlodClusterNode>;
  readonly leafByInstance: Map<string, string>;
  maxDepthSeen: number;
  maxFanout: number;
  reused: number;
  rebuilt: number;
}

/** 递归构建一个胞元;depth = 到根的边数。 */
function buildCell(context: BuildContext, members: readonly Instance[], cell: Cell, depth: number): HlodClusterNode {
  if (depth > context.options.maxDepth) {
    throw new HlodError("depth-exceeded", `HLOD aggregation exceeded maxDepth ${context.options.maxDepth}.`);
  }
  context.maxDepthSeen = Math.max(context.maxDepthSeen, depth);
  let workCell: Cell = cell;
  let buckets = bucketByOctant(members, workCell);
  while (buckets.occupied === 1 && members.length > 1 && workCell.side > MIN_ROOT_CELL_SIDE) {
    workCell = shrunkCell(workCell, buckets.singleOctant!);
    buckets = bucketByOctant(members, workCell);
  }
  const effective: Cell = { center: workCell.center, side: workCell.side };
  if (members.length === 1) return buildLeaf(context, members[0]!, effective, depth);
  if (buckets.occupied === 1) {
    // 收缩到底仍不可分(共点/共线退路):按 id 序对半 tie-split,深度 log2 n,确定性。
    const ordered = [...members].sort((left, right) => compareText(left.id, right.id));
    const mid = ordered.length >> 1;
    const children = [ordered.slice(0, mid), ordered.slice(mid)]
      .map(part => buildCell(context, part, effective, depth + 1));
    return assemble(context, children, members, effective);
  }
  if (members.length <= context.options.maxChildren) {
    return assemble(context, members.map(instance => buildLeaf(context, instance, effective, depth + 1)),
      members, effective);
  }
  const children: HlodClusterNode[] = [];
  for (let octant = 0; octant < 8; octant++) {
    const bucket = buckets.lists[octant]!;
    if (bucket.length === 0) continue;
    children.push(buildCell(context, bucket, shrunkCell(effective, octant), depth + 1));
  }
  return assemble(context, children, members, effective);
}

function buildLeaf(context: BuildContext, instance: Instance, cell: Cell, depth: number): HlodClusterNode {
  context.maxDepthSeen = Math.max(context.maxDepthSeen, depth);
  const payload = `L\u0000${instance.id}\u0000${instance.position[0]},${instance.position[1]},${instance.position[2]},${instance.radius}`
    + `\u0000${cellPayload(cell)}`;
  const id = `hlod-${contentHash64(payload)}`;
  const cached = context.cache.get(id);
  const node: HlodClusterNode = Object.freeze({
    id, level: 0, cell: Object.freeze({ center: cell.center, side: cell.side }),
    children: Object.freeze([]), instanceIds: Object.freeze([instance.id]),
    instanceCount: 1, center: instance.position, radius: instance.radius,
  });
  if (cached) return reuse(context, cached, node);
  context.nodes.set(id, node);
  context.leafByInstance.set(instance.id, id);
  context.rebuilt += 1;
  return node;
}

function assemble(context: BuildContext, children: readonly HlodClusterNode[],
  members: readonly Instance[], cell: Cell): HlodClusterNode {
  context.maxFanout = Math.max(context.maxFanout, children.length);
  const sphere = enclosingSphere(children);
  const payload = `C\u0000${children.map(child => child.id).join("\u0000")}\u0000${cellPayload(cell)}`;
  const id = `hlod-${contentHash64(payload)}`;
  const cached = context.cache.get(id);
  const orderedMembers = [...members].sort(compareInstance);
  const node: HlodClusterNode = Object.freeze({
    id, level: Math.max(...children.map(child => child.level)) + 1,
    cell: Object.freeze({ center: cell.center, side: cell.side }),
    children: Object.freeze(children.map(child => child.id)),
    instanceIds: Object.freeze(orderedMembers.map(instance => instance.id)),
    instanceCount: members.length,
    center: sphere.center, radius: sphere.radius,
  });
  if (cached) return reuse(context, cached, node);
  context.nodes.set(id, node);
  context.rebuilt += 1;
  return node;
}

/** 内容 id 命中:复用前树对象;几何逐字段不等 = 哈希碰撞,fail-closed。 */
function reuse(context: BuildContext, cached: HlodClusterNode, fresh: HlodClusterNode): HlodClusterNode {
  const identical = cached.level === fresh.level && sameIds(cached.children, fresh.children)
    && sameIds(cached.instanceIds, fresh.instanceIds)
    && cached.instanceCount === fresh.instanceCount
    && cached.cell.side === fresh.cell.side
    && cached.cell.center[0] === fresh.cell.center[0] && cached.cell.center[1] === fresh.cell.center[1]
    && cached.cell.center[2] === fresh.cell.center[2]
    && cached.center[0] === fresh.center[0] && cached.center[1] === fresh.center[1] && cached.center[2] === fresh.center[2]
    && cached.radius === fresh.radius;
  if (!identical) {
    throw new HlodError("hash-collision", `HLOD content hash collision at node ${cached.id}.`);
  }
  context.nodes.set(cached.id, cached);
  if (cached.children.length === 0) {
    context.leafByInstance.set(cached.instanceIds[0]!, cached.id);
  }
  context.reused += 1;
  return cached;
}

function buildParentMap(nodes: ReadonlyMap<string, HlodClusterNode>, rootId: string | null): Map<string, string | null> {
  const parentByNode = new Map<string, string | null>();
  if (rootId === null) return parentByNode;
  const walk = (nodeId: string, parent: string | null): void => {
    parentByNode.set(nodeId, parent);
    for (const child of nodes.get(nodeId)!.children) walk(child, nodeId);
  };
  walk(rootId, null);
  return parentByNode;
}

/** 导出给测试与诊断:子球最小包围球与文本比较器。 */
export { compareText, contentHash64, enclosingSphere, rootCellOf };
export type { Cell, HlodCell };
