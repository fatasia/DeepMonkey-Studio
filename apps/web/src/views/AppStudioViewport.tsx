import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { getSceneModelAssetId, type PlantLiteStudyRecord } from "@bim-studio/contracts";
import type { CameraState } from "@bim-studio/contracts";
import type { ProbeGridBakeGrid } from "@bim-studio/deep-engine";
import { LoaderCircle } from "lucide-react";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { layerVisibilityCommand } from "../commands/engineEditCommand";
import { normalizeDashboardState } from "../components/dashboardState";
import { translate as tr } from "../i18n";
import { runProbeGridBake } from "../delivery/probeGridBakeRunner";
import { storeProbeGridBake } from "../delivery/probeGridBakePublicationSession";
import { fetchPersistedProbeGridBake, persistProbeGridBake } from "../delivery/probeGridBakePersistence";
import type { ProbeGridBakeUiState } from "../components/SceneProbeGridBakePanel";
import { AiAssistantPanel } from "../components/AiAssistantPanel";
import { CameraNavigationPanel } from "../components/CameraNavigationPanel";
import { SceneClippingPanel } from "../components/SceneClippingPanel";
import { SceneEnvironmentPanel } from "../components/SceneEnvironmentPanel";
import { SceneEngineeringAnalysisPanel } from "../components/SceneEngineeringAnalysisPanel";
import { ScenePhysicsPanel } from "../components/ScenePhysicsPanel";
import { PublishedViewerToolDock } from "../components/PublishedViewerToolDock";
import { PublishedViewerObjectPanel } from "../components/PublishedViewerObjectPanel";
import { SceneTimelinePanel, type SceneDirectorWorkspace } from "../components/SceneTimelinePanel";
import { SceneToolDock } from "../components/SceneToolDock";
import { ViewOrientationCube } from "../components/ViewOrientationCube";
import "../components/ViewOrientationCube.css";
import { SceneViewportStatus } from "../components/SceneViewportStatus";
import { SceneXrPanel } from "../components/SceneXrPanel";
import type { AppStudioController } from "./AppStudioShell";
import { sceneViewerDeliveryToolbarVisible } from "../delivery/sceneViewerDelivery";
import type { SceneSimulationPanelId } from "../simulation/sceneSimulationRegistry";
import type { SimulationDockReservation } from "../simulation/sceneSimulationLayout";
import { useSceneSimulationOverlay } from "../hooks/useSceneSimulationOverlay";
import { useScenePlantPlayback } from "../hooks/useScenePlantPlayback";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import { PublishedModelCredits } from "../delivery/PublishedModelCredits";
import { xrSessionAvailability } from "../rendererCapabilities";

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
    engineeringAnalysis,
    changeEngineeringAnalysis,
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
    reverseSceneAnimation,
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
  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [simulationPanelId, setSimulationPanelId] = useState<SceneSimulationPanelId>();
  const [simulationDock, setSimulationDock] = useState<SimulationDockReservation>({ placement: "float", collapsed: false, width: 0 });
  const [simulationStudy, setSimulationStudy] = useState<PlantLiteStudyRecord>();
  const [simulationFrame, setSimulationFrame] = useState<PlantLitePlaybackFrame | null>(null);
  const [simulationTrack, setSimulationTrack] = useState(false);
  // B3 缺口 5：碰撞体调试线框开关——React 状态触发重渲染，引擎是事实来源；
  // 引擎重建（渲染后端切换）后经 effect 把当前开关重新应用到新引擎，避免状态漂移。
  const [physicsDebugVisible, setPhysicsDebugVisible] = useState(false);
  useEffect(() => {
    engine?.setPhysicsDebugVisible(physicsDebugVisible);
  }, [engine, physicsDebugVisible]);
  // F3 探针网格烘焙：UI 状态与执行回调。结果由 runner 存入发布会话态，
  // Deep Native 打包（exportSceneClientPackage → prepareNativeSceneClientPayload）
  // 按场景语义哈希自动携带；场景/项目切换即回到 idle，烘焙中的旧任务回执被丢弃。
  const [probeBake, setProbeBake] = useState<ProbeGridBakeUiState>({ kind: "idle" });
  const probeBakeOwnerRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    probeBakeOwnerRef.current = project?.id && activeScene ? `${project.id}/${activeScene.id}` : undefined;
    setProbeBake({ kind: "idle" });
  }, [project?.id, activeScene?.id]);
  // F3 持久化回填:场景加载/切换时异步 GET 服务端持久化烘焙,命中即写回发布会话态
  // (probeGridBakeForPayload 随后可取到)。哈希用当前场景语义计算,场景已变化时服务端
  // 自然失配(404),不命中不报错、不阻塞渲染;切换走人后过期回执被丢弃。
  useEffect(() => {
    if (!activeScene) return;
    const ownerKey = project?.id ? `${project.id}/${activeScene.id}` : undefined;
    let subscribed = true;
    fetchPersistedProbeGridBake(activeScene).then(entry => {
      if (!entry || !subscribed || probeBakeOwnerRef.current !== ownerKey) return;
      storeProbeGridBake(activeScene, entry);
      // 仅在 idle 时呈现回填状态,避免覆盖同场景内已开始的烘焙进度。
      setProbeBake(current => current.kind !== "idle" ? current : { kind: "done",
        probeCount: entry.probeCount, coveredCount: entry.coveredCount,
        coverage: entry.probeCount > 0 ? entry.coveredCount / entry.probeCount : 0 });
    }).catch(() => undefined);
    return () => { subscribed = false; };
  }, [project?.id, activeScene?.id]);
  const bakeProbeGrid = useCallback((grid: ProbeGridBakeGrid) => {
    if (!activeScene || !project) return;
    const ownerKey = `${project.id}/${activeScene.id}`;
    setProbeBake({ kind: "running", phase: "compile-scene" });
    runProbeGridBake({ scene: activeScene, models: project.models, grid })
      .then(outcome => {
        // 烘焙成功即入发布会话(键=编译器严格源投影哈希):发布链 probeGridBakeForPayload
        // 才能取到探针数据。此前只更新 UI 状态,发布时 lookup 必然落空——烘焙→发布断链。
        storeProbeGridBake(activeScene, outcome);
        // F3 持久化:异步上送服务端(按 sceneId+sourceHash 内容寻址),失败静默降级
        // =维持会话态,只 console.warn;不阻塞回执,也不影响本次会话内的发布。
        void persistProbeGridBake(activeScene, outcome);
        if (probeBakeOwnerRef.current === ownerKey) setProbeBake({ kind: "done",
          probeCount: outcome.probeCount, coveredCount: outcome.coveredCount, coverage: outcome.coverage });
      })
      .catch(reason => {
        if (probeBakeOwnerRef.current === ownerKey) setProbeBake({ kind: "error",
          message: reason instanceof Error ? reason.message : String(reason) });
      });
  }, [activeScene, project]);
  const [directorWorkspace, setDirectorWorkspace] = useState<SceneDirectorWorkspace>("timeline");
  const resolveSimulationPosition = useCallback((id: string) => engine?.getModelTransform(id)?.position, [engine, controller.bindings.state.revision]);
  const activeSimulationStudy = route.view === "studio" && simulationPanelId && simulationStudy?.model?.sceneBinding?.sceneId === activeScene?.id ? simulationStudy : undefined;
  useEffect(() => { setSimulationStudy(undefined); setSimulationFrame(null); setSimulationTrack(false); setDirectorWorkspace("timeline"); }, [project?.id, activeScene?.id]);
  useScenePlantPlayback(engine, animationOpen && simulationTrack ? activeSimulationStudy?.model : undefined, simulationFrame);
  const showSimulationStudy = (study: PlantLiteStudyRecord) => {
    if (study.model?.sceneBinding?.sceneId !== activeScene?.id || study.projectId !== project?.id) return;
    setSimulationStudy(study); setSimulationTrack(true); setDirectorWorkspace("timeline"); setAnimationOpen(true);
    if (animationPlaying) toggleSceneAnimation();
  };
  useSceneSimulationOverlay(engine, activeScene, route.view === "studio" && Boolean(simulationPanelId), controller.bindings.state.revision);
  const workspaceIsPrimary = route.view === "studio" || route.view === "view" || route.view === "published";
  const deliveryToolbarVisible = sceneViewerDeliveryToolbarVisible();
  const viewerToolbarVisible = deliveryToolbarVisible ?? (route.view === "view" || activeScene?.publicationToolbarVisible !== false);
  const viewerRouteHasToolbar = (route.view === "view" || route.view === "published") && viewerToolbarVisible;
  const viewerExplosionTargets = (engine?.listModels() ?? loadedModels).filter((model) => model.kind === "model");
  const [viewerExplosion, setViewerExplosion] = useState(false);
  const viewerExplosionActive = viewerExplosion && Boolean(engine && viewerExplosionTargets.length > 0);
  // XR 的后端事实来源是引擎作者渲染器（XR 仅挂 WebGL），而非用户后端偏好。
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
    setEnvironmentOpen(false);
    setPhysicsOpen(false);
    setSceneBehaviorOpen(false);
    setXrPanelOpen(false);
  }

  function openDirector(workspace: SceneDirectorWorkspace) {
    if (workspace !== "timeline") setSimulationTrack(false);
    setDirectorWorkspace(workspace);
    setAnimationOpen(true);
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
    <div className="workspace" data-simulation-dock={route.view === "studio" && simulationPanelId ? simulationDock.placement : "float"} role={workspaceIsPrimary ? "main" : undefined} aria-hidden={workspaceIsPrimary ? undefined : true}>
      <div className="studio-scene-surface" style={route.view === "studio" && simulationPanelId ? { left: simulationDock.placement === "left" ? simulationDock.width : 0, right: simulationDock.placement === "right" ? simulationDock.width : 0 } : undefined}>
      {workspaceIsPrimary && <h1 className="sr-only">{route.view === "studio" ? tr(locale, `${sceneName} · 三维场景编辑`, `${sceneName} · 3D scene editor`) : tr(locale, `${sceneName} · 场景浏览`, `${sceneName} · Scene viewer`)}</h1>}
      <div className="viewport" ref={viewportRef} />
      {rendererSwitching && (
        <div className="renderer-loading">
          {" "}
          <LoaderCircle className="spin" size={18} />{" "}
          <span>
            {" "}
            {tr(locale, "正在初始化", "Initializing")} {rendererBackend === "wasm" ? "Deep WASM" : rendererBackend === "webgpu" ? "Deep WebGPU Beta" : "WebGL"}{" "}
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
          fitSelectedEnabled={Boolean(selected)}
          onFitSelected={() => {
            if (selected) engine?.focusModel(selected.id);
          }}
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
          xrUnavailableReason={xrUnavailableReason}
        />
      ) : route.view === "studio" ? (
        <SceneToolDock
          locale={locale}
          navigationMode={navigationMode}
          transformMode={transformMode}
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
          xrOpen={xrPanelOpen}
          simulationPanel={simulationPanelId}
          infoEnabled={infoEnabled}
          engineeringOpen={engineeringOpen}
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
            setEngineeringOpen((value) => !value);
            setEnvironmentOpen(false);
            setPhysicsOpen(false);
          }}
          onEnvironmentToggle={() => {
            setEnvironmentOpen((value) => !value);
            setDigitalTwinOpen(false);
          }}
          onAnimationToggle={() => {
            setSimulationTrack(false);
            if (animationOpen && directorWorkspace === "timeline") setAnimationOpen(false);
            else openDirector("timeline");
          }}
          onBehaviorToggle={() => setSceneBehaviorOpen((value) => !value)}
          onPhysicsToggle={() => {
            setPhysicsOpen((value) => !value);
            setEnvironmentOpen(false);
          }}
          onXrToggle={() => setXrPanelOpen((value) => !value)}
          onSimulationPanelChange={toggleSimulationPanel}
        />
      ) : null}
      {route.view === "studio" && engineeringOpen && engine && (
        <SceneEngineeringAnalysisPanel
          locale={locale}
          sceneName={sceneName}
          models={engine.listModels()}
          value={engineeringAnalysis}
          onChange={changeEngineeringAnalysis}
          onFocusObject={(id) => engine.focusModel(id)}
          onClose={() => setEngineeringOpen(false)}
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
          probeBakeState={probeBake}
          onBakeProbeGrid={bakeProbeGrid}
          onClose={() => setEnvironmentOpen(false)}
        />
      )}
      {route.view === "studio" && physicsOpen && (
        <ScenePhysicsPanel
          locale={locale}
          value={physics}
          selectedName={selected?.name}
          selectedId={selected?.id}
          selectedPosition={selected ? (() => {
            const position = selected.object.getWorldPosition(new THREE.Vector3());
            return { x: position.x, y: position.y, z: position.z };
          })() : undefined}
          selectedBody={selected ? selectedPhysics : undefined}
          {...(engine ? { bodyOptions: engine.listModels().map((model) => ({
              id: model.id,
              name: model.name,
              type: engine.getPhysicsBodyState(model.id).type,
            })) } : {})}
          onChange={changePhysics}
          onSelectedBodyChange={changeSelectedPhysics}
          debugVisible={physicsDebugVisible}
          onDebugVisibleChange={setPhysicsDebugVisible}
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
          rendererBackend={xrAuthorBackend}
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
          onClose={() => setViewerObjectPanelOpen(false)}
        />
      )}
      {animationOpen && (
        <SceneTimelinePanel
          engine={engine}
          {...(simulationTrack && activeSimulationStudy ? { simulationStudy: activeSimulationStudy, onSimulationFrame: setSimulationFrame } : {})}
          onAnimationTrack={() => setSimulationTrack(false)}
          workspace={directorWorkspace}
          onWorkspaceChange={(workspace) => {
            if (workspace !== "timeline") setSimulationTrack(false);
            setDirectorWorkspace(workspace);
          }}
          cameraWorkspace={<CameraNavigationPanel
            embedded
            section={directorWorkspace === "shots" ? "views" : "walk"}
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
      {animationOpen && simulationTrack && activeSimulationStudy && simulationFrame && <div className="scene-simulation-live-status" role="status">DES 轨迹样本 · {simulationFrame.atMinute.toFixed(1)} 分钟<br />在制 {simulationFrame.activeItems} · 完成 {simulationFrame.completedItems} · 仅覆盖显示</div>}
      {(route.view === "view" || route.view === "published") && project && <PublishedModelCredits locale={locale} models={project.models} modelIds={activeScene?.models.map(getSceneModelAssetId) ?? []} />}
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
        onNavigationSettings={() => openDirector("navigation")}
        onNavigationExit={() => changeNavigation("orbit")}
      />
      </div>
      {route.view === "studio" && simulationPanelId && project && (
        <Suspense fallback={<div className="scene-simulation-loading"><LoaderCircle className="spin" size={18} />{tr(locale, "正在加载仿真插件", "Loading simulation plugin")}</div>}>
          <SceneSimulationPanel
            locale={locale}
            panelId={simulationPanelId}
            project={project}
            scenes={scenes}
            {...(activeScene ? { activeScene } : {})}
            {...(selected ? { selectedObjectId: selected.id, selectedObjectName: selectionName || selected.name } : {})}
            sceneFlow={{ objects: loadedModels, resolvePosition: resolveSimulationPosition, onEntitiesChange: controller.bindings.scenePersistence.replaceSimulationEntities, onStudy: showSimulationStudy }}
            onPanelChange={setSimulationPanelId}
            onDockChange={setSimulationDock}
            onOpenEvidence={() => navigate({ view: "operations", operationsTab: simulationPanelId === "whatif" ? "whatif" : simulationPanelId === "logistics" ? "logistics" : "commissioning" })}
            onOpenDataCenter={() => navigate({ view: "data" })}
            onOpenSceneTarget={openSimulationTarget}
            onClose={() => { setSimulationPanelId(undefined); if (simulationTrack) setAnimationOpen(false); setSimulationTrack(false); setSimulationFrame(null); }}
          />
        </Suspense>
      )}
    </div>
  );
}
function getCubeOrientation(camera?: CameraState): { azimuthDeg: number; elevationDeg: number } {
  if (!camera) return { azimuthDeg: 0, elevationDeg: 25 };
  const dx = camera.position.x - camera.target.x;
  const dy = camera.position.y - camera.target.y;
  const dz = camera.position.z - camera.target.z;
  const horizontalDistance = Math.hypot(dx, dz);
  if (horizontalDistance + Math.abs(dy) < 0.0001) return { azimuthDeg: 0, elevationDeg: 25 };
  return {
    azimuthDeg: Math.atan2(dx, dz) * 180 / Math.PI,
    elevationDeg: Math.atan2(dy, horizontalDistance) * 180 / Math.PI,
  };
}

interface EngineViewOrientationCubeProps {
  readonly engine: NonNullable<AppStudioController["engine"]>;
  readonly locale: Parameters<typeof ViewOrientationCube>[0]["locale"];
  readonly hasSelection: boolean;
  readonly onStandardView: Parameters<typeof ViewOrientationCube>[0]["onStandardView"];
  readonly onFitAll: () => void;
  readonly onFitSelected: () => void;
  readonly onOptimizeView: () => void;
}

/** Keeps high-frequency orientation updates inside the tiny viewport control. */
export function EngineViewOrientationCube(props: EngineViewOrientationCubeProps) {
  const [camera, setCamera] = useState<CameraState>(() => props.engine.getCameraState());
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const initial = props.engine.getCameraState();
    setCamera(initial);
    let settleTimer: number | undefined;
    const unsubscribe = props.engine.subscribeCameraChange((next) => {
      const nextOrientation = getCubeOrientation(next);
      // The cube's visual rotation is compositor-only. Updating the element
      // directly keeps it attached to every camera frame without committing
      // the React tree on every pointer sample; React catches up once after the
      // gesture so face semantics and accessibility state stay authoritative.
      if (innerRef.current) innerRef.current.style.transform = `rotateX(${-nextOrientation.elevationDeg}deg) rotateY(${-nextOrientation.azimuthDeg}deg)`;
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        setCamera(next);
      }, 80);
    });
    return () => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      unsubscribe();
    };
  }, [props.engine]);
  const orientation = getCubeOrientation(camera);
  return <ViewOrientationCube locale={props.locale} azimuthDeg={orientation.azimuthDeg}
    elevationDeg={orientation.elevationDeg} hasSelection={props.hasSelection}
    innerRef={innerRef}
    onStandardView={props.onStandardView} onFitAll={props.onFitAll}
    onFitSelected={props.onFitSelected} onOptimizeView={props.onOptimizeView} />;
}
