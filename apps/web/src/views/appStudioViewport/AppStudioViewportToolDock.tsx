import type { AppStudioController } from "../AppStudioShell";
import { translate as tr } from "../../i18n";
import { PublishedViewerToolDock } from "../../components/PublishedViewerToolDock";
import { SceneToolDock } from "../../components/SceneToolDock";
import { sceneViewerDeliveryToolbarVisible } from "../../delivery/sceneViewerDelivery";
import type { AppStudioViewportToggles } from "./useAppStudioViewportToggles";
import type { AppStudioPhysicsDebugState } from "./useAppStudioPhysicsDebugState";
import type { AppStudioSimulationDockState } from "./useAppStudioSimulationDock";

/**
 * AppStudioViewport 工具坞接线(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出,JSX 逐行同源,仅包一层组件;语义零变化)。
 *
 * 职责:发布视口工具坞(PublishedViewerToolDock)与 studio 工具坞(SceneToolDock)
 * 的路由二选一渲染与全部开关回调接线;全屏切换随坞迁入本组件(原函数逐行同源)。
 */
export function AppStudioViewportToolDock({ controller, toggles, physicsDebug, simulation, viewerExplosionActive, onToggleViewerExplosion, xrUnavailableReason }: {
  controller: AppStudioController;
  toggles: Pick<AppStudioViewportToggles, "viewerObjectPanelOpen" | "setViewerObjectPanelOpen" | "engineeringOpen" | "setEngineeringOpen" | "qualityPanelOpen" | "setQualityPanelOpen" | "profilerPanelOpen" | "setProfilerPanelOpen" | "devHudOpen" | "setDevHudOpen" | "experimentalPanelOpen" | "setExperimentalPanelOpen" | "bakeBenchOpen" | "setBakeBenchOpen">;
  physicsDebug: Pick<AppStudioPhysicsDebugState, "physicsDebugVisible">;
  simulation: Pick<AppStudioSimulationDockState, "simulationPanelId" | "toggleSimulationPanel" | "directorWorkspace" | "openDirector" | "setSimulationTrack">;
  viewerExplosionActive: boolean;
  onToggleViewerExplosion: () => void;
  xrUnavailableReason: string | undefined;
}) {
  const {
    activeScene,
    annotationEnabled,
    avatarVisible,
    beginPrimitivePlacement,
    changeNavigation,
    changeTransform,
    clipping,
    engine,
    environmentOpen,
    explosionFactor,
    infoEnabled,
    loadedModels,
    locale,
    measureEnabled,
    navigationMode,
    route,
    sceneBehaviorOpen,
    animationOpen,
    physicsOpen,
    playModeActive,
    selected,
    selectionScope,
    setAnimationOpen,
    setAvatarVisible,
    setDigitalTwinOpen,
    setEnvironmentOpen,
    setInfoEnabled,
    setMessage,
    setPhysicsOpen,
    setSceneBehaviorOpen,
    setSelectionScope,
    setViewerToolsOpen,
    setXrPanelOpen,
    startXR,
    toggleAnnotationPlacement,
    toggleClipping,
    toggleMeasurement,
    transformMode,
    updateExplosion,
    viewportRef,
    viewerToolsOpen,
    xrPanelOpen,
  } = controller;
  const deliveryToolbarVisible = sceneViewerDeliveryToolbarVisible();
  const viewerToolbarVisible = deliveryToolbarVisible ?? (route.view === "view" || activeScene?.publicationToolbarVisible !== false);
  const viewerRouteHasToolbar = (route.view === "view" || route.view === "published") && viewerToolbarVisible;

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewportRef.current?.parentElement?.requestFullscreen();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr(locale, "当前浏览器无法进入全屏", "Fullscreen is unavailable in this browser"));
    }
  }

  return viewerRouteHasToolbar ? (
        <PublishedViewerToolDock
          locale={locale}
          open={viewerToolsOpen}
          navigationMode={navigationMode}
          measureEnabled={measureEnabled}
          clippingEnabled={clipping.enabled}
          explosionActive={viewerExplosionActive}
          avatarVisible={avatarVisible}
          infoEnabled={infoEnabled}
          objectPanelOpen={toggles.viewerObjectPanelOpen}
          onOpenChange={setViewerToolsOpen}
          onFitAll={() => engine?.fitAll()}
          fitSelectedEnabled={Boolean(selected)}
          onFitSelected={() => {
            if (selected) engine?.focusModel(selected.id);
          }}
          onNavigationChange={changeNavigation}
          onMeasurementToggle={toggleMeasurement}
          onClippingToggle={toggleClipping}
          onExplosionToggle={onToggleViewerExplosion}
          onAvatarToggle={() => {
            const next = !avatarVisible;
            setAvatarVisible(next);
            engine?.setAvatarVisible(next);
          }}
          onInfoToggle={() => setInfoEnabled((value) => !value)}
          onObjectPanelOpenChange={toggles.setViewerObjectPanelOpen}
          onStandardView={(view) => engine?.setStandardView(view)}
          onFullscreen={() => void toggleFullscreen()}
          onStartXR={(mode) => void startXR(mode)}
          xrUnavailableReason={xrUnavailableReason}
        />
      ) : route.view === "studio" ? (
        <SceneToolDock
          locale={locale}
          navigationMode={navigationMode}
          transformMode={transformMode}
          editingDisabled={playModeActive}
          hasSelection={Boolean(selected)}
          hasModelSelection={selected?.kind === "model"}
          selectionScope={selectionScope}
          measureEnabled={measureEnabled}
          annotationEnabled={annotationEnabled}
          clippingEnabled={clipping.enabled}
          explosionActive={explosionFactor > 0}
          avatarVisible={avatarVisible}
          environmentOpen={environmentOpen}
          animationOpen={animationOpen}
          behaviorOpen={sceneBehaviorOpen}
          physicsOpen={physicsOpen}
          physicsDebugActive={physicsDebug.physicsDebugVisible}
          qualityPanelOpen={toggles.qualityPanelOpen}
          onQualityPanelToggle={() => toggles.setQualityPanelOpen(value => !value)}
          profilerPanelOpen={toggles.profilerPanelOpen}
          onProfilerPanelToggle={() => toggles.setProfilerPanelOpen(value => !value)}
          devHudOpen={toggles.devHudOpen}
          onDevHudToggle={() => toggles.setDevHudOpen(value => !value)}
          experimentalPanelOpen={toggles.experimentalPanelOpen}
          onExperimentalPanelToggle={() => toggles.setExperimentalPanelOpen(value => !value)}
          bakeBenchOpen={toggles.bakeBenchOpen}
          onBakeBenchToggle={() => toggles.setBakeBenchOpen(value => !value)}
          xrOpen={xrPanelOpen}
          simulationPanel={simulation.simulationPanelId}
          infoEnabled={infoEnabled}
          engineeringOpen={toggles.engineeringOpen}
          onFitAll={() => engine?.fitAll()}
          onSelect={() => changeNavigation("orbit")}
          onTransformChange={changeTransform}
          onSelectionScopeToggle={() => {
            const next = selectionScope === "model" ? "component" : "model";
            setSelectionScope(next);
            engine?.setSelectionScope(next);
            setMessage(next === "component" ? "构件选择已开启：画布点击可深入选择构件" : "模型选择已开启：画布点击只选择整个模型");
          }}
          onMeasurementToggle={toggleMeasurement}
          onPrimitivePlace={beginPrimitivePlacement}
          onAnnotationToggle={toggleAnnotationPlacement}
          onClippingToggle={toggleClipping}
          onExplosionToggle={() => updateExplosion(explosionFactor > 0 ? 0 : 0.55)}
          onNavigationChange={changeNavigation}
          onAvatarToggle={() => {
            const next = !avatarVisible;
            setAvatarVisible(next);
            engine?.setAvatarVisible(next);
          }}
          onInfoToggle={() => setInfoEnabled((value) => !value)}
          onEngineeringToggle={() => {
            toggles.setEngineeringOpen((value) => !value);
            setEnvironmentOpen(false);
            setPhysicsOpen(false);
          }}
          onEnvironmentToggle={() => {
            setEnvironmentOpen((value) => !value);
            setDigitalTwinOpen(false);
          }}
          onAnimationToggle={() => {
            simulation.setSimulationTrack(false);
            if (animationOpen && simulation.directorWorkspace === "timeline") setAnimationOpen(false);
            else simulation.openDirector("timeline");
          }}
          onBehaviorToggle={() => setSceneBehaviorOpen((value) => !value)}
          onPhysicsToggle={() => {
            setPhysicsOpen((value) => !value);
            setEnvironmentOpen(false);
          }}
          onXrToggle={() => setXrPanelOpen((value) => !value)}
          onSimulationPanelChange={simulation.toggleSimulationPanel}
        />
      ) : null;
}
