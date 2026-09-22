import { dashboardLayerKey, dashboardLayerNodes, dashboardRootLayerOrder, type DashboardPageDocument } from "@bim-studio/contracts";
import { createUpdateDashboardNodeStatesCommand } from "@bim-studio/studio-core";
import { fixedLockOrder } from "./dashboardLayerDrop";

type Direction = "front" | "forward" | "backward" | "back";
function arrange<T>(items: readonly T[], selected: (item: T) => boolean, direction: Direction): T[] {
  const result = [...items];
  if (direction === "front" || direction === "back") {
    const moving = result.filter(selected), remaining = result.filter(item => !selected(item));
    return direction === "front" ? [...moving, ...remaining] : [...remaining, ...moving];
  }
  if (direction === "forward") {
    for (let index = 1; index < result.length; index += 1) if (selected(result[index]!) && !selected(result[index - 1]!))
      [result[index - 1], result[index]] = [result[index]!, result[index - 1]!];
  } else {
    for (let index = result.length - 2; index >= 0; index -= 1) if (selected(result[index]!) && !selected(result[index + 1]!))
      [result[index], result[index + 1]] = [result[index + 1]!, result[index]!];
  }
  return result;
}

/** 菜单层级操作使用同一根顺序，部分组选择只在组内移动，不改变归属。 */
export function createDashboardLayerArrangeCommand(page: DashboardPageDocument, ids: readonly string[], direction: Direction) {
  const selected = new Set(ids), byId = new Map(page.nodes.map(node => [node.id, node]));
  if (!ids.length || ids.some(id => !byId.has(id) || byId.get(id)!.locked)) return;
  const displayed = dashboardLayerNodes(page.nodes, page.rootLayerOrder);
  const groups = new Map<string, typeof displayed>();
  for (const node of displayed) if (node.groupId) { const members = groups.get(node.groupId) ?? []; members.push(node); groups.set(node.groupId, members); }
  const roots = dashboardRootLayerOrder(page.nodes, page.rootLayerOrder);
  const pickedRoots = new Set(roots.filter(ref => ref.kind === "node" ? selected.has(ref.id) : groups.get(ref.id)!.every(node => selected.has(node.id))).map(dashboardLayerKey));
  const nextRoots = arrange(roots, ref => pickedRoots.has(dashboardLayerKey(ref)), direction);
  const ordered = nextRoots.flatMap(ref => ref.kind === "node" ? [byId.get(ref.id)!]
    : arrange(groups.get(ref.id)!, node => selected.has(node.id), direction));
  if (ordered.every((node, index) => node.id === displayed[index]?.id)) return;
  const indices = fixedLockOrder(ordered); if (!indices) return;
  const states = ordered.flatMap((node, index) => node.locked || node.zIndex === indices[index] ? [] : [{ nodeId: node.id, state: { zIndex: indices[index]! } }]);
  return createUpdateDashboardNodeStatesCommand(page.id, states, "调整二维图层顺序", nextRoots);
}

/** 编组与解组同步目录及覆盖层级，完整落入同一历史命令。 */
export function createDashboardGroupingCommand(page: DashboardPageDocument, ids: readonly string[], group?: { id: string; name: string }) {
  const selected = new Set(ids), byId = new Map(page.nodes.map(node => [node.id, node]));
  if (!ids.length || ids.some(id => !byId.has(id) || byId.get(id)!.locked)) return;
  const displayed = dashboardLayerNodes(page.nodes, page.rootLayerOrder);
  const next = displayed.map(node => {
    if (!selected.has(node.id)) return node;
    const copy = { ...node }; delete copy.groupId; delete copy.groupName;
    return group ? { ...copy, groupId: group.id, groupName: group.name } : copy;
  });
  const roots = dashboardRootLayerOrder(next, next.map(node => node.groupId ? { kind: "group", id: node.groupId } : { kind: "node", id: node.id }));
  const ordered = dashboardLayerNodes(next, roots), indices = fixedLockOrder(ordered); if (!indices) return;
  const states = ordered.flatMap((node, index) => node.locked ? [] : [{ nodeId: node.id, state: {
    zIndex: indices[index]!, ...(selected.has(node.id) ? { groupId: group?.id ?? null, groupName: group?.name ?? null } : {}),
  } }]);
  return createUpdateDashboardNodeStatesCommand(page.id, states, group ? "编组二维组件" : "解组二维组件", roots);
}
