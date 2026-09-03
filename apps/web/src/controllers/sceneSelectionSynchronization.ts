import type { LoadedSceneModel } from "../viewer/ViewerEngine";

interface ViewportSelectionCallbacks {
  setSelectedModel: (model: LoadedSceneModel | undefined) => void;
  replaceObjectSelection: (ids: Set<string>) => void;
  clearSelectedSpace: () => void;
  requestRender: () => void;
}

/**
 * 视口拾取是新的选择意图：单击对象替换目录多选，点击空白则同时清空。
 * 组件拾取仍以所属模型作为目录主对象，详细构件由 ViewerEngine 自身保留。
 */
export function synchronizeSelectionFromViewport(
  model: LoadedSceneModel | undefined,
  callbacks: ViewportSelectionCallbacks,
): void {
  callbacks.setSelectedModel(model);
  callbacks.replaceObjectSelection(new Set(model ? [model.id] : []));
  callbacks.clearSelectedSpace();
  callbacks.requestRender();
}

interface OutlinerSelectionCallbacks {
  selectPrimaryInViewer: (id: string | undefined) => void;
  replaceObjectSelection: (ids: Set<string>) => void;
}

/**
 * 目录是多选意图的来源。先让 ViewerEngine 切换主对象，再提交完整集合，
 * 这样同步触发的视口回调不会把 Ctrl/Command 多选压缩成单个主对象。
 */
export function synchronizeSelectionFromOutliner(
  requestedIds: readonly string[],
  availableIds: ReadonlySet<string>,
  callbacks: OutlinerSelectionCallbacks,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of requestedIds) {
    if (!availableIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  callbacks.selectPrimaryInViewer(ids.at(-1));
  callbacks.replaceObjectSelection(new Set(ids));
  return ids;
}
