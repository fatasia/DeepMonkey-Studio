import { lazy, Suspense, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";
import { normalizeDashboardState } from "../components/dashboardState";
import { translate as tr } from "../i18n";
import { AiAssistantPanel } from "../components/AiAssistantPanel";
import { CameraNavigationPanel } from "../components/CameraNavigationPanel";
import { SceneClippingPanel } from "../components/SceneClippingPanel";
import { SceneEnvironmentPanel } from "../components/SceneEnvironmentPanel";
import { ScenePhysicsPanel } from "../components/ScenePhysicsPanel";
import { PublishedViewerToolDock } from "../components/PublishedViewerToolDock";
import { PublishedViewerObjectPanel } from "../components/PublishedViewerObjectPanel";
import { SceneTimelinePanel } from "../components/SceneTimelinePanel";
import { SceneToolDock } from "../components/SceneToolDock";
import { SceneViewportStatus } from "../components/SceneViewportStatus";
import { SceneXrPanel } from "../components/SceneXrPanel";
import { ViewControl } from "../components/AppFormControls";
import type { AppStudioController } from "./AppStudioShell";
import { sceneViewerDeliveryToolbarVisible } from "../delivery/sceneViewerDelivery";
import type { SceneSimulationPanelId } from "../simulation/sceneSimulationRegistry";
import { useSceneSimulationOverlay } from "../hooks/useSceneSimulationOverlay";

const SceneSimulationPanel = lazy(() => import("../components/SceneSimulationPanel").then((module) => ({ default: module.SceneSimulationPanel })));

export function AppStudioViewport({ controller }: { controller: AppStudioController }) {
  const {
    activeScene,
    addCameraKeyframe,
    addCameraView,
    addLight,
    addModelKeyframe,
    aiAssistantOpen,
    animationOpen,
    animationPlaying,
    animationTime,
    annotationEnabled,
    avatarVisible,
    beginPrimitivePlacement,
    branding,
    busy,
    cameraConstraints,
    cameraViews,
    cameraViewsOpen,
    changeCameraConstraints,
    changeClippingMode,
    changeLighting,
    changeMeasureMode,
    changeNavigation,
    changeNavigationSettings,
    changePhysics,
    changePostProcessing,
    changeSceneEnvironment,
    changeSelectedPhysics,
    changeTransform,
    changeWeather,
    clipping,
    clippingRange,
    clippingSceneBounds,
    defaultCameraViewId,
    deleteKeyframe,
    engine,
    environmentMapRef,
    environmentOpen,
    explosionFactor,
    frameRate,
    infoEnabled,
    lighting,
    loadedModelNames,
    loadedModels,
    locale,
    measureEnabled,
    measureMode,
    message,
    navigationDiagnostics,
    navigationMode,
    navigationSettings,
    navigate,
    pendingSceneFocusRef,
    physics,
    physicsOpen,
    postProcessing,
    project,
    removeCameraView,
    removeLight,
    rendererBackend,
    rendererSwitching,
    replaceCameraView,
    route,
    sceneAnimation,
    sceneBehaviorOpen,
    sceneCoordinates,
    sceneDashboard,
    sceneEnvironment,
    sceneInteractions,
    sceneName,
    sceneStatistics,
    scenes,
    selected,
    selectedLightId,
    selectedPhysics,
    selectionLocked,
    selectionName,
    selectionProperties,
    selectionScope,
    setAiAssistantOpen,
    setActiveScene,
    setAnimationOpen,
    setAvatarVisible,
    setCameraViewsOpen,
    setDefaultCameraViewId,
    setDigitalTwinOpen,
    setEnvironmentOpen,
    setInfoEnabled,
    setMessage,
    setMeasurements,
    setPhysicsOpen,
    setRevision,
    setSceneBehaviorOpen,
    setSceneCoordinates,
    setSceneDashboard,
    setSelectedLightId,
    setSelectionScope,
    setViewerToolsOpen,
    setXrPanelOpen,
    startXR,
    toggleAnnotationPlacement,
    toggleClipping,
    toggleMeasurement,
    toggleSceneAnimation,
    transformMode,
    updateCameraViewName,
    updateClipping,
    updateClippingBox,
    updateExplosion,
    updateLight,
    updateSceneAnimation,
    viewerLoadState,
    viewerToolsOpen,
    viewportRef,
    weather,
    xrActiveMode,
    xrCapabilities,
    xrPanelOpen,
  } = controller;
  const [viewerObjectPanelOpen, setViewerObjectPanelOpen] = useState(false);
  const [simulationPanelId, setSimulationPanelId] = useState<SceneSimulationPanelId>();
  useSceneSimulationOverlay(engine, activeScene, route.view === "studio" && Boolean(simulationPanelId), controller.bindings.state.revision);
  const workspaceIsPrimary = route.view === "studio" || route.view === "view" || route.view === "published";
  const deliveryToolbarVisible = sceneViewerDeliveryToolbarVisible();
  const viewerToolbarVisible = deliveryToolbarVisible ?? (route.view === "view" || activeScene?.publicationToolbarVisible !== false);
  const viewerRouteHasToolbar = (route.view === "view" || route.view === "published") && viewerToolbarVisible;
  const viewerExplosionTargets = selected?.kind === "model" ? [selected] : loadedModels.filter((model) => model.kind === "model");
  const viewerExplosionActive = Boolean(engine && viewerExplosionTargets.some((model) => engine.getExplosionFactor(model.id) > 0));

  function toggleViewerExplosion() {
    if (!engine || viewerExplosionTargets.length === 0) return;
    const nextFactor = viewerExplosionActive ? 0 : 0.55;
    for (const model of viewerExplosionTargets) engine.setExplosion(model.id, nextFactor);
    setRevision((value) => value + 1);
    setMessage(nextFactor > 0 ? tr(locale, "已展开模型，再次点击可复位", "Model exploded; click again to restore") : tr(locale, "已恢复模型组合", "Model restored"));
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewportRef.current?.parentElement?.requestFullscreen();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr(locale, "当前浏览器无法进入全屏", "Fullscreen is unavailable in this browser"));
    }
  }

  function toggleSimulationPanel(panel: SceneSimulationPanelId) {
    setSimulationPanelId((current) => current === panel ? undefined : panel);
    setAnimationOpen(false);
    setCameraViewsOpen(false);
    setEnvironmentOpen(false);
    setPhysicsOpen(false);
    setSceneBehaviorOpen(false);
    setXrPanelOpen(false);
  }

  function openSimulationTarget(sceneId: string, objectId: string) {
    const targetScene = scenes.find((scene) => scene.id === sceneId);
    if (!targetScene) {
      setMessage(tr(locale, "关联的三维场景已不存在", "The linked 3D scene no longer exists"));
      return;
    }
    if (activeScene?.id === sceneId) {
      engine?.select(objectId);
      engine?.focusModel(objectId);
      setMessage(tr(locale, "已在当前视口定位仿真对象", "Simulation target focused in the viewport"));
      return;
    }
    const targetLabel = targetScene.models.find((item) => item.modelId === objectId)?.name
      ?? targetScene.primitives.find((item) => item.modelId === objectId)?.name;
    pendingSceneFocusRef.current = { sceneId, objectId, ...(targetLabel ? { label: targetLabel } : {}) };
    setActiveScene(undefined);
    setSimulationPanelId(undefined);
    navigate({ view: "studio", sceneId });
  }

  return (
    <div className="workspace" role={workspaceIsPrimary ? "main" : undefined} aria-hidden={workspaceIsPrimary ? undefined : true}>
      {workspaceIsPrimary && <h1 className="sr-only">{route.view === "studio" ? tr(locale, `${sceneName} · 三维场景编辑`, `${sceneName} · 3D scene editor`) : tr(locale, `${sceneName} · 场景浏览`, `${sceneName} · Scene viewer`)}</h1>}
      <div className="viewport" ref={viewportRef} />
      {rendererSwitching && (
        <div className="renderer-loading">
          {" "}
          <LoaderCircle className="spin" size={18} />{" "}
          <span>
            {" "}
            {tr(locale, "正在初始化", "Initializing")} {rendererBackend === "webgpu" ? "WebGPU" : "WebGL"}{" "}
          </span>{" "}
        </div>
      )}
      {viewerRouteHasToolbar ? (
        <PublishedViewerToolDock
          locale={locale}
          open={viewerToolsOpen}
          navigationMode={navigationMode}
          measureEnabled={measureEnabled}
          clippingEnabled={clipping.enabled}
          explosionActive={viewerExplosionActive}
          avatarVisible={avatarVisible}
          infoEnabled={infoEnabled}
          objectPanelOpen={viewerObjectPanelOpen}
          onOpenChange={setViewerToolsOpen}
          onFitAll={() => engine?.fitAll()}
          onNavigationChange={changeNavigation}
          onMeasurementToggle={toggleMeasurement}
          onClippingToggle={toggleClipping}
          onExplosionToggle={toggleViewerExplosion}
          onAvatarToggle={() => {
            const next = !avatarVisible;
            setAvatarVisible(next);
            engine?.setAvatarVisible(next);
          }}
          onInfoToggle={() => setInfoEnabled((value) => !value)}
          onObjectPanelOpenChange={setViewerObjectPanelOpen}
          onStandardView={(view) => engine?.setStandardView(view)}
          onFullscreen={() => void toggleFullscreen()}
          onStartXR={(mode) => void startXR(mode)}
        />
      ) : route.view === "studio" ? (
        <SceneToolDock
          locale={locale}
          navigationMode={navigationMode}
          transformMode={transformMode}
          hasSelection={Boolean(selected)}
          selectionScope={selectionScope}
          measureEnabled={measureEnabled}
          annotationEnabled={annotationEnabled}
          clippingEnabled={clipping.enabled}
          explosionActive={explosionFactor > 0}
          avatarVisible={avatarVisible}
          environmentOpen={environmentOpen}
          animationOpen={animationOpen}
          behaviorOpen={sceneBehaviorOpen}
          cameraOpen={cameraViewsOpen}
          physicsOpen={physicsOpen}
          xrOpen={xrPanelOpen}
          simulationPanel={simulationPanelId}
          infoEnabled={infoEnabled}
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
          onEnvironmentToggle={() => {
            setEnvironmentOpen((value) => !value);
            setDigitalTwinOpen(false);
          }}
          onAnimationToggle={() => setAnimationOpen((value) => !value)}
          onBehaviorToggle={() => setSceneBehaviorOpen((value) => !value)}
          onCameraToggle={() => setCameraViewsOpen((value) => !value)}
          onPhysicsToggle={() => {
            setPhysicsOpen((value) => !value);
            setEnvironmentOpen(false);
          }}
          onXrToggle={() => setXrPanelOpen((value) => !value)}
          onSimulationPanelChange={toggleSimulationPanel}
        />
      ) : null}
      {route.view === "studio" && simulationPanelId && project && (
        <Suspense fallback={<div className="scene-simulation-loading"><LoaderCircle className="spin" size={18} />{tr(locale, "正在加载仿真插件", "Loading simulation plugin")}</div>}>
          <SceneSimulationPanel
            locale={locale}
            panelId={simulationPanelId}
            project={project}
            scenes={scenes}
            {...(activeScene ? { activeScene } : {})}
            {...(selected ? { selectedObjectId: selected.id, selectedObjectName: selectionName || selected.name } : {})}
            onPanelChange={setSimulationPanelId}
            onOpenEvidence={() => navigate({ view: "operations", operationsTab: simulationPanelId === "whatif" ? "whatif" : simulationPanelId === "logistics" ? "logistics" : "commissioning" })}
            onOpenDataCenter={() => navigate({ view: "data" })}
            onOpenSceneTarget={openSimulationTarget}
            onClose={() => setSimulationPanelId(undefined)}
          />
        </Suspense>
      )}
      {route.view === "studio" && <ViewControl locale={locale} onSelect={(view) => engine?.setStandardView(view)} />}
      {route.view === "studio" && cameraViewsOpen && (
        <CameraNavigationPanel
          locale={locale}
          mode={navigationMode}
          modelCount={loadedModels.filter((item) => item.visible).length}
          avatarVisible={avatarVisible}
          constraints={cameraConstraints}
          navigation={navigationSettings}
          diagnostics={navigationDiagnostics}
          views={cameraViews}
          defaultViewId={defaultCameraViewId}
          onClose={() => setCameraViewsOpen(false)}
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
        />
      )}
      {route.view === "studio" && environmentOpen && (
        <SceneEnvironmentPanel
          locale={locale}
          rendererBackend={rendererBackend}
          coordinates={sceneCoordinates}
          weather={weather}
          environment={sceneEnvironment}
          projectAssets={project?.assets ?? []}
          lighting={lighting}
          postProcessing={postProcessing}
          selectedLightId={selectedLightId}
          onCoordinatesChange={setSceneCoordinates}
          onWeatherChange={changeWeather}
          onEnvironmentChange={changeSceneEnvironment}
          onLightingChange={changeLighting}
          onPostProcessingChange={changePostProcessing}
          onChooseEnvironmentMap={() => environmentMapRef.current?.click()}
          onSelectLight={setSelectedLightId}
          onAddLight={addLight}
          onUpdateLight={updateLight}
          onRemoveLight={removeLight}
        />
      )}
      {route.view === "studio" && physicsOpen && (
        <ScenePhysicsPanel
          locale={locale}
          value={physics}
          selectedName={selected?.name}
          selectedBody={selected ? selectedPhysics : undefined}
          onChange={changePhysics}
          onSelectedBodyChange={changeSelectedPhysics}
          onReset={() => {
            engine?.resetPhysics();
            setRevision((value) => value + 1);
          }}
          onClose={() => setPhysicsOpen(false)}
        />
      )}
      {route.view === "studio" && xrPanelOpen && (
        <SceneXrPanel
          locale={locale}
          rendererBackend={rendererBackend}
          capabilities={xrCapabilities}
          activeMode={xrActiveMode}
          onStart={(mode) => void startXR(mode)}
          onEnd={() => void engine?.endXR()}
          onClose={() => setXrPanelOpen(false)}
        />
      )}
      {route.view === "studio" && aiAssistantOpen && (
        <AiAssistantPanel
          locale={locale}
          projectId={project?.id}
          surface="studio"
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
      {viewerRouteHasToolbar && viewerObjectPanelOpen && (
        <PublishedViewerObjectPanel
          locale={locale}
          models={loadedModels}
          selected={selected}
          properties={selectionProperties}
          isolationActive={engine?.isIsolationActive() ?? false}
          onSelect={(id) => engine?.select(id)}
          onFocus={(id) => engine?.focusModel(id)}
          onVisibilityChange={(id, visible) => {
            engine?.setVisible(id, visible);
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
            for (const model of loadedModels) engine?.setVisible(model.id, true);
            engine?.clearIsolation();
            setRevision((value) => value + 1);
          }}
          onClose={() => setViewerObjectPanelOpen(false)}
        />
      )}
      {animationOpen && (
        <SceneTimelinePanel
          locale={locale}
          animation={sceneAnimation}
          currentTime={animationTime}
          playing={animationPlaying}
          selectedObjectName={selected ? selectionName || selected.name : undefined}
          selectedObjectLocked={selectionLocked}
          modelNames={loadedModelNames}
          onClose={() => setAnimationOpen(false)}
          onPlayPause={toggleSceneAnimation}
          onSeek={(time) => engine?.seekSceneAnimation(time)}
          onChange={updateSceneAnimation}
          onRecordCamera={addCameraKeyframe}
          onRecordObject={addModelKeyframe}
          onDeleteFrame={deleteKeyframe}
        />
      )}
      <SceneViewportStatus
        locale={locale}
        studio={route.view === "studio"}
        measureControlsVisible={route.view === "studio" || viewerRouteHasToolbar}
        busy={busy}
        message={message}
        infoEnabled={infoEnabled}
        measureEnabled={measureEnabled}
        annotationEnabled={annotationEnabled}
        measureMode={measureMode}
        navigationMode={navigationMode}
        collisionEnabled={cameraConstraints.collisionEnabled}
        frameRate={frameRate}
        statistics={sceneStatistics}
        viewerLoadState={viewerLoadState}
        brandLogoUrl={branding.logoUrl}
        brandName={branding.systemName}
        sceneName={sceneName}
        onInfoClose={() => setInfoEnabled(false)}
        onMeasureModeChange={changeMeasureMode}
        onMeasurementsClear={() => {
          engine?.clearMeasurements();
          setMeasurements([]);
          if (measureEnabled) toggleMeasurement();
          setMessage(tr(locale, "已清除当前浏览会话的标尺", "Measurements cleared for this viewer session"));
        }}
        onAnnotationClose={toggleAnnotationPlacement}
        onNavigationSettings={() => setCameraViewsOpen(true)}
        onNavigationExit={() => changeNavigation("orbit")}
      />
    </div>
  );
}
