import { getSceneModelAssetId } from "@bim-studio/contracts";
import type { AppStudioController } from "../AppStudioShell";
import { dispatchEngineEditCommand } from "../../commands/engineCommandApplier";
import { layerVisibilityCommand } from "../../commands/engineEditCommand";
import { sceneViewerDeliveryToolbarVisible } from "../../delivery/sceneViewerDelivery";
import { PublishedViewerObjectPanel } from "../../components/PublishedViewerObjectPanel";
import { PublishedModelCredits } from "../../delivery/PublishedModelCredits";
import type { AppStudioViewportToggles } from "./useAppStudioViewportToggles";

/**
 * AppStudioViewport 发布视口面板接线(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出,JSX 逐行同源,仅包一层组件;语义零变化)。
 *
 * 职责:发布视口对象面板(显隐/隔离/恢复)与模型署名的条件渲染与接线;
 * 显隐走命令总线(engine 为空时 dispatch 静默跳过)。
 */
export function AppStudioViewportViewerPanels({ controller, toggles }: {
  controller: AppStudioController;
  toggles: Pick<AppStudioViewportToggles, "viewerObjectPanelOpen" | "setViewerObjectPanelOpen">;
}) {
  const {
    activeScene,
    engine,
    loadedModels,
    locale,
    project,
    route,
    selected,
    selectionProperties,
    setRevision,
  } = controller;
  const deliveryToolbarVisible = sceneViewerDeliveryToolbarVisible();
  const viewerToolbarVisible = deliveryToolbarVisible ?? (route.view === "view" || activeScene?.publicationToolbarVisible !== false);
  const viewerRouteHasToolbar = (route.view === "view" || route.view === "published") && viewerToolbarVisible;
  return (
    <>
      {viewerRouteHasToolbar && toggles.viewerObjectPanelOpen && (
        <PublishedViewerObjectPanel
          locale={locale}
          models={loadedModels}
          selected={selected}
          properties={selectionProperties}
          isolationActive={engine?.isIsolationActive() ?? false}
          onSelect={(id) => engine?.select(id)}
          onFocus={(id) => engine?.focusModel(id)}
          onVisibilityChange={(id, visible) => {
            // 批 2 收编:发布视口对象面板显隐走命令总线(engine 为空时 dispatch 静默跳过)。
            dispatchEngineEditCommand(engine, layerVisibilityCommand(locale, { modelId: id }, visible));
            setRevision((value) => value + 1);
          }}
          onIsolate={(id) => {
            engine?.isolateModels([id]);
            setRevision((value) => value + 1);
          }}
          onRestoreIsolation={() => {
            engine?.clearIsolation();
            setRevision((value) => value + 1);
          }}
          onShowAll={() => {
            // 批 2 收编:全部显示逐模型发命令。
            for (const model of loadedModels) dispatchEngineEditCommand(engine, layerVisibilityCommand(locale, { modelId: model.id }, true));
            engine?.clearIsolation();
            setRevision((value) => value + 1);
          }}
          onClose={() => toggles.setViewerObjectPanelOpen(false)}
        />
      )}
      {(route.view === "view" || route.view === "published") && project && <PublishedModelCredits locale={locale} models={project.models} modelIds={activeScene?.models.map(getSceneModelAssetId) ?? []} />}
    </>
  );
}
