/**
 * T26 HLOD 增量失效(局部性语义,同 T13 块缓存纪律:引用不变 = 未重建的可断言证据)。
 *
 * == 局部性证明(结构性的,不是概率性的) ==
 * 节点身份 = 子树内容哈希(叶 = 实例指纹;内节点 = 子 id 序列,递归封底)。
 * 实例增/删/移只改变受影响叶的指纹 → 内容 id 变化的节点集 = {变更叶} ∪ 其祖先闭包:
 * - 任一不含变更实例的节点 X:X 的子树内容不变 ⇒ id 不变 ⇒ 从前树**复用同一对象**
 *   (几何逐字段相等,哈希碰撞 fail-closed);归纳可证其祖先链同样不变。
 * - 含变更实例的节点:包围球必须更新,重建(半径/中心重算,id 随内容变)。
 * 因此 `rebuiltNodes` 恰为祖先闭包大小(≤ Σ路径长),`reusedNodes` 为其余全部;
 * 且全量与增量走 `buildHlodTreeCore` 同一代码路径 → 增量结果 ≡ 全量重建(测试逐位断言)。
 *
 * 删除/移动到原位的边界:no-op 变更(指纹不变)→ 整树复用,delta.rebuiltNodes = 0;
 * 全部删除 → 空树(rootId = null,合法状态)。
 */

import { buildHlodTreeCore, validateHlodInstances } from "./hlodCluster.js";
import {
  HlodError,
  type HlodClusterTree,
  type HlodInstanceInput,
  type HlodTreeChangeSet,
  type HlodTreeDelta,
} from "./hlodTypes.js";

/**
 * 增量更新:只重算受影响簇。选项缺省沿用前树配置;显式换配置仍安全
 * (节点 id 编码了子结构,形状差异必然体现为不同 id,不会错误复用)。
 */
export function updateHlodTree(previous: HlodClusterTree, changes: HlodTreeChangeSet,
  options = previous.options): { tree: HlodClusterTree; delta: HlodTreeDelta } {
  if (!previous || typeof previous !== "object" || previous.algorithmVersion === undefined) {
    throw new HlodError("invalid-options", "updateHlodTree requires a previous HLOD cluster tree.");
  }
  const members = new Map<string, HlodInstanceInput>();
  for (const [instanceId, leafId] of previous.leafByInstance) {
    const leaf = previous.nodes.get(leafId);
    if (!leaf) throw new HlodError("unknown-node", `Previous tree leaf ${leafId} is missing.`);
    members.set(instanceId, { id: instanceId, position: leaf.center, radius: leaf.radius });
  }
  for (const id of changes.removed ?? []) {
    if (!members.delete(id)) throw new HlodError("unknown-node", `Removed instance ${id} is not in the previous tree.`);
  }
  for (const instance of changes.moved ?? []) {
    if (!members.has(instance.id)) throw new HlodError("unknown-node", `Moved instance ${instance.id} is not in the previous tree.`);
    members.set(instance.id, instance);
  }
  for (const instance of changes.added ?? []) {
    if (members.has(instance.id)) throw new HlodError("duplicate-instance-id", `Added instance ${instance.id} already exists.`);
    members.set(instance.id, instance);
  }
  return buildHlodTreeCore(validateHlodInstances([...members.values()]), options, previous.nodes);
}
