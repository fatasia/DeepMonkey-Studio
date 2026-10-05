import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { translate as tr } from "../i18n";
import { SceneViewportStatus } from "../components/SceneViewportStatus";
import type { AppStudioController } from "./AppStudioShell";
import { useGlobalShortcuts } from "../shortcuts/useGlobalShortcuts";
import { xrSessionAvailability } from "../rendererCapabilities";
import { sceneViewerDeliveryToolbarVisible } from "../delivery/sceneViewerDelivery";
import { useSceneEditPort } from "../hooks/useSceneEditPort";
import { useAppStudioViewportToggles } from "./appStudioViewport/useAppStudioViewportToggles";
import { useAppStudioPhysicsDebugState } from "./appStudioViewport/useAppStudioPhysicsDebugState";
import { useAppStudioProbeBake } from "./appStudioViewport/useAppStudioProbeBake";
import { useAppStudioSimulationDock } from "./appStudioViewport/useAppStudioSimulationDock";
import { EngineViewOrientationCube } from "./appStudioViewport/AppStudioViewportOrientationCube";
import { AppStudioViewportToolDock } from "./appStudioViewport/AppStudioViewportToolDock";
import { AppStudioViewportStudioPanels } from "./appStudioViewport/AppStudioViewportStudioPanels";
import { AppStudioViewportEditorPanels } from "./appStudioViewport/AppStudioViewportEditorPanels";
import { AppStudioViewportViewerPanels } from "./appStudioViewport/AppStudioViewportViewerPanels";

/**
 * AppStudio 视口挂载编排(source-size 拆分,2026-10-04:自单文件按职责拆分为
 * appStudioViewport/ 域——面板开态/物理调试状态/探针烘焙/仿真停靠四个自定义 hook,
 * 加取向立方体、工具坞、studio 面板组、编辑器面板组、发布视口面板组五个接线组件;
 * 本文件只保留挂载编排:状态 hooks 装配、全局快捷键、XR 可用性派发、壳层 JSX 与
 * 视口状态条。JSX 与逻辑逐行同源,仅包一层组件;宿主 API 不变,语义零变化)。
 */
export function AppStudioViewport({ controller }: { controller: AppStudioController }) {
  const {
    activeScene,
    branding,
    busy,
    cameraConstraints,
    changeMeasureMode,
    changeNavigation,
    engine,
    frameRate,
    infoEnabled,
    annotationEnabled,
    loadedModels,
    locale,
    measureEnabled,
    measureMode,
    message,
    navigationMode,
    project,
    route,
    sceneName,
    sceneStatistics,
    selected,
    setInfoEnabled,
    setMessage,
    setMeasurements,
    setRevision,
    toggleAnnotationPlacement,
    toggleMeasurement,
    viewerLoadState,
    viewportRef,
  } = controller;
  const toggles = useAppStudioViewportToggles();
  const physicsDebug = useAppStudioPhysicsDebugState(controller.engine, selected?.id);
  const { probeBake, bakeProbeGrid } = useAppStudioProbeBake(project, activeScene);
  const simulation = useAppStudioSimulationDock(controller);
  const sceneEditPort = useSceneEditPort(controller.bindings, engine);
  const workspaceIsPrimary = route.view === "studio" || route.view === "view" || route.view === "published";
  const deliveryToolbarVisible = sceneViewerDeliveryToolbarVisible();
  const viewerToolbarVisible = deliveryToolbarVisible ?? (route.view === "view" || activeScene?.publicationToolbarVisible !== false);
  const viewerRouteHasToolbar = (route.view === "view" || route.view === "published") && viewerToolbarVisible;
  const viewerExplosionTargets = (engine?.listModels() ?? loadedModels).filter((model) => model.kind === "model");
  const [viewerExplosion, setViewerExplosion] = useState(false);
  const viewerExplosionActive = viewerExplosion && Boolean(engine && viewerExplosionTargets.length > 0);
  // XR 的后端事实来源是引擎作者渲染器(XR 仅挂 WebGL),而非用户后端偏好。
  const xrAuthorBackend = engine?.getAuthorRendererBackend() ?? "webgl";
  const xrUnavailableReasons = xrSessionAvailability({
    secureContext: window.isSecureContext,
    webxr: Boolean(navigator.xr),
    backend: xrAuthorBackend,
  }).reasons;
  const xrUnavailableReason = xrUnavailableReasons.length > 0 ? xrUnavailableReasons.join("；") : undefined;

  function toggleViewerExplosion() {
    if (!engine || viewerExplosionTargets.length === 0) return;
    const nextFactor = viewerExplosionActive ? 0 : 0.55;
    for (const model of viewerExplosionTargets) engine.setExplosion(model.id, nextFactor);
    setViewerExplosion(nextFactor > 0);
    setRevision((value) => value + 1);
    setMessage(nextFactor > 0 ? tr(locale, "已展开模型，再次点击可复位", "Model exploded; click again to restore") : tr(locale, "已恢复模型组合", "Model restored"));
  }

  // 全局工具快捷键(Q/W/E/R 切换工具,F 全景)。engine 缺失时动作自空操作。
  useGlobalShortcuts({
    "tool.select": () => changeNavigation("orbit"),
    "tool.translate": () => controller.changeTransform("translate"),
    "tool.rotate": () => controller.changeTransform("rotate"),
    "tool.scale": () => controller.changeTransform("scale"),
    "camera.focus": () => engine?.fitAll(),
  });

  return (
    <div className="workspace" data-simulation-dock={route.view === "studio" && simulation.simulationPanelId ? simulation.simulationDock.placement : "float"} role={workspaceIsPrimary ? "main" : undefined} aria-hidden={workspaceIsPrimary ? undefined : true}>
      <div className="studio-scene-surface" style={route.view === "studio" && simulation.simulationPanelId ? { left: simulation.simulationDock.placement === "left" ? simulation.simulationDock.width : 0, right: simulation.simulationDock.placement === "right" ? simulation.simulationDock.width : 0 } : undefined}>
      {workspaceIsPrimary && <h1 className="sr-only">{route.view === "studio" ? tr(locale, `${sceneName} · 三维场景编辑`, `${sceneName} · 3D scene editor`) : tr(locale, `${sceneName} · 场景浏览`, `${sceneName} · Scene viewer`)}</h1>}
      <div className="viewport" ref={viewportRef} />
      {controller.rendererSwitching && (
        <div className="renderer-loading">
          {" "}
          <LoaderCircle className="spin" size={18} />{" "}
          <span>
            {" "}
            {tr(locale, "正在初始化", "Initializing")} {controller.rendererBackend === "wasm" ? "Deep WASM" : controller.rendererBackend === "webgpu" ? "Deep WebGPU" : "WebGL"}{" "}
          </span>{" "}
        </div>
      )}
      {route.view === "studio" && engine && (
        <EngineViewOrientationCube
          engine={engine}
          locale={locale}
          hasSelection={Boolean(selected)}
          onStandardView={(view) => engine.setStandardView(view)}
          onFitAll={() => engine.fitAll()}
          onFitSelected={() => {
            if (selected) engine.focusModel(selected.id);
          }}
          onOptimizeView={() => engine.fitAll()}
        />
      )}
      <AppStudioViewportToolDock
        controller={controller}
        toggles={toggles}
        physicsDebug={physicsDebug}
        simulation={simulation}
        viewerExplosionActive={viewerExplosionActive}
        onToggleViewerExplosion={toggleViewerExplosion}
        xrUnavailableReason={xrUnavailableReason}
      />
      <AppStudioViewportStudioPanels
        controller={controller}
        toggles={toggles}
        physicsDebug={physicsDebug}
        probeBake={probeBake}
        bakeProbeGrid={bakeProbeGrid}
        xrAuthorBackend={xrAuthorBackend}
      />
      <AppStudioViewportEditorPanels
        controller={controller}
        simulation={simulation}
        sceneEditPort={sceneEditPort}
      />
      <AppStudioViewportViewerPanels
        controller={controller}
        toggles={toggles}
      />
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
        onNavigationSettings={() => simulation.openDirector("navigation")}
        onNavigationExit={() => changeNavigation("orbit")}
      />
      </div>
    </div>
  );
}
