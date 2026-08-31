import type { SceneSelectionSetState } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

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
  } = context;

  function replaceSceneOrganizationSelection(ids: string[]) {
    const available = new Set(sceneOrganizationObjects.map((item) => item.id));
    setSceneOrganizationSelection(new Set(ids.filter((id) => available.has(id))));
  }

  function toggleSceneOrganizationObject(id: string) {
    setSceneOrganizationSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setSceneObjectsVisible(ids: string[], visible: boolean) {
    if (!engine) return;
    for (const id of ids) engine.setVisible(id, visible);
    setMessage(tr(locale, `${visible ? "显示" : "隐藏"}了 ${ids.length} 个场景对象`, `${visible ? "Showed" : "Hid"} ${ids.length} scene objects`));
    setRevision((value) => value + 1);
  }

  function setSceneObjectsLocked(ids: string[], locked: boolean) {
    if (!engine) return;
    for (const id of ids) engine.setModelLocked(id, locked);
    setMessage(tr(locale, `${locked ? "锁定" : "解锁"}了 ${ids.length} 个场景对象`, `${locked ? "Locked" : "Unlocked"} ${ids.length} scene objects`));
    setRevision((value) => value + 1);
  }

  function isolateSceneObjects(ids: string[]) {
    engine?.isolateModels(ids);
    setMessage(tr(locale, `已隔离 ${ids.length} 个场景对象`, `Isolated ${ids.length} scene objects`));
    setRevision((value) => value + 1);
  }

  function restoreSceneObjectIsolation() {
    engine?.clearIsolation();
    setMessage(tr(locale, "已恢复隔离前的可见状态", "Restored visibility from before isolation"));
    setRevision((value) => value + 1);
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
  }

  function createSceneGroup(name: string) {
    const next = createSelectionState(name, "group");
    if (!next) return;
    setSelectionSets((items) => [...items, next]);
    setMessage(
      tr(
        locale,
        `已创建编组“${next.name}”，可统一变换、外观、特效、显隐和锁定`,
        `Created group “${next.name}”; transforms, appearance, effects, visibility and locking are now unified`,
      ),
    );
  }

  function updateSceneSelectionSet(id: string) {
    const objectIds = selectedObjectIds();
    if (!objectIds.length) return;
    const current = selectionSets.find((item) => item.id === id);
    setSelectionSets((items) => items.map((item) => (item.id === id ? { ...item, objectIds } : item)));
    if (current) setMessage(tr(locale, `已更新选择集“${current.name}”`, `Updated selection set “${current.name}”`));
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
  }

  function restoreDeletedSceneSelectionSet() {
    if (!lastDeletedSelectionSet) return;
    setSelectionSets((items) => [...items, lastDeletedSelectionSet]);
    setMessage(tr(locale, `已恢复选择集“${lastDeletedSelectionSet.name}”`, `Restored selection set “${lastDeletedSelectionSet.name}”`));
    setLastDeletedSelectionSet(undefined);
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
    updateSceneSelectionSet,
    applySceneSelectionSet,
    deleteSceneSelectionSet,
    restoreDeletedSceneSelectionSet,
  };
}
