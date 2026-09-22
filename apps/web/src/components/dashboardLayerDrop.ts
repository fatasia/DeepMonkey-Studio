import { dashboardLayerKey, dashboardLayerNodes, dashboardRootLayerOrder, type DashboardRootLayerRef, type WidgetNode } from "@bim-studio/contracts";
import { createUpdateDashboardNodeStatesCommand } from "@bim-studio/studio-core";
import type { LayerDropIntent } from "./layerDropIntent";

/** 图层按显示顺序整体移动；锁定节点的排序值和组归属保持原样。 */
export function createDashboardLayerDropCommand(pageId: string, nodes: readonly WidgetNode[], selectedIds: readonly string[], sourceId: string, targetId?: string, intent: LayerDropIntent = { position: "before" }, rootOrder?: readonly DashboardRootLayerRef[]) {
  const displayed = dashboardLayerNodes(nodes, rootOrder);
  const groupSource = intent.sourceKind === "group";
  const source = displayed.find(node => groupSource ? node.groupId === sourceId : node.id === sourceId);
  const groupTarget = intent.targetKind === "group";
  if (!groupTarget && intent.position === "inside") return { reason: "invalid-inside" as const };
  const target = displayed.find(node => groupTarget ? node.groupId === targetId : node.id === targetId);
  if (!source || (targetId !== undefined && !target)) return { reason: "missing-node" as const };
  if (groupSource && (intent.position === "inside" || !groupTarget && target?.groupId)) return { reason: "group-edge" as const };
  if (groupSource && groupTarget && sourceId === targetId) return { reason: "self-target" as const };
  if (source.locked) return { reason: "locked-source" as const };
  if (target?.locked) return { reason: "locked-group" as const };
  if (target?.groupId && nodes.some(node => node.groupId === target.groupId && node.locked)) return { reason: "locked-group" as const };
  const requested = new Set(groupSource ? nodes.filter(node => node.groupId === sourceId).map(node => node.id) : selectedIds.includes(sourceId) ? selectedIds : [sourceId]);
  const available = new Set(displayed.map(node => node.id));
  if ([...requested].some(id => !available.has(id))) return { reason: "missing-node" as const };
  if (displayed.some(node => requested.has(node.id) && node.locked)) return { reason: "locked-source" as const };
  const moving = displayed.filter(node => requested.has(node.id));
  const movingIds = new Set(moving.map(node => node.id));
  if (!groupTarget && targetId && movingIds.has(targetId)) return { reason: "self-target" as const };
  const provisional = displayed.filter(node => !movingIds.has(node.id));
  const memberIndex = groupTarget ? provisional.findIndex(node => node.groupId === targetId) : -1;
  const targetIndex = groupTarget ? (memberIndex < 0 ? provisional.length : memberIndex)
    : targetId ? provisional.findIndex(node => node.id === targetId) + (intent.position === "after" ? 1 : 0) : provisional.length;
  provisional.splice(targetIndex, 0, ...moving);
  const destinationGroup = groupTarget ? intent.position === "inside" ? target?.groupId : undefined : target?.groupId;
  const nextNodes = provisional.map((node, index) => ({ ...node, zIndex: provisional.length - index,
    ...(!groupSource && movingIds.has(node.id) ? { groupId: destinationGroup, groupName: destinationGroup ? target?.groupName : undefined } : {}),
  })) as WidgetNode[];
  // 用原节点枚举保证旧页组次序不受 provisional 的成员插入影响。
  const byId = new Map(nextNodes.map(node => [node.id, node]));
  let roots = dashboardRootLayerOrder(nodes.map(node => byId.get(node.id)!), rootOrder);
  if (!destinationGroup || groupSource) {
    const moved: DashboardRootLayerRef[] = groupSource ? [{ kind: "group", id: sourceId }] : moving.map(node => ({ kind: "node", id: node.id }));
    const keys = new Set(moved.map(dashboardLayerKey));
    const remaining = roots.filter(ref => !keys.has(dashboardLayerKey(ref)));
    const targetRef = targetId ? { kind: groupTarget ? "group" as const : "node" as const, id: targetId } : undefined;
    const index = targetRef ? remaining.findIndex(ref => dashboardLayerKey(ref) === dashboardLayerKey(targetRef)) : -1;
    const originalRoots = index < 0 && targetRef ? dashboardRootLayerOrder(nodes, rootOrder) : [];
    const originalIndex = targetRef ? originalRoots.findIndex(ref => dashboardLayerKey(ref) === dashboardLayerKey(targetRef)) : -1;
    const remainingKeys = new Set(remaining.map(dashboardLayerKey));
    const nextSurvivor = originalIndex < 0 ? undefined : originalRoots.slice(originalIndex + 1).find(ref => remainingKeys.has(dashboardLayerKey(ref)));
    // 移出最后一个成员时组会消失；保留原组所在位置，不能把该成员误移到末尾。
    const insertion = index < 0 ? nextSurvivor ? remaining.findIndex(ref => dashboardLayerKey(ref) === dashboardLayerKey(nextSurvivor)) : remaining.length
      : index + (intent.position === "after" ? 1 : 0);
    roots = [...remaining.slice(0, insertion), ...moved, ...remaining.slice(insertion)];
  }
  const originals = new Map(nodes.map(node => [node.id, node]));
  const ordered = dashboardLayerNodes(nextNodes, roots).map(node => originals.get(node.id)!);
  const groupChanged = !groupSource && moving.some(node => node.groupId !== destinationGroup || node.groupName !== (destinationGroup ? target?.groupName : undefined));
  if (!groupChanged && ordered.every((node, index) => node.id === displayed[index]?.id)
    && JSON.stringify(roots) === JSON.stringify(dashboardRootLayerOrder(nodes, rootOrder))) return { reason: "unchanged" as const };
  const indices = fixedLockOrder(ordered);
  if (!indices) return { reason: "locked-order-gap" as const };
  const states = ordered.flatMap((node, index) => {
    if (node.locked) return [];
    const zIndex = indices[index]!;
    const grouping = !groupSource && movingIds.has(node.id) && (node.groupId !== destinationGroup || node.groupName !== (destinationGroup ? target?.groupName : undefined));
    if (zIndex === node.zIndex && !grouping) return [];
    return [{ nodeId: node.id, state: {
      ...(zIndex !== node.zIndex ? { zIndex } : {}),
      ...(grouping ? { groupId: destinationGroup ?? null, groupName: destinationGroup ? target?.groupName ?? null : null } : {}),
    } }];
  });
  return { command: createUpdateDashboardNodeStatesCommand(pageId, states, "移动二维图层", roots) };
}

/** CSS 层级必须是整数。锁定锚点之间无整数空位时，拒绝重排而非偷偷改锁定项。 */
export function fixedLockOrder(nodes: readonly WidgetNode[]): number[] | undefined {
  const result = nodes.map(node => node.zIndex);
  let previous = -1;
  for (let next = 0; next <= nodes.length; next += 1) {
    if (next < nodes.length && !nodes[next]!.locked) continue;
    const count = next - previous - 1;
    const upper = previous >= 0 ? nodes[previous]!.zIndex : undefined;
    const lower = next < nodes.length ? nodes[next]!.zIndex : undefined;
    if ((upper !== undefined && !Number.isSafeInteger(upper)) || (lower !== undefined && !Number.isSafeInteger(lower))) return;
    if (upper !== undefined && lower !== undefined && upper - lower <= count) return;
    const start = upper !== undefined ? upper - 1 : lower !== undefined ? lower + count : count - 1;
    for (let offset = 0; offset < count; offset += 1) {
      const value = start - offset;
      if (!Number.isSafeInteger(value)) return;
      result[previous + 1 + offset] = value;
    }
    previous = next;
  }
  return result;
}
