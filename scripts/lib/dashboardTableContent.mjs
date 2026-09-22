/** Resolve only resources owned by the validated table contract and this exact runtime slot. */
export function tableContentIds(dashboard, nodeId, initialOnly = false) {
  const table = dashboard.tables?.find(table => table.nodeIds.includes(nodeId));
  if (!table) return undefined;
  const views = initialOnly ? [table.families[0]?.orders[0]?.pages[0]]
    : table.families.flatMap(family => family.orders.flatMap(order => order.pages));
  return [...new Set(views.filter(Boolean).flatMap(view => view.layers.filter(layer => layer.nodeId === nodeId).map(layer => layer.deep2d)))];
}
