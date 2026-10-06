import { useEffect } from "react";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { selectionDeleteCommand } from "../commands/engineEditCommand";
import { translate as tr } from "../i18n";
import { useSceneModelInstances } from "../hooks/useSceneModelInstances";
import type { AppStudioController } from "./AppStudioShell";

/**
 * AppStudioShellView 场景选中对象的 Delete/Backspace 删除快捷路径(studio 视图
 * 专属;图层行/输入控件/对话框命中时不拦截)。副作用自视图原文机械迁出,
 * 语句、守卫顺序与依赖数组逐一保留。
 */
export function useSceneSelectionDeleteShortcut(controller: AppStudioController,
  instances: ReturnType<typeof useSceneModelInstances>): void {
  const { route, selected, selectedLayerId, selectedAnnotationId, selectionLocked, selectionName,
    sceneOrganizationSelection, sceneOrganizationObjects, engine, deleteAnnotation, deletePrimitive,
    removeObjectInteractions, setMessage, setRevision, locale } = controller;
  useEffect(() => {
    if (route.view !== "studio") return;
    const removeSelection = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[data-layer-keyboard-row]')) return;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector('[role="dialog"], [data-escape-dialog]')) return;
      if (selectedLayerId && selectedLayerId !== "root" && selected) {
        if (selectionLocked) { setMessage(tr(locale, "请先解锁当前图层", "Unlock the selected layer first")); return; }
        event.preventDefault();
        dispatchEngineEditCommand(engine, selectionDeleteCommand(locale, { modelId: selected.id }));
        removeObjectInteractions(selected.id, selectedLayerId);
        setRevision((value) => value + 1);
        setMessage(tr(locale, `图层“${selectionName || selectedLayerId}”已从场景删除`, `Layer “${selectionName || selectedLayerId}” was removed from the scene`));
        return;
      }
      const ids = sceneOrganizationSelection.size > 0 ? sceneOrganizationSelection : new Set(selected ? [selected.id] : []);
      const targets = sceneOrganizationObjects.filter((item) => ids.has(item.id));
      if (targets.length === 0) {
        if (selectedAnnotationId) { event.preventDefault(); deleteAnnotation(selectedAnnotationId); }
        return;
      }
      const removable = targets.filter((item) => !item.locked);
      if (removable.length === 0) { setMessage(tr(locale, "所选对象已锁定，请先解锁", "The selection is locked; unlock it first")); return; }
      event.preventDefault();
      for (const item of removable) {
        if (item.kind === "primitive") deletePrimitive(item.id);
        else instances.remove(item.id);
      }
      if (removable.length > 1) setMessage(tr(locale, `已从场景移除 ${removable.length} 个对象`, `Removed ${removable.length} objects from the scene`));
    };
    window.addEventListener("keydown", removeSelection);
    return () => window.removeEventListener("keydown", removeSelection);
  }, [route.view, selected, selectedLayerId, selectedAnnotationId, selectionLocked, selectionName, sceneOrganizationSelection, sceneOrganizationObjects, engine, instances, deleteAnnotation, deletePrimitive, removeObjectInteractions, setMessage, setRevision, locale]);
}
