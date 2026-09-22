import type { DashboardRootLayerRef, WidgetNode } from "@bim-studio/contracts";
import { createDashboardLayerDropCommand } from "./dashboardLayerDrop";
import type { LayerDropIntent } from "./layerDropIntent";

type Reason = ReturnType<typeof createDashboardLayerDropCommand>["reason"];
type NodeState = { [Key in "id" | "zIndex" | "locked" | "groupId" | "groupName"]-?: WidgetNode[Key] };
interface Preview { target: string | undefined; intent: LayerDropIntent; reason: Reason }
const sameNode = (a: WidgetNode, b: NodeState | undefined) => b !== undefined && a.id === b.id && a.zIndex === b.zIndex
  && a.locked === b.locked && a.groupId === b.groupId && a.groupName === b.groupName;

/** 高频 dragover 只校验轻量状态；落点或排序/锁定/选择变化时才重建命令预览。 */
export class DashboardLayerDropPreview {
  private previous: { pageId: string; sourceId: string; nodes: NodeState[]; selected: string[]; preview: Preview; order: string } | undefined;
  inspect(pageId: string, nodes: readonly WidgetNode[], selected: readonly string[], sourceId: string, target: string | undefined, intent: LayerDropIntent, rootOrder?: readonly DashboardRootLayerRef[]): Preview {
    const old = this.previous;
    const order = JSON.stringify(rootOrder);
    if (old && old.pageId === pageId && old.sourceId === sourceId && old.preview.target === target
      && old.order === order && old.preview.intent.sourceKind === intent.sourceKind && old.preview.intent.position === intent.position && old.preview.intent.targetKind === intent.targetKind
      && old.nodes.length === nodes.length && old.selected.length === selected.length
      && selected.every((id, index) => id === old.selected[index]) && nodes.every((node, index) => sameNode(node, old.nodes[index]))) return old.preview;
    const result = createDashboardLayerDropCommand(pageId, nodes, selected, sourceId, target, intent, rootOrder);
    const preview = { target, intent, reason: result.reason };
    this.previous = { pageId, sourceId, preview, order, selected: [...selected], nodes: nodes.map(({ id, zIndex, locked, groupId, groupName }) => ({ id, zIndex, locked, groupId, groupName })) };
    return preview;
  }
  clear() { this.previous = undefined; }
}
