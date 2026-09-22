import type { DashboardRootLayerRef, WidgetNode } from "./application.js";

export const dashboardLayerKey = (ref: DashboardRootLayerRef): string => `${ref.kind}:${ref.id}`;

/** 旧页保留组头在前；显式次序忽略已删引用，新根行按旧规则追加。 */
export function dashboardRootLayerOrder(nodes: readonly WidgetNode[], order?: readonly DashboardRootLayerRef[]): DashboardRootLayerRef[] {
  const groups = [...new Set(nodes.flatMap(node => node.groupId ? [node.groupId] : []))];
  const available: DashboardRootLayerRef[] = [...groups.map(id => ({ kind: "group" as const, id })),
    ...[...nodes].filter(node => !node.groupId).sort((a, b) => b.zIndex - a.zIndex).map(node => ({ kind: "node" as const, id: node.id }))];
  const remaining = new Map(available.map(ref => [dashboardLayerKey(ref), ref]));
  return [...(order ?? []), ...available].flatMap(ref => {
    const key = dashboardLayerKey(ref), current = remaining.get(key);
    if (!current) return []; remaining.delete(key); return [{ ...current }];
  });
}

export function dashboardLayerNodes(nodes: readonly WidgetNode[], order?: readonly DashboardRootLayerRef[], collapsed: ReadonlySet<string> = new Set()): WidgetNode[] {
  const sorted = [...nodes].sort((a, b) => b.zIndex - a.zIndex);
  const byId = new Map(sorted.map(node => [node.id, node]));
  const groups = new Map<string, WidgetNode[]>();
  for (const node of sorted) if (node.groupId) {
    const members = groups.get(node.groupId) ?? []; members.push(node); groups.set(node.groupId, members);
  }
  return dashboardRootLayerOrder(nodes, order).flatMap(ref => ref.kind === "group"
    ? collapsed.has(ref.id) ? [] : groups.get(ref.id) ?? []
    : byId.has(ref.id) ? [byId.get(ref.id)!] : []);
}
