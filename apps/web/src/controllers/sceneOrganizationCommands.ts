import type { SceneRootLayerRef, SceneSelectionSetState } from "@bim-studio/contracts";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { layerLockCommand, layerVisibilityCommand } from "../commands/engineEditCommand";
import { moveSceneRootLayers, normalizeSceneRootLayerOrder } from "../components/sceneRootLayerOrder";
import { translate as tr } from "../i18n";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";
import { synchronizeSelectionFromOutliner } from "./sceneSelectionSynchronization";
import { selectLayerIds, visibleLayerIds, type LayerSelectionIntent } from "../components/layerSelection";
import { createSceneRootEntryMover } from "./sceneRootEntryCommands";

/** 场景树、选择集和编组命令；只改变组织状态，不持有页面 UI 状态。 */
export function createSceneOrganizationCommands(context: SceneEditorControllerContext) {
  const {
    engine,
    locale,
    sceneOrganizationObjects,
    sceneOrganizationSelection,
    selectionSets,
    lastDeletedSelectionSet,
    setMessage,
    setRevision,
    setSelectedLightId,
    setSceneOrganizationSelection,
    setSelectionSets,
    setLastDeletedSelectionSet,
    recordSceneEdit,
  } = context;

  function commitOrganizationChange(label: string) {
    setRevision((value) => value + 1);
    recordSceneEdit(label);
  }

  function replaceSceneOrganizationSelection(ids: string[]) {
    const available = new Set(sceneOrganizationObjects.map((item) => item.id));
    setSelectedLightId?.("");
    synchronizeSelectionFromOutliner(ids, available, {
      selectPrimaryInViewer: (id) => engine?.select(id),
      replaceObjectSelection: (next) => setSceneOrganizationSelection(next),
    });
  }

  function selectSceneOrganizationObject(
    id: string,
    options: LayerSelectionIntent = {},
  ) {
    const available = new Set(sceneOrganizationObjects.map(item => item.id));
    const orderedIds = options.orderedIds?.filter(id => available.has(id)) ?? [...available];
    if (!orderedIds.includes(id)) return;

    const requestedIds = selectLayerIds(orderedIds, [...sceneOrganizationSelection].filter(id => available.has(id)), id, options, options.anchorId);
    replaceSceneOrganizationSelection(requestedIds);
  }

  function toggleSceneOrganizationObject(id: string) {
    selectSceneOrganizationObject(id, { additive: true });
  }

  function setSceneObjectsVisible(ids: string[], visible: boolean) {
    if (!engine) return;
    // 批 2 收编:批量显隐逐对象发命令(setter 序列与直调一致,同步冲刷无合帧差异)。
    for (const id of ids) dispatchEngineEditCommand(engine, layerVisibilityCommand(locale, { modelId: id }, visible));
    setMessage(tr(locale, `${visible ? "显示" : "隐藏"}了 ${ids.length} 个场景对象`, `${visible ? "Showed" : "Hid"} ${ids.length} scene objects`));
    commitOrganizationChange(visible ? "显示场景对象" : "隐藏场景对象");
  }

  function setSceneObjectsLocked(ids: string[], locked: boolean) {
    if (!engine) return;
    // 批 2 收编:批量锁定逐对象发命令。
    for (const id of ids) dispatchEngineEditCommand(engine, layerLockCommand(locale, { modelId: id }, locked));
    setMessage(tr(locale, `${locked ? "锁定" : "解锁"}了 ${ids.length} 个场景对象`, `${locked ? "Locked" : "Unlocked"} ${ids.length} scene objects`));
    commitOrganizationChange(locked ? "锁定场景对象" : "解锁场景对象");
  }

  function isolateSceneObjects(ids: string[]) {
    engine?.isolateModels(ids);
    setMessage(tr(locale, `已隔离 ${ids.length} 个场景对象`, `Isolated ${ids.length} scene objects`));
    commitOrganizationChange("隔离场景对象");
  }

  function restoreSceneObjectIsolation() {
    engine?.clearIsolation();
    setMessage(tr(locale, "已恢复隔离前的可见状态", "Restored visibility from before isolation"));
    commitOrganizationChange("恢复场景对象可见性");
  }

  function createSelectionState(name: string, kind?: SceneSelectionSetState["kind"]): SceneSelectionSetState | undefined {
    const objectIds = selectedObjectIds();
    if (!objectIds.length) return;
    return {
      id: crypto.randomUUID(),
      name:
        name || tr(locale, `${kind === "group" ? "编组" : "选择集"} ${selectionSets.length + 1}`, `${kind === "group" ? "Group" : "Selection set"} ${selectionSets.length + 1}`),
      objectIds,
      ...(kind ? { kind } : {}),
    };
  }

  function createSceneSelectionSet(name: string) {
    const next = createSelectionState(name);
    if (!next) return;
    setSelectionSets((items) => [...items, next]);
    setMessage(tr(locale, `已保存选择集“${next.name}”`, `Saved selection set “${next.name}”`));
    commitOrganizationChange(`保存选择集“${next.name}”`);
  }

  function createSceneGroup(name: string, ids?: string[]) {
    const next = createSelectionState(name, "group");
    const objectIds = (ids ?? next?.objectIds ?? []).filter(id => sceneOrganizationObjects.some(item => item.id === id && !item.locked));
    if (!next || objectIds.length < 2) return;
    next.objectIds = objectIds;
    setSelectionSets((items) => [
      ...items.map((item) => item.kind === "group" ? { ...item, objectIds: item.objectIds.filter((id) => !next.objectIds.includes(id)) } : item),
      next,
    ]);
    setMessage(
      tr(
        locale,
        `已创建编组“${next.name}”，可统一变换、外观、特效、显隐和锁定`,
        `Created group “${next.name}”; transforms, appearance, effects, visibility and locking are now unified`,
      ),
    );
    commitOrganizationChange(`创建编组“${next.name}”`);
  }

  function moveSceneObjectsToGroup(ids: string[], groupId?: string, beforeObjectId?: string, position: "before" | "after" = "before") {
    const requested = new Set(ids);
    if (sceneOrganizationObjects.some(item => requested.has(item.id) && item.locked)) return;
    if (beforeObjectId && sceneOrganizationObjects.some(item => item.id === beforeObjectId && item.locked)) return;
    const destination = groupId ? selectionSets.find(item => item.kind === "group" && item.id === groupId) : undefined;
    if (destination && destination.objectIds.some(id => sceneOrganizationObjects.some(item => item.id === id && item.locked))) return;
    if (beforeObjectId && (groupId ? !destination?.objectIds.includes(beforeObjectId)
      : selectionSets.some(item => item.kind === "group" && item.objectIds.includes(beforeObjectId)))) return;
    const ordered = visibleLayerIds(sceneOrganizationObjects.filter(item => item.kind === "model").map(item => item.id)
      .concat(sceneOrganizationObjects.filter(item => item.kind !== "model").map(item => item.id)),
    selectionSets.filter(group => group.kind === "group"), new Set(), context.rootLayerOrder);
    const moving = ordered.filter(id => requested.has(id) && sceneOrganizationObjects.some(item => item.id === id && !item.locked));
    if (groupId && !selectionSets.some(item => item.kind === "group" && item.id === groupId)) return;
    if (!moving.length) return;
    if (beforeObjectId && moving.includes(beforeObjectId)) return;
    if (beforeObjectId && !sceneOrganizationObjects.some(item => item.id === beforeObjectId)) return;
    const nextGroups = selectionSets.map((item) => {
      if (item.kind !== "group") return item;
      const remaining = item.objectIds.filter(id => !moving.includes(id));
      if (item.id !== groupId) return { ...item, objectIds: remaining };
      const targetIndex = beforeObjectId ? remaining.indexOf(beforeObjectId) : -1;
      const index = targetIndex < 0 ? remaining.length : targetIndex + (position === "after" ? 1 : 0);
      return { ...item, objectIds: [...remaining.slice(0, index), ...moving, ...remaining.slice(index)] };
    });
    if (!groupId && context.setRootLayerOrder) {
      const available = rootReferences(nextGroups);
      const normalized = normalizeSceneRootLayerOrder(context.rootLayerOrder, available);
      const current = [...normalized.filter(ref => ref.kind !== "object" || !moving.includes(ref.id)),
        ...moving.map(id => ({ kind: "object" as const, id }))];
      const targetIndex = beforeObjectId ? current.findIndex(ref => ref.kind === "object" && ref.id === beforeObjectId) : -1;
      const before = targetIndex < 0 ? undefined : current[targetIndex + (position === "after" ? 1 : 0)];
      context.setRootLayerOrder(moveSceneRootLayers(current, available, moving.map(id => ({ kind: "object", id })), before));
    }
    setSelectionSets(nextGroups);
    setMessage(groupId
      ? tr(locale, `已移动 ${moving.length} 个对象到编组`, `Moved ${moving.length} objects into the group`)
      : beforeObjectId
        ? tr(locale, `已调整 ${moving.length} 个对象的目录顺序`, `Reordered ${moving.length} objects`)
        : tr(locale, `已将 ${moving.length} 个对象移出编组`, `Moved ${moving.length} objects out of groups`));
    commitOrganizationChange(groupId ? "移动对象到编组" : beforeObjectId ? "调整场景对象顺序" : "将对象移出编组");
  }

  function reorderSceneGroup(id: string, beforeId?: string) {
    if (hasLockedGroupMember(id)) return;
    context.setRootLayerOrder?.(moveSceneRootLayers(context.rootLayerOrder, rootReferences(selectionSets), [{ kind: "group", id }], beforeId ? { kind: "group", id: beforeId } : undefined));
    setSelectionSets((items) => {
      const source = items.find((item) => item.id === id && item.kind === "group");
      if (!source) return items;
      const remaining = items.filter((item) => item.id !== id);
      const beforeIndex = beforeId ? remaining.findIndex((item) => item.id === beforeId) : -1;
      return beforeIndex < 0
        ? [...remaining, source]
        : [...remaining.slice(0, beforeIndex), source, ...remaining.slice(beforeIndex)];
    });
    commitOrganizationChange("调整场景编组顺序");
  }

  function renameSceneGroup(id: string, name: string) {
    const nextName = name.trim();
    if (!nextName) return;
    setSelectionSets((items) => items.map((item) => item.id === id && item.kind === "group" ? { ...item, name: nextName } : item));
    commitOrganizationChange(`重命名编组为“${nextName}”`);
  }

  function updateSceneSelectionSet(id: string) {
    if (hasLockedGroupMember(id)) return;
    const objectIds = selectedObjectIds();
    if (!objectIds.length) return;
    const current = selectionSets.find((item) => item.id === id);
    setSelectionSets((items) => items.map((item) => (item.id === id ? { ...item, objectIds } : item)));
    if (current) setMessage(tr(locale, `已更新选择集“${current.name}”`, `Updated selection set “${current.name}”`));
    if (current) commitOrganizationChange(`更新选择集“${current.name}”`);
  }

  function applySceneSelectionSet(id: string) {
    const current = selectionSets.find((item) => item.id === id);
    if (!current) return;
    replaceSceneOrganizationSelection(current.objectIds);
    const available = current.objectIds.filter((objectId) => sceneOrganizationObjects.some((item) => item.id === objectId)).length;
    setMessage(tr(locale, `已载入“${current.name}”，选择 ${available} 个对象`, `Loaded “${current.name}” with ${available} objects`));
  }

  function deleteSceneSelectionSet(id: string) {
    if (hasLockedGroupMember(id)) return;
    const current = selectionSets.find((item) => item.id === id);
    if (current) setLastDeletedSelectionSet(current);
    setSelectionSets((items) => items.filter((item) => item.id !== id));
    if (current) setMessage(tr(locale, `已删除选择集“${current.name}”`, `Deleted selection set “${current.name}”`));
    if (current) commitOrganizationChange(`删除选择集“${current.name}”`);
  }

  function restoreDeletedSceneSelectionSet() {
    if (!lastDeletedSelectionSet) return;
    setSelectionSets((items) => [...items, lastDeletedSelectionSet]);
    setMessage(tr(locale, `已恢复选择集“${lastDeletedSelectionSet.name}”`, `Restored selection set “${lastDeletedSelectionSet.name}”`));
    setLastDeletedSelectionSet(undefined);
    commitOrganizationChange(`恢复选择集“${lastDeletedSelectionSet.name}”`);
  }

  function selectedObjectIds(): string[] {
    return sceneOrganizationObjects.filter((item) => sceneOrganizationSelection.has(item.id)).map((item) => item.id);
  }

  function rootReferences(groups: readonly SceneSelectionSetState[]): SceneRootLayerRef[] {
    const actualGroups = groups.filter(group => group.kind === "group");
    const grouped = new Set(actualGroups.flatMap(group => group.objectIds));
    const objects = sceneOrganizationObjects.filter(item => !grouped.has(item.id));
    // 与旧目录一致：模型实例先于基础元素；新增字段只改变作者目录。
    const refs: SceneRootLayerRef[] = [...actualGroups.map(group => ({ kind: "group" as const, id: group.id })),
      ...objects.filter(item => item.kind === "model").map(item => ({ kind: "object" as const, id: item.id })),
      ...objects.filter(item => item.kind !== "model").map(item => ({ kind: "object" as const, id: item.id }))];
    return [...refs, ...(context.rootLayerOrder ?? []).filter(ref => ref.kind !== "object" && ref.kind !== "group")];
  }

  function hasLockedGroupMember(id: string): boolean {
    const group = selectionSets.find(item => item.id === id && item.kind === "group");
    if (!group?.objectIds.some(objectId => sceneOrganizationObjects.some(item => item.id === objectId && item.locked))) return false;
    setMessage(tr(locale, "编组包含锁定对象，请先解锁", "Unlock the group members before changing its structure"));
    return true;
  }

  function discrete<Args extends unknown[]>(action: (...args: Args) => void): (...args: Args) => void {
    return (...args) => context.runSceneEdit ? context.runSceneEdit(() => action(...args)) : action(...args);
  }

  return {
    replaceSceneOrganizationSelection,
    selectSceneOrganizationObject,
    toggleSceneOrganizationObject,
    setSceneObjectsVisible: discrete(setSceneObjectsVisible),
    setSceneObjectsLocked: discrete(setSceneObjectsLocked),
    isolateSceneObjects: discrete(isolateSceneObjects),
    restoreSceneObjectIsolation: discrete(restoreSceneObjectIsolation),
    createSceneSelectionSet: discrete(createSceneSelectionSet),
    createSceneGroup: discrete(createSceneGroup),
    moveSceneObjectsToGroup: discrete(moveSceneObjectsToGroup),
    moveSceneRootEntries: discrete(createSceneRootEntryMover(context, commitOrganizationChange)),
    reorderSceneGroup: discrete(reorderSceneGroup),
    renameSceneGroup: discrete(renameSceneGroup),
    updateSceneSelectionSet: discrete(updateSceneSelectionSet),
    applySceneSelectionSet,
    deleteSceneSelectionSet: discrete(deleteSceneSelectionSet),
    restoreDeletedSceneSelectionSet: discrete(restoreDeletedSceneSelectionSet),
  };
}
