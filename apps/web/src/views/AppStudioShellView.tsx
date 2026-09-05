import { useEffect, useRef, useState } from "react";
import { ACCEPTED_MODELS, STUDIO_INSPECTOR_STORAGE_KEY, STUDIO_LEFT_PANEL_STORAGE_KEY } from "../appDefaults";
import { readBooleanPreference, writeBooleanPreference } from "../hooks/usePersistedBooleanState";
import { FlatSceneObjectList } from "../components/FlatSceneObjectList";
import { ModelTreeItem } from "../components/ModelTreeItem";
import { SceneOrganizationPanel } from "../components/SceneOrganizationPanel";
import { SceneSimulationEntitiesSection } from "../components/SceneSimulationEntitiesSection";
import { SceneOutlinerPanel } from "../components/SceneOutlinerPanel";
import { AppWorkspaceTopbar } from "./AppWorkspaceTopbar";
import { mergeConfirmedSceneAssetBindings } from "../studio/sceneAssetBindings";
import type { AppStudioController } from "./AppStudioShell";
import { AppStudioInspector } from "./AppStudioInspector";
import { AppStudioViewport } from "./AppStudioViewport";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

export function AppStudioShellView({ controller }: { controller: AppStudioController }) {
  // 三维视口是核心工作区，资源树和属性检查器按需收起，避免遮挡模型。
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => readBooleanPreference(STUDIO_LEFT_PANEL_STORAGE_KEY, true));
  const [rightPanelOpen, setRightPanelOpen] = useState(() => readBooleanPreference(STUDIO_INSPECTOR_STORAGE_KEY, true));
  // SIM-1a：场景树「仿真」域的选中实体与断链集合（引用模型被删时黄牌提示）。
  const [selectedSimulationEntityId, setSelectedSimulationEntityId] = useState<string | undefined>(undefined);
  const panelsBeforeBehaviorSplitRef = useRef<{ left: boolean; right: boolean } | undefined>(undefined);
  const {
    activeApplication,
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
    annotations,
    applySceneSelectionSet,
    avatarVisible,
    beginPrimitivePlacement,
    behaviorScriptContext,
    bindings,
    branding,
    busy,
    cameraConstraints,
    cameraInfo,
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
    chooseMaterialTexture,
    clipping,
    clippingRange,
    clippingSceneBounds,
    collisions,
    componentCategory,
    componentFacets,
    componentLevel,
    componentQuery,
    componentResults,
    bindingComponents,
    componentSearchActive,
    createDeviceLayout,
    createSceneGroup,
    createSceneSelectionSet,
    moveSceneObjectsToGroup,
    reorderSceneGroup,
    renameSceneGroup,
    defaultCameraViewId,
    deleteAnnotation,
    deleteKeyframe,
    deleteMeasurement,
    deleteModel,
    deletePrimitive,
    deleteSceneSelectionSet,
    engine,
    environmentMapRef,
    environmentOpen,
    expandFloors,
    expandedModels,
    explosionFactor,
    explosionMode,
    floorExpansionByModel,
    floorStatesByModel,
    focusComponent,
    frameRate,
    importRef,
    importScene,
    infoEnabled,
    insertIndustrialPrefab,
    inspectorTab,
    interactionTargetOptions,
    isolateSceneObjects,
    lastDeletedSelectionSet,
    lighting,
    loadModel,
    loadedModelNames,
    loadedModels,
    locale,
    materialTextureRef,
    measureEnabled,
    measureMode,
    measurements,
    message,
    navigationDiagnostics,
    navigationMode,
    navigationSettings,
    openDataCenter,
    openDocs,
    physics,
    physicsOpen,
    pointerInfo,
    postProcessing,
    project,
    removeCameraView,
    removeLight,
    removeObjectInteractions,
    rendererBackend,
    rendererSwitching,
    replaceCameraView,
    replaceSceneOrganizationSelection,
    restoreDeletedSceneSelectionSet,
    restoreSceneObjectIsolation,
    revitRuntime,
    route,
    rvtConversionMode,
    rvtRevitVersion,
    sceneAnimation,
    sceneBehaviorOpen,
    sceneBehaviorLayout,
    sceneCoordinates,
    sceneDashboard,
    sceneDataBindingRuntime,
    sceneDataBindings,
    sceneAssetBindings,
    sceneEnvironment,
    sceneImportOpen,
    sceneInteractions,
    sceneName,
    sceneOrganizationObjects,
    sceneOrganizationOpen,
    sceneOrganizationSelection,
    scenePrimitives,
    sceneStatistics,
    scenes,
    selectLightForTransform,
    selected,
    selectedAnnotation,
    selectedAnnotationId,
    selectedBehaviorTarget,
    selectedComponent,
    selectedEffects,
    selectedLayerId,
    selectedLightId,
    selectedPhysics,
    selectedProjectPosition,
    selectedSpace,
    selectedTransform,
    selectionColor,
    selectionLocked,
    selectionMaterial,
    selectionName,
    selectionOpacity,
    selectionProperties,
    selectionScope,
    selectionSets,
    selectionVisible,
    setAiAssistantOpen,
    setAnimationOpen,
    setAnimationPlaying,
    setAvatarVisible,
    setCameraViewsOpen,
    setComponentCategory,
    setComponentLevel,
    setComponentQuery,
    setDefaultCameraViewId,
    setDigitalTwinOpen,
    setEnvironmentOpen,
    setInfoEnabled,
    setInspectorTab,
    setMeasurements,
    setMessage,
    setNavigationMode,
    setPhysicsOpen,
    setRevision,
    setRvtConversionMode,
    setRvtRevitVersion,
    setSceneBehaviorOpen,
    setSceneCoordinates,
    setSceneDashboard,
    setSceneAssetBindings,
    setSceneDataBindingRuntime,
    setSceneDataBindings,
    setSceneImportOpen,
    setSceneInteractions,
    setSceneObjectsLocked,
    setSceneObjectsVisible,
    setSceneOrganizationOpen,
    setSelectedLightId,
    setSelectedSpace,
    setSelectionScope,
    setViewerToolsOpen,
    setXrPanelOpen,
    spaces,
    startXR,
    toggleAnnotationPlacement,
    toggleClipping,
    toggleMeasurement,
    toggleModelTree,
    toggleSceneAnimation,
    toggleSceneOrganizationObject,
    transformMode,
    updateAnnotation,
    updateAnnotationPosition,
    updateCameraViewName,
    updateClipping,
    updateClippingBox,
    updateExplosion,
    updateFloor,
    updateLight,
    updateSceneAnimation,
    updateSceneSelectionSet,
    updateSelectedEffects,
    updateSelectedTransform,
    updateSelectionColor,
    updateSelectionMaterial,
    updateSelectionOpacity,
    updateSelectionVisibility,
    uploadEnvironmentMap,
    uploadMaterialTexture,
    uploadModels,
    uploadRef,
    uploading,
    viewerLoadState,
    viewerToolsOpen,
    viewportRef,
    weather,
    xrActiveMode,
    xrCapabilities,
    xrPanelOpen,
  } = controller;

  // SIM-1a 断链集合：仿真实体引用了已删除模型时在场景树黄牌标注（不静默失效）。
  const brokenSimulationModelIds = new Set<string>();
  for (const entity of activeScene?.simulationEntities ?? []) {
    const referenced = entity.kind === "flowLink" ? [entity.fromModelId, entity.toModelId]
      : entity.kind === "path" ? [entity.targetModelId]
        : [entity.a.modelId, entity.b.modelId];
    for (const modelId of referenced) {
      if (!project?.models.some((model) => model.id === modelId)) brokenSimulationModelIds.add(modelId);
    }
  }

  useEffect(() => {
    const splitActive = sceneBehaviorOpen && sceneBehaviorLayout === "split";
    if (splitActive) {
      panelsBeforeBehaviorSplitRef.current ??= { left: leftPanelOpen, right: rightPanelOpen };
      if (leftPanelOpen) setLeftPanelOpen(false);
      if (rightPanelOpen) setRightPanelOpen(false);
      return;
    }
    const previous = panelsBeforeBehaviorSplitRef.current;
    if (!previous) return;
    panelsBeforeBehaviorSplitRef.current = undefined;
    setLeftPanelOpen(previous.left);
    setRightPanelOpen(previous.right);
  }, [leftPanelOpen, rightPanelOpen, sceneBehaviorLayout, sceneBehaviorOpen]);

  return (
    <>
      <div
        className={`app-shell ${route.view === "view" || route.view === "published" ? "viewer-shell" : ""} ${route.view === "studio" || route.view === "view" || route.view === "published" ? "" : "app-shell-hidden"}${leftPanelOpen ? "" : " left-panel-collapsed"}${rightPanelOpen ? "" : " right-panel-collapsed"}`}
      >
        <AppWorkspaceTopbar bindings={bindings} />
        {route.view === "studio" && (
          <div className="workspace-panel-controls" role="group" aria-label={locale === "zh-CN" ? "三维工作区面板" : "3D workspace panels"}>
            <button
              className="panel-toggle-left"
              type="button"
              aria-pressed={leftPanelOpen}
              aria-label={leftPanelOpen ? "收起场景目录" : "展开场景目录"}
              title={leftPanelOpen ? "收起场景目录" : "展开场景目录"}
              onClick={() => setLeftPanelOpen((value) => {
                const next = !value;
                writeBooleanPreference(STUDIO_LEFT_PANEL_STORAGE_KEY, next);
                return next;
              })}
            >
              {leftPanelOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
            </button>
            <button
              className="panel-toggle-right"
              type="button"
              aria-pressed={rightPanelOpen}
              aria-label={rightPanelOpen ? "收起属性检查器" : "展开属性检查器"}
              title={rightPanelOpen ? "收起属性检查器" : "展开属性检查器"}
              onClick={() => setRightPanelOpen((value) => {
                const next = !value;
                writeBooleanPreference(STUDIO_INSPECTOR_STORAGE_KEY, next);
                return next;
              })}
            >
              {rightPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          </div>
        )}

        <SceneOutlinerPanel
          locale={locale}
          uploading={uploading}
          importOpen={sceneImportOpen}
          organizationOpen={sceneOrganizationOpen}
          rvtConversionMode={rvtConversionMode}
          revitVersion={rvtRevitVersion}
          revitRuntime={revitRuntime}
          query={componentQuery}
          level={componentLevel}
          category={componentCategory}
          facets={componentFacets}
          results={componentResults}
          bindingComponents={bindingComponents}
          selectedComponentId={selectedComponent?.stableId}
          searchActive={componentSearchActive}
          isolationActive={engine?.isIsolationActive() ?? false}
          onOrganizationToggle={() => {
            setSceneOrganizationOpen((value) => !value);
            setSceneImportOpen(false);
          }}
          onImportToggle={() => {
            setSceneImportOpen((value) => !value);
            setSceneOrganizationOpen(false);
          }}
          onImportClose={() => setSceneImportOpen(false)}
          onRvtConversionModeChange={setRvtConversionMode}
          onRevitVersionChange={setRvtRevitVersion}
          onUpload={() => uploadRef.current?.click()}
          onInsertProjectModel={(model) => void loadModel(model)}
          onInsertPrefab={insertIndustrialPrefab}
          onCreateDeviceLayout={createDeviceLayout}
          onConfirmSmartBindings={(mappings) => {
            const merged = mergeConfirmedSceneAssetBindings(sceneAssetBindings, mappings, bindingComponents);
            setSceneAssetBindings(merged.bindings);
            setRevision((value) => value + 1);
            const skipped = merged.skippedCount > 0 ? `，跳过 ${merged.skippedCount} 条已失效对象` : "";
            setMessage(`已确认 ${merged.confirmedCount} 条设备映射${skipped}；保存场景后生效`);
          }}
          onQueryChange={setComponentQuery}
          onLevelChange={setComponentLevel}
          onCategoryChange={setComponentCategory}
          onResultFocus={focusComponent}
          onResultsIsolate={() => {
            engine?.isolateComponents(componentResults);
            setRevision((value) => value + 1);
          }}
          onIsolationRestore={() => {
            engine?.clearIsolation();
            setRevision((value) => value + 1);
          }}
          organizationContent={
            <>
              <SceneSimulationEntitiesSection
                locale={locale}
                entities={activeScene?.simulationEntities}
                selectedId={selectedSimulationEntityId}
                onSelect={setSelectedSimulationEntityId}
                brokenModelIds={brokenSimulationModelIds}
              />
              <SceneOrganizationPanel
              locale={locale}
              objects={sceneOrganizationObjects}
              selectedIds={sceneOrganizationSelection}
              selectionSets={selectionSets}
              lastDeletedSelectionSet={lastDeletedSelectionSet}
              isolationActive={engine?.isIsolationActive() ?? false}
              onClose={() => setSceneOrganizationOpen(false)}
              onToggle={toggleSceneOrganizationObject}
              onSelect={replaceSceneOrganizationSelection}
              onShow={setSceneObjectsVisible}
              onLock={setSceneObjectsLocked}
              onIsolate={isolateSceneObjects}
              onRestoreIsolation={restoreSceneObjectIsolation}
              onCreateSelectionSet={createSceneSelectionSet}
              onCreateGroup={createSceneGroup}
              onMoveObjects={moveSceneObjectsToGroup}
              onReorderGroup={reorderSceneGroup}
              onRenameGroup={renameSceneGroup}
              onUpdateSelectionSet={updateSceneSelectionSet}
              onApplySelectionSet={applySceneSelectionSet}
              onDeleteSelectionSet={deleteSceneSelectionSet}
              onRestoreDeletedSelectionSet={restoreDeletedSceneSelectionSet}
              />
            </>
          }
          objectContent={
            <FlatSceneObjectList
              locale={locale}
              studio={route.view === "studio"}
              engine={engine}
              modelRows={project?.models.map((model) => (
                <ModelTreeItem
                  key={model.id}
                  locale={locale}
                  model={model}
                  loaded={loadedModels.find((item) => item.id === model.id)}
                  tree={loadedModels.find((item) => item.id === model.id) ? engine?.getLayerTree(model.id) : undefined}
                  expanded={expandedModels.has(model.id)}
                  modelFloors={floorStatesByModel.get(model.id) ?? []}
                  floorExpansion={floorExpansionByModel[model.id] ?? 0}
                  selectedModelId={selected?.id}
                  selectedLayerId={selectedLayerId}
                  engine={engine}
                  onToggleTree={() => toggleModelTree(model.id)}
                  onLoadModel={() => void loadModel(model)}
                  onSetRevision={() => setRevision((value) => value + 1)}
                  onExpandFloors={(value) => expandFloors(model.id, value)}
                  onUpdateFloor={updateFloor}
                  onRemoveObjectInteractions={removeObjectInteractions}
                  onSetMessage={setMessage}
                  onDeleteModel={() => void deleteModel(model)}
                />
              ))}
              empty={
                !project?.models.length &&
                scenePrimitives.length === 0 &&
                measurements.length === 0 &&
                annotations.length === 0 &&
                spaces.length === 0
              }
              lighting={lighting}
              selectedLightId={selectedLightId}
              selectedObjectId={selected?.id}
              primitives={scenePrimitives}
              measurements={measurements}
              annotations={annotations}
              selectedAnnotationId={selectedAnnotationId}
              spaces={spaces}
              onRevision={() => setRevision((value) => value + 1)}
              onEmptyImport={() => {
                setSceneImportOpen(true);
                setSceneOrganizationOpen(false);
              }}
              onEmptyCreateBox={() => beginPrimitivePlacement("box")}
              onLightSelect={setSelectedLightId}
              onLightUpdate={updateLight}
              onLightTransform={selectLightForTransform}
              onLightRemove={removeLight}
              onEnvironmentOpen={() => setEnvironmentOpen(true)}
              onPrimitiveRemove={deletePrimitive}
              onMeasurementRemove={deleteMeasurement}
              onAnnotationUpdate={updateAnnotation}
              onAnnotationRemove={deleteAnnotation}
              onSpaceFocus={(space) => {
                const focused = engine?.focusSpace(space) ?? false;
                if (focused) {
                  setSelectedSpace(space);
                  setNavigationMode("orbit");
                  setAnimationPlaying(false);
                  setMessage(`已定位空间“${space.number ? `${space.number} ` : ""}${space.name}”`);
                } else setMessage(`空间“${space.name}”缺少有效边界，无法定位`);
                setRevision((value) => value + 1);
              }}
              onSpaceVisibilityChange={(space, visible) => {
                const changed = engine?.setSpaceVisible(space, visible) ?? false;
                setMessage(changed ? `${visible ? "显示" : "隐藏"}空间“${space.name}”` : `空间“${space.name}”缺少有效边界`);
                setRevision((value) => value + 1);
              }}
            />
          }
          projectAssets={project?.assets ?? []}
          projectModels={project?.models ?? []}
        />

        <AppStudioViewport controller={controller} />

        <AppStudioInspector controller={controller} />

      </div>
      <input ref={uploadRef} hidden multiple type="file" accept={ACCEPTED_MODELS} onChange={(event) => void uploadModels(event.target.files ?? undefined)} />
      <input ref={importRef} hidden type="file" accept=".json,.bimscene" onChange={(event) => void importScene(event.target.files?.[0])} />
      <input ref={environmentMapRef} hidden type="file" accept=".hdr,.exr,.jpg,.jpeg,.png,.webp" onChange={(event) => void uploadEnvironmentMap(event.target.files?.[0])} />
      <input
        ref={materialTextureRef}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif"
        onChange={(event) => void uploadMaterialTexture(event.target.files?.[0])}
      />
    </>
  );
}
