import type { SceneRootLayerRef } from "@bim-studio/contracts";
import { moveSceneRootLayers, normalizeSceneRootLayerOrder, sceneRootLayerKey } from "../components/sceneRootLayerOrder";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

/** 根目录重排只调整作者组织，不更改场景变换或组内相对次序。 */
export function createSceneRootEntryMover(context: SceneEditorControllerContext, commit: (label: string) => void) {
  return (moving: SceneRootLayerRef[], target?: SceneRootLayerRef, position: "before" | "after" = "before") => {
    if (!context.setRootLayerOrder || !moving.length) return;
    const objects = new Map(context.sceneOrganizationObjects.map(item => [item.id, item]));
    const groups = context.selectionSets.filter(group => group.kind === "group");
    const valid = (ref: SceneRootLayerRef) => ref.kind === "object" ? objects.has(ref.id) && !objects.get(ref.id)!.locked
      : ref.kind === "group" && groups.some(group => group.id === ref.id && group.objectIds.every(id => objects.has(id) && !objects.get(id)!.locked));
    if (moving.some(ref => !valid(ref)) || target && !valid(target)) return;
    const keys = new Set(moving.map(sceneRootLayerKey));
    if (target && keys.has(sceneRootLayerKey(target))) return;
    const detached = new Set(moving.filter(ref => ref.kind === "object").map(ref => ref.id));
    if (moving.some(ref => ref.kind === "group" && groups.find(group => group.id === ref.id)!.objectIds.some(id => detached.has(id)))) return;
    const nextGroups = context.selectionSets.map(group => group.kind === "group" ? { ...group, objectIds: group.objectIds.filter(id => !detached.has(id)) } : group);
    const grouped = new Set(nextGroups.filter(group => group.kind === "group").flatMap(group => group.objectIds));
    const ungrouped = context.sceneOrganizationObjects.filter(item => !grouped.has(item.id));
    const available: SceneRootLayerRef[] = [...groups.map(group => ({ kind: "group" as const, id: group.id })),
      ...[...ungrouped.filter(item => item.kind === "model"), ...ungrouped.filter(item => item.kind !== "model")].map(item => ({ kind: "object" as const, id: item.id })),
      ...(context.rootLayerOrder ?? []).filter(ref => ref.kind !== "group" && ref.kind !== "object")];
    const current = normalizeSceneRootLayerOrder(context.rootLayerOrder, available);
    const remaining = current.filter(ref => !keys.has(sceneRootLayerKey(ref)));
    const index = target ? remaining.findIndex(ref => sceneRootLayerKey(ref) === sceneRootLayerKey(target)) : -1;
    if (target && index < 0) return; // 不能把组拖入组内对象旁边形成隐式嵌套。
    const before = index < 0 ? undefined : remaining[index + (position === "after" ? 1 : 0)];
    const order = moveSceneRootLayers(current, available, moving, before);
    if (JSON.stringify(order) === JSON.stringify(current) && JSON.stringify(nextGroups) === JSON.stringify(context.selectionSets)) return;
    context.setSelectionSets(nextGroups); context.setRootLayerOrder(order);
    commit("调整场景根目录顺序");
  };
}
