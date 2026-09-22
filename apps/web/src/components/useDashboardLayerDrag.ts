import { useEffect, useRef, useState, type DragEvent } from "react";
import type { DashboardRootLayerRef, WidgetNode } from "@bim-studio/contracts";
import { createDashboardLayerDropCommand } from "./dashboardLayerDrop";
import { resolveLayerDropPosition, type LayerDropIntent } from "./layerDropIntent";
import { DashboardLayerDropPreview } from "./dashboardLayerDropPreview";

const mime = "application/x-deep-dashboard-layer";
type DropReason = ReturnType<typeof createDashboardLayerDropCommand>["reason"];
interface Options {
  page: { id: string; nodes: WidgetNode[]; rootLayerOrder?: DashboardRootLayerRef[] }; selectedNodeIds: string[];
  reorderLayerByDrop: (source: string, target?: string, intent?: LayerDropIntent) => DropReason;
}

export function useDashboardLayerDrag(options: Options) {
  const session = useRef<string | undefined>(undefined);
  const sourceKind = useRef<"item" | "group">("item");
  const [draggedLayerId, setDraggedLayerId] = useState<string>();
  const preview = useRef(new DashboardLayerDropPreview());
  const [feedback, setFeedback] = useState<{ target: string | undefined; intent: LayerDropIntent; reason: DropReason }>();
  const [reason, setReason] = useState<DropReason>();
  const cancel = () => {
    session.current = undefined; setFeedback(undefined);
    preview.current.clear();
    setDraggedLayerId(undefined);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || !session.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel(); setReason(undefined);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    return () => { session.current = undefined; window.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel); };
  }, [options.page.id]);
  function start(event: DragEvent, id: string, kind: "item" | "group" = "item") {
    const requested = kind === "group" ? options.page.nodes.filter(node => node.groupId === id).map(node => node.id)
      : options.selectedNodeIds.includes(id) ? options.selectedNodeIds : [id];
    const nodes = new Map(options.page.nodes.map(node => [node.id, node]));
    if (!requested.length || requested.some(item => !nodes.has(item) || nodes.get(item)!.locked)) {
      event.preventDefault(); cancel();
      setReason(requested.some(item => !nodes.has(item)) ? "missing-node" : "locked-source"); return;
    }
    session.current = id; sourceKind.current = kind; setReason(undefined); setFeedback(undefined); setDraggedLayerId(id);
    event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(mime, id);
  }
  function inspect(event: DragEvent, target?: string, kind: "item" | "group" = "item") {
    if (!session.current) return;
    const intent: LayerDropIntent = { position: target ? resolveLayerDropPosition(kind, event.clientY, event.currentTarget.getBoundingClientRect()) : "after", targetKind: kind,
      ...(sourceKind.current === "group" ? { sourceKind: "group" as const } : {}) };
    return preview.current.inspect(options.page.id, options.page.nodes, options.selectedNodeIds, session.current, target, intent, options.page.rootLayerOrder);
  }
  function over(event: DragEvent, target?: string, kind: "item" | "group" = "item") {
    const next = inspect(event, target, kind);
    if (!next) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = next.reason ? "none" : "move";
    setFeedback(current => current === next ? current : next);
  }
  function drop(event: DragEvent, target?: string, kind: "item" | "group" = "item") {
    event.preventDefault(); event.stopPropagation();
    const next = inspect(event, target, kind);
    if (!next || !session.current) return;
    setReason(next.reason ?? options.reorderLayerByDrop(session.current, target, next.intent)); cancel();
  }
  function indicator(target?: string, kind: "item" | "group" = "item") {
    return feedback && feedback.target === target && feedback.intent.targetKind === kind ? feedback.reason ? "invalid" : feedback.intent.position : undefined;
  }
  return { start, over, drop, cancel, indicator, reason, feedback, draggedLayerId };
}
