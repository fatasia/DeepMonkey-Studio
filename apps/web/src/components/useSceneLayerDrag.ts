import { useEffect, useRef, type DragEvent } from "react";
import { resolveLayerDropPosition, type LayerDropPosition } from "./layerDropIntent";
import { orderSceneLayerDragIds, SceneLayerDragSession } from "./sceneLayerDragSession";
import type { SceneRootLayerRef } from "@bim-studio/contracts";

const mime = "application/x-scene-object-ids";
const session = new SceneLayerDragSession<HTMLElement>();
let highlighted: HTMLElement | undefined;
let dragged: HTMLElement | undefined;
let dispose: (() => void) | undefined;
let sourceGroup: string | undefined;
function clearHighlight() {
  if (highlighted) { delete highlighted.dataset.layerDrop; highlighted.removeAttribute("data-drop-reason"); }
  highlighted = undefined;
}
function cancel() { session.cancel(); sourceGroup = undefined; dragged = undefined; clearHighlight(); dispose?.(); dispose = undefined; }
function scopeOf(element: HTMLElement) { return element.closest<HTMLElement>("[data-layer-order]"); }

interface DragObject { id: string; locked: boolean }
interface Options {
  objectId?: string | undefined; groupId?: string | undefined; locked?: boolean | undefined;
  selectedIds?: ReadonlySet<string> | undefined;
  organizationObjects?: readonly DragObject[] | undefined;
  groups?: readonly { id: string; objectIds: string[] }[] | undefined;
  onMoveObjects?: ((ids: string[], groupId?: string, targetId?: string, position?: "before" | "after") => void) | undefined;
  onMoveRootEntries?: ((refs: SceneRootLayerRef[], target?: SceneRootLayerRef, position?: "before" | "after") => void) | undefined;
  root?: boolean; deniedText: string;
}

export function sceneLayerDropAllowed(ids: readonly string[], objects: readonly DragObject[] | undefined, groupMembers: readonly string[] = [], targetId?: string): boolean {
  if (!ids.length || (targetId !== undefined && ids.includes(targetId))) return false;
  if (!objects) return true; // 最终组织命令仍复核权威状态；根移出入口不持有对象副本。
  const byId = new Map(objects.map(item => [item.id, item]));
  return ids.every(id => byId.has(id) && !byId.get(id)!.locked)
    && !groupMembers.some(id => byId.get(id)?.locked);
}

/** 会话期间才注册全局取消事件，避免大型目录为每一行注册监听器。 */
export function useSceneLayerDrag(options: Options) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = element.current;
    return () => { if (dragged === row) cancel(); else if (highlighted === row) clearHighlight(); };
  }, []);
  function intent(event: DragEvent<HTMLDivElement>): LayerDropPosition | undefined {
    if (options.root) return "inside";
    const position = resolveLayerDropPosition(options.objectId ? "item" : "group", event.clientY, event.currentTarget.getBoundingClientRect());
    return position;
  }
  function activeIds(event: DragEvent<HTMLDivElement>, requireToken = false) {
    const scope = scopeOf(event.currentTarget);
    if (!scope || !scope.isConnected || !event.dataTransfer.types.includes(mime)) return;
    return session.read(scope, requireToken ? event.dataTransfer.getData(mime) : undefined);
  }
  function allowed(ids: string[], position: LayerDropPosition | undefined) {
    const members = options.groupId ? options.groups?.find(group => group.id === options.groupId)?.objectIds : [];
    if (sourceGroup) {
      const source = options.groups?.find(group => group.id === sourceGroup);
      const byId = new Map(options.organizationObjects?.map(item => [item.id, item]));
      return Boolean(options.onMoveRootEntries && source && position !== "inside" && !options.locked
        && (!options.objectId || !options.groupId) && options.groupId !== sourceGroup
        && [...source.objectIds, ...(members ?? [])].every(id => byId.has(id) && !byId.get(id)!.locked));
    }
    if (!options.objectId && options.groupId && position !== "inside") {
      return Boolean(options.onMoveRootEntries && !options.locked && sceneLayerDropAllowed(ids, options.organizationObjects, members));
    }
    return Boolean(position && options.onMoveObjects && !options.locked && sceneLayerDropAllowed(ids, options.organizationObjects, members, options.objectId));
  }
  return {
    ref: element,
    onDragStart(event: DragEvent<HTMLDivElement>) {
      const group = !options.objectId && options.groupId ? options.groups?.find(item => item.id === options.groupId) : undefined;
      if (options.locked || (group ? !options.onMoveRootEntries : !options.objectId || !options.onMoveObjects)) { event.preventDefault(); return; }
      const scope = scopeOf(event.currentTarget);
      if (!scope) { event.preventDefault(); return; }
      const selected = group ? group.objectIds : options.selectedIds?.has(options.objectId!) ? [...options.selectedIds] : [options.objectId!];
      if ((selected.length || !group) && !sceneLayerDropAllowed(selected, options.organizationObjects)) { event.preventDefault(); return; }
      const order: string[] = JSON.parse(scope.dataset.layerOrder ?? "[]");
      const ids = orderSceneLayerDragIds(order, selected);
      cancel();
      sourceGroup = group?.id;
      dragged = event.currentTarget;
      const token = session.begin(scope, group ? [group.id] : ids, crypto.randomUUID());
      const escape = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || key.isComposing || key.keyCode === 229) return;
        key.preventDefault(); key.stopImmediatePropagation(); cancel();
      };
      window.addEventListener("keydown", escape, true);
      window.addEventListener("blur", cancel);
      window.addEventListener("dragend", cancel, true);
      dispose = () => { window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", cancel); window.removeEventListener("dragend", cancel, true); };
      event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(mime, token);
    },
    onDragOver(event: DragEvent<HTMLDivElement>) {
      const ids = activeIds(event); if (!ids) return;
      event.preventDefault(); event.stopPropagation();
      const position = intent(event), valid = allowed(ids, position);
      clearHighlight(); highlighted = event.currentTarget;
      highlighted.dataset.layerDrop = valid ? position : "denied";
      if (!valid) highlighted.dataset.dropReason = options.deniedText;
      event.dataTransfer.dropEffect = valid ? "move" : "none";
    },
    onDragLeave(event: DragEvent<HTMLDivElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && highlighted === event.currentTarget) clearHighlight();
    },
    onDrop(event: DragEvent<HTMLDivElement>) {
      const ids = activeIds(event, true); if (!ids) return;
      event.preventDefault(); event.stopPropagation();
      const position = intent(event), valid = allowed(ids, position), group = sourceGroup; cancel();
      if (!valid) return;
      const edge = position === "after" ? "after" : "before";
      if (group || !options.objectId && options.groupId && position !== "inside") {
        options.onMoveRootEntries?.(group ? [{ kind: "group", id: group }] : ids.map(id => ({ kind: "object", id })),
          options.objectId ? { kind: "object", id: options.objectId } : options.groupId ? { kind: "group", id: options.groupId } : undefined, edge);
      } else options.onMoveObjects?.(ids, options.groupId, options.objectId, edge);
    },
    onDragEnd: cancel,
  };
}
