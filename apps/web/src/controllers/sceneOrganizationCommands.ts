import type { SceneSelectionSetState } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";
import { synchronizeSelectionFromOutliner } from "./sceneSelectionSynchronization";

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
    synchronizeSelectionFromOutliner(ids, available, {
      selectPrimaryInViewer: (id) => engine?.select(id),
      replaceObjectSelection: (next) => setSceneOrganizationSelection(next),
    });
  }

  function toggleSceneOrganizationObject(id: string) {
    const next = new Set(sceneOrganizationSelection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const available = new Set(sceneOrganizationObjects.map((item) => item.id));
    synchronizeSelectionFromOutliner([...next], available, {
      selectPrimaryInViewer: (primaryId) => engine?.select(primaryId),
      replaceObjectSelection: (ids) => setSceneOrganizationSelection(ids),
    });
  }

  function setSceneObjectsVisible(ids: string[], visible: boolean) {
    if (!engine) return;
    for (const id of ids) engine.setVisible(id, visible);
    setMessage(tr(locale, `${visible ? "显示" : "隐藏"}了 ${ids.length} 个场景对象`, `${visible ? "Showed" : "Hid"} ${ids.length} scene objects`));
    commitOrganizationChange(visible ? "显示场景对象" : "隐藏场景对象");
  }

  function setSceneObjectsLocked(ids: string[], locked: boolean) {
    if (!engine) return;
    for (const id of ids) engine.setModelLocked(id, locked);
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

  function createSceneGroup(name: string) {
    const next = createSelectionState(name, "group");
    if (!next) return;
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

  function moveSceneObjectsToGroup(ids: string[], groupId?: string, beforeObjectId?: string) {
    const moving = [...new Set(ids)].filter((id) => sceneOrganizationObjects.some((item) => item.id === id));
    if (!moving.length) return;
    setSelectionSets((items) => items.map((item) => {
      if (item.kind !== "group") return item;
      const remaining = item.objectIds.filter((id) => !moving.includes(id));
      if (item.id !== groupId) return { ...item, objectIds: remaining };
      const beforeIndex = beforeObjectId ? remaining.indexOf(beforeObjectId) : -1;
      const objectIds = beforeIndex < 0
        ? [...remaining, ...moving]
        : [...remaining.slice(0, beforeIndex), ...moving, ...remaining.slice(beforeIndex)];
      return { ...item, objectIds };
    }));
    setMessage(groupId
      ? tr(locale, `已移动 ${moving.length} 个对象到编组`, `Moved ${moving.length} objects into the group`)
      : tr(locale, `已将 ${moving.length} 个对象移出编组`, `Moved ${moving.length} objects out of groups`));
    commitOrganizationChange(groupId ? "移动对象到编组" : "将对象移出编组");
  }

  function reorderSceneGroup(id: string, beforeId?: string) {
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

  return {
    replaceSceneOrganizationSelection,
    toggleSceneOrganizationObject,
    setSceneObjectsVisible,
    setSceneObjectsLocked,
    isolateSceneObjects,
    restoreSceneObjectIsolation,
    createSceneSelectionSet,
    createSceneGroup,
    moveSceneObjectsToGroup,
    reorderSceneGroup,
    renameSceneGroup,
    updateSceneSelectionSet,
    applySceneSelectionSet,
    deleteSceneSelectionSet,
    restoreDeletedSceneSelectionSet,
  };
}
