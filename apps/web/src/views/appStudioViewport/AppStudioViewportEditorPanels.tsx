import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import type { AppStudioController } from "../AppStudioShell";
import { normalizeDashboardState } from "../../components/dashboardState";
import { translate as tr } from "../../i18n";
import { AiAssistantPanel } from "../../components/AiAssistantPanel";
import { SceneClippingPanel } from "../../components/SceneClippingPanel";
import { CameraNavigationPanel } from "../../components/CameraNavigationPanel";
import { SceneTimelinePanel } from "../../components/SceneTimelinePanel";
import { DEFAULT_NAVIGATION_SETTINGS } from "../../navigationSettings";
import { sceneViewerDeliveryToolbarVisible } from "../../delivery/sceneViewerDelivery";
import type { AppStudioSimulationDockState } from "./useAppStudioSimulationDock";
import type { useSceneEditPort } from "../../hooks/useSceneEditPort";

const SceneSimulationPanel = lazy(() => import("../../components/SceneSimulationPanel").then((module) => ({ default: module.SceneSimulationPanel })));

/**
 * AppStudioViewport 编辑器面板接线(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出,JSX 逐行同源,仅包一层组件;语义零变化)。
 *
 * 职责:AI 助手 / 剖切 / 时间线+相机导航 / DES 轨迹状态条 / 仿真插件面板
 * (lazy)的开态条件渲染与 props 接线。发布工具条可见性与拆分前同一表达式。
 */
export function AppStudioViewportEditorPanels({ controller, simulation, sceneEditPort }: {
  controller: AppStudioController;
  simulation: AppStudioSimulationDockState;
  sceneEditPort: ReturnType<typeof useSceneEditPort>;
}) {
  const {
    activeScene,
    addCameraKeyframe,
    addCameraView,
    addModelKeyframe,
    aiAssistantOpen,
    animationOpen,
    animationPlaying,
    animationTime,
    avatarVisible,
    cameraConstraints,
    cameraViews,
    changeCameraConstraints,
    changeClippingMode,
    changeNavigation,
    changeNavigationSettings,
    clipping,
    clippingRange,
    clippingSceneBounds,
    defaultCameraViewId,
    deleteKeyframe,
    engine,
    loadedModelNames,
    loadedModels,
    locale,
    navigationDiagnostics,
    navigationMode,
    navigationSettings,
    project,
    removeCameraView,
    replaceCameraView,
    reverseSceneAnimation,
    route,
    sceneAnimation,
    sceneDashboard,
    sceneInteractions,
    sceneName,
    selected,
    selectionLocked,
    selectionName,
    setAiAssistantOpen,
    setAnimationOpen,
    setAvatarVisible,
    setDefaultCameraViewId,
    setSceneDashboard,
    setMessage,
    setRevision,
    toggleClipping,
    toggleSceneAnimation,
    updateCameraViewName,
    updateClipping,
    updateClippingBox,
    updateSceneAnimation,
  } = controller;
  const deliveryToolbarVisible = sceneViewerDeliveryToolbarVisible();
  const viewerToolbarVisible = deliveryToolbarVisible ?? (route.view === "view" || activeScene?.publicationToolbarVisible !== false);
  const viewerRouteHasToolbar = (route.view === "view" || route.view === "published") && viewerToolbarVisible;
  return (
    <>
      {route.view === "studio" && aiAssistantOpen && (
        <AiAssistantPanel
          locale={locale}
          projectId={project?.id}
          surface="studio"
          {...(sceneEditPort ? { sceneEdit: sceneEditPort } : {})}
          context={{
            project: project ? { id: project.id, name: project.name } : undefined,
            scene: { id: activeScene?.id, name: sceneName, modelCount: activeScene?.models.length ?? 0 },
            selected: selected ? { id: selected.id, name: selected.name, kind: selected.kind } : undefined,
            dashboard: sceneDashboard,
            ...(sceneInteractions.length === 1
              ? { script: { id: sceneInteractions[0]!.id, name: sceneInteractions[0]!.name, language: "typescript" } }
              : {}),
          }}
          onPrepareBimContext={async (question) => {
            if (!engine) throw new Error(tr(locale, "三维场景尚未就绪", "The 3D scene is not ready"));
            return engine.prepareBimAssistantContext(question);
          }}
          onBimAction={(action, prepared, componentId) => {
            const applied = engine?.applyBimAssistantAction(action, prepared, componentId);
            setMessage(
              applied ? tr(locale, "已执行 BIM 问答操作", "BIM assistant action applied") : tr(locale, "当前证据不足，无法执行该操作", "Insufficient evidence for this action"),
            );
            setRevision((value) => value + 1);
          }}
          onApplyDashboard={(dashboard) => {
            setSceneDashboard(normalizeDashboardState({ ...dashboard, enabled: true }));
            setMessage("AI 看板方案已写入二维设计，保存场景后可在二维工作区继续编辑");
          }}
          onClose={() => setAiAssistantOpen(false)}
        />
      )}
      {(route.view === "studio" || viewerRouteHasToolbar) && clipping.enabled && (
        <SceneClippingPanel
          locale={locale}
          value={clipping}
          axisRange={clippingRange}
          sceneBounds={clippingSceneBounds}
          onModeChange={changeClippingMode}
          onChange={updateClipping}
          onBoxChange={updateClippingBox}
          onResetBounds={() => {
            if (engine) updateClipping({ box: engine.getClippingBounds(), showHelper: true });
          }}
          onClose={toggleClipping}
        />
      )}
      {animationOpen && (
        <SceneTimelinePanel
          engine={engine}
          {...(simulation.simulationTrack && simulation.activeSimulationStudy ? { simulationStudy: simulation.activeSimulationStudy, onSimulationFrame: simulation.setSimulationFrame } : {})}
          onAnimationTrack={() => simulation.setSimulationTrack(false)}
          workspace={simulation.directorWorkspace}
          onWorkspaceChange={(workspace) => {
            if (workspace !== "timeline") simulation.setSimulationTrack(false);
            simulation.setDirectorWorkspace(workspace);
          }}
          cameraWorkspace={<CameraNavigationPanel
            embedded
            section={simulation.directorWorkspace === "shots" ? "views" : "walk"}
            locale={locale}
            mode={navigationMode}
            modelCount={loadedModels.filter((item) => item.visible).length}
            avatarVisible={avatarVisible}
            constraints={cameraConstraints}
            navigation={navigationSettings}
            diagnostics={navigationDiagnostics}
            views={cameraViews}
            defaultViewId={defaultCameraViewId}
            onClose={() => setAnimationOpen(false)}
            onModeChange={changeNavigation}
            onAvatarVisibleChange={(visible) => {
              setAvatarVisible(visible);
              engine?.setAvatarVisible(visible);
            }}
            onConstraintsChange={changeCameraConstraints}
            onNavigationChange={changeNavigationSettings}
            onDebugVisibleChange={(visible) => engine?.setNavigationCollisionDebugVisible(visible)}
            onResetNavigation={() => changeNavigationSettings(DEFAULT_NAVIGATION_SETTINGS)}
            onAddView={addCameraView}
            onApplyView={(view) => engine?.applyCamera(view.camera)}
            onRenameView={updateCameraViewName}
            onReplaceView={replaceCameraView}
            onRemoveView={removeCameraView}
            onDefaultViewChange={setDefaultCameraViewId}
          />}
          locale={locale}
          animation={sceneAnimation}
          currentTime={animationTime}
          playing={animationPlaying}
          selectedObjectName={selected ? selectionName || selected.name : undefined}
          selectedObjectLocked={selectionLocked}
          modelNames={loadedModelNames}
          onClose={() => setAnimationOpen(false)}
          onPlayPause={toggleSceneAnimation}
          onReversePlay={reverseSceneAnimation}
          onSeek={(time) => engine?.seekSceneAnimation(time)}
          onChange={updateSceneAnimation}
          onRecordCamera={addCameraKeyframe}
          onRecordObject={addModelKeyframe}
          onDeleteFrame={deleteKeyframe}
        />
      )}
      {animationOpen && simulation.simulationTrack && simulation.activeSimulationStudy && simulation.simulationFrame && <div className="scene-simulation-live-status" role="status">DES 轨迹样本 · {simulation.simulationFrame.atMinute.toFixed(1)} 分钟<br />在制 {simulation.simulationFrame.activeItems} · 完成 {simulation.simulationFrame.completedItems} · 仅覆盖显示</div>}
      {route.view === "studio" && simulation.simulationPanelId && project && (
        <Suspense fallback={<div className="scene-simulation-loading"><LoaderCircle className="spin" size={18} />{tr(locale, "正在加载仿真插件", "Loading simulation plugin")}</div>}>
          <SceneSimulationPanel
            locale={locale}
            panelId={simulation.simulationPanelId}
            project={project}
            scenes={controller.scenes}
            {...(activeScene ? { activeScene } : {})}
            {...(selected ? { selectedObjectId: selected.id, selectedObjectName: selectionName || selected.name } : {})}
            sceneFlow={{ objects: loadedModels, resolvePosition: simulation.resolveSimulationPosition, onEntitiesChange: controller.bindings.scenePersistence.replaceSimulationEntities, onStudy: simulation.showSimulationStudy }}
            onPanelChange={simulation.setSimulationPanelId}
            onDockChange={simulation.setSimulationDock}
            onOpenEvidence={() => controller.navigate({ view: "operations", operationsTab: simulation.simulationPanelId === "whatif" ? "whatif" : simulation.simulationPanelId === "logistics" ? "logistics" : "commissioning" })}
            onOpenDataCenter={() => controller.navigate({ view: "data" })}
            onOpenSceneTarget={simulation.openSimulationTarget}
            onClose={() => { simulation.setSimulationPanelId(undefined); if (simulation.simulationTrack) setAnimationOpen(false); simulation.setSimulationTrack(false); simulation.setSimulationFrame(null); }}
          />
        </Suspense>
      )}
    </>
  );
}
