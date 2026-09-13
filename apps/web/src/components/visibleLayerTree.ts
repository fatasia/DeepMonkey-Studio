import type { LayerTreeNode } from "../viewer/ViewerEngine";
export function visibleLayerTree(root: LayerTreeNode, expanded: ReadonlySet<string>) {
  const rows: Array<{ node: LayerTreeNode; depth: number }> = [], pending = [{ node: root, depth: 0 }];
  while (pending.length) {
    const row = pending.pop()!; rows.push(row);
    if (expanded.has(row.node.id)) for (let i = row.node.children.length - 1; i >= 0; i--) pending.push({ node: row.node.children[i]!, depth: row.depth + 1 });
  }
  return rows;
}
export function layerAncestors(root: LayerTreeNode, selectedId: string) {
  const parents = new Map<string, string>(), pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.id === selectedId) {
      const result: string[] = []; let id = parents.get(node.id);
      while (id) { result.push(id); id = parents.get(id); }
      return result;
    }
    for (const child of node.children) { parents.set(child.id, node.id); pending.push(child); }
  }
  return [];
}
