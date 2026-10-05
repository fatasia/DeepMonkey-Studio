import * as THREE from "three";
import type { ProbeGridBakeGrid } from "@bim-studio/deep-engine";
import type { AppStudioController } from "../AppStudioShell";
import { SceneEngineeringAnalysisPanel } from "../../components/SceneEngineeringAnalysisPanel";
import { SceneEnvironmentPanel } from "../../components/SceneEnvironmentPanel";
import { ScenePhysicsPanel } from "../../components/ScenePhysicsPanel";
import { PhysicsDebugPanel } from "../../components/PhysicsDebugPanel";
import { QualityTelemetryPanel } from "../../components/QualityTelemetryPanel";
import { DevHud } from "../../components/DevHud";
import { ExperimentalFeaturesPanel } from "../../components/ExperimentalFeaturesPanel";
import { LightingBakeBenchPanel } from "../../components/LightingBakeBenchPanel";
import { SceneXrPanel } from "../../components/SceneXrPanel";
import type { ProbeGridBakeUiState } from "../../components/SceneProbeGridBakePanel";
import type { AppStudioViewportToggles } from "./useAppStudioViewportToggles";
import type { AppStudioPhysicsDebugState } from "./useAppStudioPhysicsDebugState";

/**
 * AppStudioViewport studio 实体面板接线(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出,JSX 逐行同源,仅包一层组件;语义零变化)。
 *
 * 职责:工程分析 / 环境 / 物理 / 物理调试 / 质量 / 开发者 HUD / 实验性功能 /
 * 光照烘焙工作台 / XR 面板的开态条件渲染与 props 接线。
 */
export function AppStudioViewportStudioPanels({ controller, toggles, physicsDebug, probeBake, bakeProbeGrid, xrAuthorBackend }: {
  controller: AppStudioController;
  toggles: Pick<AppStudioViewportToggles, "engineeringOpen" | "setEngineeringOpen" | "qualityPanelOpen" | "setQualityPanelOpen" | "devHudOpen" | "setDevHudOpen" | "experimentalPanelOpen" | "setExperimentalPanelOpen" | "bakeBenchOpen" | "setBakeBenchOpen">;
  physicsDebug: Pick<AppStudioPhysicsDebugState, "physicsDebugVisible" | "setPhysicsDebugVisible" | "physicsDebugFilter" | "setPhysicsDebugFilter" | "physicsDebugLayers" | "setPhysicsDebugLayers" | "physicsDebugPanelOpen" | "setPhysicsDebugPanelOpen">;
  probeBake: ProbeGridBakeUiState;
  bakeProbeGrid: (grid: ProbeGridBakeGrid) => void;
  xrAuthorBackend: Parameters<typeof SceneXrPanel>[0]["rendererBackend"];
}) {
  const {
    addLight,
    changeEngineeringAnalysis,
    changeLighting,
    changePhysics,
    changePostProcessing,
    changeSceneEnvironment,
    changeSelectedPhysics,
    changeWeather,
    engine,
    engineeringAnalysis,
    environmentMapRef,
    environmentOpen,
    lighting,
    locale,
    physics,
    physicsOpen,
    postProcessing,
    project,
    removeLight,
    rendererBackend,
    route,
    selected,
    selectedLightId,
    selectedPhysics,
    sceneCoordinates,
    sceneEnvironment,
    sceneName,
    setEnvironmentOpen,
    setPhysicsOpen,
    setSceneCoordinates,
    setSelectedLightId,
    setRevision,
    setXrPanelOpen,
    startXR,
    updateLight,
    weather,
    xrActiveMode,
    xrCapabilities,
    viewportRef,
    xrPanelOpen,
  } = controller;
  return (
    <>
      {route.view === "studio" && toggles.engineeringOpen && engine && (
        <SceneEngineeringAnalysisPanel
          locale={locale}
          sceneName={sceneName}
          models={engine.listModels()}
          value={engineeringAnalysis}
          onChange={changeEngineeringAnalysis}
          onFocusObject={(id) => engine.focusModel(id)}
          onClose={() => toggles.setEngineeringOpen(false)}
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
          debugVisible={physicsDebug.physicsDebugVisible}
          onDebugVisibleChange={physicsDebug.setPhysicsDebugVisible}
          onOpenDebugPanel={() => physicsDebug.setPhysicsDebugPanelOpen(true)}
          onReset={() => {
            engine?.resetPhysics();
            setRevision((value) => value + 1);
          }}
          onClose={() => setPhysicsOpen(false)}
        />
      )}
      {route.view === "studio" && physicsOpen && (
        <PhysicsDebugPanel
          locale={locale}
          open={physicsDebug.physicsDebugPanelOpen}
          onOpenChange={physicsDebug.setPhysicsDebugPanelOpen}
          engine={engine}
          physics={physics}
          onPhysicsChange={changePhysics}
          debugVisible={physicsDebug.physicsDebugVisible}
          onDebugVisibleChange={physicsDebug.setPhysicsDebugVisible}
          debugFilter={physicsDebug.physicsDebugFilter}
          onDebugFilterChange={physicsDebug.setPhysicsDebugFilter}
          debugLayers={physicsDebug.physicsDebugLayers}
          onDebugLayersChange={physicsDebug.setPhysicsDebugLayers}
          selectedName={selected?.name}
        />
      )}
      {route.view === "studio" && toggles.qualityPanelOpen && (
        <QualityTelemetryPanel
          locale={locale}
          engine={engine ?? undefined}
          onClose={() => toggles.setQualityPanelOpen(false)}
        />
      )}
      {route.view === "studio" && toggles.devHudOpen && (
        <DevHud
          locale={locale}
          engine={engine ?? undefined}
          onClose={() => toggles.setDevHudOpen(false)}
        />
      )}
      {route.view === "studio" && toggles.experimentalPanelOpen && (
        <ExperimentalFeaturesPanel
          locale={locale}
          onClose={() => toggles.setExperimentalPanelOpen(false)}
        />
      )}
      {route.view === "studio" && toggles.bakeBenchOpen && (
        <LightingBakeBenchPanel
          locale={locale}
          engine={engine ?? undefined}
          viewportRef={viewportRef}
          onClose={() => toggles.setBakeBenchOpen(false)}
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
    </>
  );
}
