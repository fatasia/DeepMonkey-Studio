import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { selectionDeleteCommand } from "../commands/engineEditCommand";
import { STUDIO_INSPECTOR_STORAGE_KEY, STUDIO_LEFT_PANEL_STORAGE_KEY } from "../appDefaults";
import { ModelImportInput } from "../components/ModelImportInput";
import { UploadedResourceThumbnails } from "../components/UploadedResourceThumbnails";
import type { ModelRecord } from "@bim-studio/contracts";
import { readBooleanPreference, writeBooleanPreference } from "../hooks/usePersistedBooleanState";
import { translate as tr } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { FlatSceneObjectList } from "../components/FlatSceneObjectList";
import { useLayerRenameFocus } from "../components/useLayerRenameFocus";
import { useSceneAssetNavigation } from "../optimizer/useSceneAssetNavigation";
import { modelAssetOptimizerRoute } from "../optimizer/modelAssetNavigation";
import { ModelTreeItem } from "../components/ModelTreeItem";
import { ModelDiffReviewPanel } from "../components/ModelDiffReviewPanel";
import { SceneModelInstanceDialog } from "../components/SceneModelInstanceDialog";
import { useSceneModelInstances } from "../hooks/useSceneModelInstances";
import { sceneModelRows } from "../controllers/sceneModelRows";
import { SceneSelectionBar } from "../components/SceneSelectionBar";
import { AppSimulationInspector } from "./AppSimulationInspector";
import { simulationEntityModelIds } from "../controllers/sceneSimulationController";
import { SceneSimulationEntitiesSection } from "../components/SceneSimulationEntitiesSection";
import { SceneOutlinerPanel } from "../components/SceneOutlinerPanel";
import { AppWorkspaceTopbar } from "./AppWorkspaceTopbar";
import { mergeConfirmedSceneAssetBindings } from "../studio/sceneAssetBindings";
import type { AppStudioController } from "./AppStudioShell";
import { AppStudioInspector } from "./AppStudioInspector";
import { AppStudioViewport } from "./AppStudioViewport";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { ApplyUserPrefabUpdateDialog, SaveUserPrefabDialog } from "../components/UserPrefabDialogs";
import { buildUserPrefabTreeMarks } from "../prefabs/userPrefabModel";
import { useMemo } from "react";
import "../styles/workspacePanelAnchors.css";

export function AppStudioShellView({ controller }: { controller: AppStudioController }) {
  const focusRename = useLayerRenameFocus("scene");
  const assetWorkflow = useSceneAssetNavigation(controller.bindings);
  const instances = useSceneModelInstances(controller.bindings);
  // 三维视口是核心工作区，资源树和属性检查器按需收起，避免遮挡模型。
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => readBooleanPreference(STUDIO_LEFT_PANEL_STORAGE_KEY, true));
  const [rightPanelOpen, setRightPanelOpen] = useState(() => readBooleanPreference(STUDIO_INSPECTOR_STORAGE_KEY, true));
  const [sceneWorkflow, setSceneWorkflow] = useState<"device-layout" | "smart-binding" | "model-diff" | null>(null);
  const [uploadedImportModels, setUploadedImportModels] = useState<ModelRecord[] | null>(null);
  // Resource-panel gestures can arrive in the short window between canvas
  // mount and ViewerEngine creation. Keep the user action instead of silently
  // dropping it when the controller is not ready yet.
  const pendingProjectModelInsertsRef = useRef<ModelRecord[]>([]);
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
    moveSceneObjectsToGroup,
    moveSceneRootEntries,
    deleteSceneSelectionSet,
    defaultCameraViewId,
    deleteAnnotation,
    deleteKeyframe,
    deleteMeasurement,
    deleteModel,
    deletePrimitive,
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
    playModeActive,
    exitPlayMode,
    pointerInfo,
    postProcessing,
    project,
    refreshProject,
    renameSceneGroup,
    removeCameraView,
    removeLight,
    removeObjectInteractions,
    rendererBackend,
    rendererSwitching,
    replaceCameraView,
    replaceSceneOrganizationSelection,
    selectSceneOrganizationObject,
    restoreSceneObjectIsolation,
    revitRuntime,
    revision,
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
    rootLayerOrder,
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
    showError,
    spaces,
    startXR,
    toggleAnnotationPlacement,
    toggleClipping,
    toggleMeasurement,
    toggleModelTree,
    toggleSceneAnimation,
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
  const uploadedImportEscapeRef = useDialogEscape(() => setUploadedImportModels(null), busy);
  // T0 刀 2：用户组合预制体（存为预制体 / 实例化 / 应用更新 diff / 覆盖）。
  const { userPrefab, userPrefabs, userPrefabInstances } = controller;
  const [savePrefabOpen, setSavePrefabOpen] = useState(false);
  const [applyPrefabInstanceId, setApplyPrefabInstanceId] = useState<string>();
  const prefabTreeMarks = useMemo(() => buildUserPrefabTreeMarks(userPrefabInstances, userPrefabs), [userPrefabInstances, userPrefabs]);
  const applyPrefabDiff = useMemo(
    () => (applyPrefabInstanceId ? userPrefab.diffUserPrefabInstance(applyPrefabInstanceId) : undefined),
    // revision 变化（实例应用/成员编辑）后重算，保证预览与场景事实一致。
    [applyPrefabInstanceId, revision, userPrefab], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const instanceIdByMemberId = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of userPrefabInstances) for (const objectId of Object.values(record.memberObjectIds)) map.set(objectId, record.instanceId);
    return map;
  }, [userPrefabInstances]);
  const insertUserPrefab = (prefabId: string) => {
    userPrefab.instantiateUserPrefab(prefabId).catch(showError);
  };
  const runPrefabRowAction = (objectId: string, action: "apply-update" | "refresh-overrides" | "reset-member" | "update-prototype") => {
    const instanceId = instanceIdByMemberId.get(objectId);
    if (!instanceId) return;
    const record = userPrefabInstances.find((item) => item.instanceId === instanceId);
    if (!record) return;
    if (action === "apply-update") {
      if (!userPrefab.diffUserPrefabInstance(instanceId)) {
        setMessage(tr(locale, "该实例已是最新版本，无需应用更新", "This instance is already up to date"));
        return;
      }
      setApplyPrefabInstanceId(instanceId);
    } else if (action === "update-prototype") userPrefab.updateUserPrefabFromInstance(record.prefabId, instanceId);
    else if (action === "refresh-overrides") userPrefab.refreshUserPrefabOverrides(instanceId);
    else userPrefab.resetUserPrefabMember(instanceId, objectId);
  };
  const openImportModelPicker = () => {
    setSceneImportOpen(false);
    setSceneWorkflow(null);
    uploadRef.current?.click();
  };
  const openRvtImportSettings = () => {
    setSceneImportOpen(true);
    setSceneWorkflow(null);
  };
  const insertUploadedModels = async () => {
    const models = uploadedImportModels;
    if (!models?.length) return;
    setUploadedImportModels(null);
    const occupiedAssetIds = new Set(loadedModels.map((item) => item.assetModelId ?? item.id));
    for (const model of models) {
      const instanceId = occupiedAssetIds.has(model.id) ? crypto.randomUUID() : model.id;
      occupiedAssetIds.add(model.id);
      await loadModel(model, false, instanceId);
    }
  };
  const insertProjectModel = (model: ModelRecord) => {
    if (!engine) {
      if (!pendingProjectModelInsertsRef.current.some((item) => item.id === model.id)) {
        pendingProjectModelInsertsRef.current.push(model);
      }
      return;
    }
    void loadModel(model, false, loadedModels.some((item) => (item.assetModelId ?? item.id) === model.id) ? crypto.randomUUID() : model.id);
  };
  useEffect(() => {
    if (!engine || pendingProjectModelInsertsRef.current.length === 0) return;
    const pending = pendingProjectModelInsertsRef.current.splice(0);
    const occupiedAssetIds = new Set(loadedModels.map((item) => item.assetModelId ?? item.id));
    for (const model of pending) {
      const instanceId = occupiedAssetIds.has(model.id) ? crypto.randomUUID() : model.id;
      occupiedAssetIds.add(model.id);
      void loadModel(model, false, instanceId);
    }
  }, [engine, loadModel, loadedModels]);
  const optimizeUploadedModels = () => {
    const firstModel = uploadedImportModels?.[0];
    if (!firstModel) return;
    setUploadedImportModels(null);
    const assetReturn = route.assetReturn ?? (activeScene ? {
      sceneId: activeScene.id,
      ...(route.applicationId ? { applicationId: route.applicationId } : {}),
    } : undefined);
    bindings.actions.navigate(modelAssetOptimizerRoute(project?.id, firstModel.id, assetReturn));
  };

  // SIM-1a 断链集合：仿真实体引用了已删除模型时在场景树黄牌标注（不静默失效）。
  const brokenSimulationModelIds = new Set<string>();
  for (const entity of activeScene?.simulationEntities ?? []) {
    const referenced = simulationEntityModelIds(entity);
    for (const modelId of referenced) {
      if (!loadedModels.some((model) => model.id === modelId)) brokenSimulationModelIds.add(modelId);
    }
  }

  useEffect(() => setSelectedSimulationEntityId(undefined), [activeScene?.id]);
  useEffect(() => {
    if (selected || selectedAnnotationId || selectedSpace || selectedLightId) setSelectedSimulationEntityId(undefined);
  }, [selected, selectedAnnotationId, selectedSpace, selectedLightId]);

  const simulationEntity = activeScene?.simulationEntities?.find((item) => item.id === selectedSimulationEntityId);
  const simulationTree = <SceneSimulationEntitiesSection
    locale={locale} entities={activeScene?.simulationEntities} selectedId={selectedSimulationEntityId}
    brokenModelIds={brokenSimulationModelIds}
    onSelect={(id) => {
      engine?.select(undefined);
      setSelectedSpace(undefined);
      setSelectedLightId("");
      setSelectedSimulationEntityId(id);
      if (id) setRightPanelOpen(true);
    }}
  />;
  const selectedSceneObjects = sceneOrganizationObjects.filter((item) => sceneOrganizationSelection.has(item.id));
  const selectedCollisionEnabled = selectedSceneObjects.length > 0 && selectedSceneObjects.every((item) => engine?.isCollisionEnabled(item.id));

  useEffect(() => {
    const splitActive = sceneBehaviorOpen && sceneBehaviorLayout === "split";
    if (splitActive) {
      if (panelsBeforeBehaviorSplitRef.current) return;
      panelsBeforeBehaviorSplitRef.current = { left: leftPanelOpen, right: rightPanelOpen };
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

  return (
    <>
      <div
        className={`app-shell ${route.view === "view" || route.view === "published" ? "viewer-shell" : ""} ${route.view === "studio" || route.view === "view" || route.view === "published" ? "" : "app-shell-hidden"}${leftPanelOpen ? "" : " left-panel-collapsed"}${rightPanelOpen ? "" : " right-panel-collapsed"}`}
      >
        <AppWorkspaceTopbar
          bindings={bindings}
          tools={{
            onImportModel: openImportModelPicker,
            onDeviceLayout: () => setSceneWorkflow("device-layout"),
            onSmartBinding: () => setSceneWorkflow("smart-binding"),
            onModelDiff: () => setSceneWorkflow("model-diff"),
            onRvtImportSettings: openRvtImportSettings,
          }}
        />
        {/* F11：播放模式常驻警示条(Unity Play 醒目提示口径)——编辑产物为临时态,退出整体恢复。 */}
        {route.view === "studio" && playModeActive && (
          <div className="play-mode-banner" role="status">
            <Play size={14} fill="currentColor" />
            <span>{tr(locale, "播放模式：场景修改为临时态，退出播放将恢复进入前场景", "Play mode: edits are temporary; exiting Play restores the scene")}</span>
            <button type="button" onClick={() => void (exitPlayMode?.() ?? Promise.resolve())}>
              <Square size={12} fill="currentColor" />
              {tr(locale, "退出播放", "Stop Play")}
            </button>
          </div>
        )}
        {route.view === "studio" && (
          <div className="workspace-panel-controls" role="group" aria-label={locale === "zh-CN" ? "三维工作区面板" : "3D workspace panels"}>
            <button
              className="panel-toggle-left"
              type="button"
              aria-pressed={leftPanelOpen}
              aria-label={leftPanelOpen ? "收起场景目录" : "展开场景目录"}
              title={leftPanelOpen ? "收起场景目录" : "展开场景目录"}
              onClick={() => {
                const next = !leftPanelOpen;
                if (next && sceneBehaviorOpen && sceneBehaviorLayout === "split") setRightPanelOpen(false);
                writeBooleanPreference(STUDIO_LEFT_PANEL_STORAGE_KEY, next);
                setLeftPanelOpen(next);
              }}
            >
              {leftPanelOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
            </button>
            <button
              className="panel-toggle-right"
              type="button"
              aria-pressed={rightPanelOpen}
              aria-label={rightPanelOpen ? "收起属性检查器" : "展开属性检查器"}
              title={rightPanelOpen ? "收起属性检查器" : "展开属性检查器"}
              onClick={() => {
                const next = !rightPanelOpen;
                if (next && sceneBehaviorOpen && sceneBehaviorLayout === "split") setLeftPanelOpen(false);
                writeBooleanPreference(STUDIO_INSPECTOR_STORAGE_KEY, next);
                setRightPanelOpen(next);
              }}
            >
              {rightPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          </div>
        )}

        <SceneOutlinerPanel
          locale={locale}
          {...(project ? { projectId: project.id } : {})}
          onLibraryImported={refreshProject}
          uploading={uploading}
          importDisabled={playModeActive}
          importOpen={sceneImportOpen}
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
          onImportClose={() => setSceneImportOpen(false)}
          activeWorkflow={sceneWorkflow}
          onImportModel={openImportModelPicker}
          onWorkflowClose={() => setSceneWorkflow(null)}
          onRvtConversionModeChange={setRvtConversionMode}
          onRevitVersionChange={setRvtRevitVersion}
          onInsertProjectModel={insertProjectModel}
          onInsertPrefab={insertIndustrialPrefab}
          userPrefabs={userPrefabs}
          onInsertUserPrefab={insertUserPrefab}
          onDeleteUserPrefab={(id) => userPrefab.deleteUserPrefab(id)}
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
          objectContent={
            <>
            {simulationTree}
            <SceneSelectionBar
              locale={locale}
              editingDisabled={playModeActive}
              selectedObjects={selectedSceneObjects}
              onGroup={() => createSceneGroup("")}
              onSaveAsPrefab={() => setSavePrefabOpen(true)}
              onShow={(visible) => setSceneObjectsVisible([...sceneOrganizationSelection], visible)}
              onLock={() => setSceneObjectsLocked([...sceneOrganizationSelection], true)}
              onUnlock={() => setSceneObjectsLocked([...sceneOrganizationSelection], false)}
              onIsolate={() => isolateSceneObjects([...sceneOrganizationSelection])}
              onRestoreIsolation={restoreSceneObjectIsolation}
              isolationActive={engine?.isIsolationActive() ?? false}
              collisionEnabled={selectedCollisionEnabled}
              onCollision={(enabled) => {
                for (const { id } of selectedSceneObjects) engine?.setCollisionEnabled(id, enabled);
                setRevision((value) => value + 1);
                setMessage(tr(locale, `${enabled ? "开启" : "关闭"}了 ${selectedSceneObjects.length} 个对象的碰撞检测`, `${enabled ? "Enabled" : "Disabled"} collision for ${selectedSceneObjects.length} objects`));
              }}
              onClear={() => replaceSceneOrganizationSelection([])}
            />
            <FlatSceneObjectList
              locale={locale}
              studio={route.view === "studio"}
              engine={engine}
              modelRows={sceneModelRows(project?.models ?? [], loadedModels).map(({ rowKey, asset, model, loaded }) => ({
                key: rowKey,
                keepMounted: expandedModels.has(model.id),
                render: () => (
                <ModelTreeItem
                  key={rowKey}
                  locale={locale}
                  model={model}
                  loaded={loaded}
                  editingDisabled={playModeActive}
                  tree={loaded && expandedModels.has(model.id) ? engine?.getLayerTree(model.id) : undefined}
                  expanded={expandedModels.has(model.id)}
                  modelFloors={floorStatesByModel.get(model.id) ?? []}
                  floorExpansion={floorExpansionByModel[model.id] ?? 0}
                  selectedModelId={selected?.id}
                  selectedInBatch={sceneOrganizationSelection.has(model.id)}
                  selectedLayerId={selectedLayerId}
                  engine={engine}
                  onToggleTree={() => toggleModelTree(model.id)}
                  onSelectObject={selectSceneOrganizationObject}
                  onLoadModel={() => void loadModel(asset)}
                  onOptimize={() => assetWorkflow.optimize(asset, model.id)}
                  onInstanceActions={() => instances.open(model.id)}
                  optimizing={busy || assetWorkflow.leaving}
                  onSetRevision={() => setRevision((value) => value + 1)}
                  onExpandFloors={(value) => expandFloors(model.id, value)}
                  onUpdateFloor={updateFloor}
                  onRemoveObjectInteractions={removeObjectInteractions}
                  onSetMessage={setMessage}
                  onDeleteModel={() => loaded ? instances.remove(model.id) : void deleteModel(asset)}
                  prefabMark={loaded && prefabTreeMarks.members.has(loaded.id) ? { overridden: prefabTreeMarks.overridden.has(loaded.id), pending: prefabTreeMarks.pending.has(loaded.id) } : undefined}
                />
              )}))}
              empty={
                loadedModels.every((item) => item.kind !== "model") &&
                scenePrimitives.length === 0 &&
                measurements.length === 0 &&
                annotations.length === 0 &&
                spaces.length === 0
              }
              lighting={lighting}
              selectedLightId={selectedLightId}
              selectedObjectId={selected?.id}
              selectedObjectIds={sceneOrganizationSelection}
              selectedLayerId={selectedLayerId}
              primitives={scenePrimitives}
              measurements={measurements}
              annotations={annotations}
              selectedAnnotationId={selectedAnnotationId}
              spaces={spaces}
              groups={selectionSets}
              rootLayerOrder={rootLayerOrder}
              organizationObjects={sceneOrganizationObjects}
              onRevision={() => setRevision((value) => value + 1)}
              onObjectSelect={selectSceneOrganizationObject}
              onObjectRename={(id, layerId) => focusRename(JSON.stringify([id, layerId && layerId !== "root" ? layerId : null]), () => {
                if (layerId) engine?.selectLayer(id, layerId); else selectSceneOrganizationObject(id);
                setInspectorTab("overview"); setRightPanelOpen(true);
              })}
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
              prefabMarks={prefabTreeMarks}
              onPrefabRowAction={runPrefabRowAction}
              onSelectGroup={applySceneSelectionSet}
              onRenameGroup={renameSceneGroup}
              onCreateGroup={ids => createSceneGroup("", ids)}
              onUngroup={deleteSceneSelectionSet}
              onMoveObjects={moveSceneObjectsToGroup}
              onMoveRootEntries={moveSceneRootEntries}
              onGroupVisibilityChange={setSceneObjectsVisible}
              onGroupLockChange={setSceneObjectsLocked}
            />
            </>
          }
          projectAssets={project?.assets ?? []}
          projectModels={project?.models ?? []}
        />

        <AppStudioViewport controller={controller} />

        {simulationEntity
          ? <AppSimulationInspector controller={controller} entity={simulationEntity} onClose={() => setSelectedSimulationEntityId(undefined)} />
          : <AppStudioInspector controller={controller} />}

      </div>
      {instances.selectedId && loadedModels.find(item => item.id === instances.selectedId) && <SceneModelInstanceDialog
        key={instances.selectedId} locale={locale} instance={loadedModels.find(item => item.id === instances.selectedId)!}
        assets={project?.models ?? []} busy={instances.working} locked={engine?.isModelLocked(instances.selectedId) ?? false} error={instances.error}
        onDuplicate={() => void instances.duplicate(instances.selectedId!)} onReplace={asset => void instances.replace(instances.selectedId!, asset)} onClose={instances.close}
      />}
      {savePrefabOpen && <SaveUserPrefabDialog
        locale={locale}
        defaultName={tr(locale, `预制体 ${userPrefabs.length + 1}`, `Prefab ${userPrefabs.length + 1}`)}
        busy={busy}
        onSave={(name, category) => {
          userPrefab.saveSelectionAsPrefab(name, category);
          setSavePrefabOpen(false);
        }}
        onClose={() => setSavePrefabOpen(false)}
      />}
      {applyPrefabInstanceId && applyPrefabDiff && <ApplyUserPrefabUpdateDialog
        locale={locale}
        prefabName={userPrefabs.find((item) => item.id === applyPrefabDiff.prefabId)?.name ?? tr(locale, "预制体", "Prefab")}
        diff={applyPrefabDiff}
        busy={busy}
        onApply={() => {
          const instanceId = applyPrefabInstanceId;
          setApplyPrefabInstanceId(undefined);
          userPrefab.applyUserPrefabUpdate(instanceId).catch(showError);
        }}
        onClose={() => setApplyPrefabInstanceId(undefined)}
      />}
      {sceneWorkflow === "model-diff" && (
        <ModelDiffReviewPanel
          locale={locale}
          engine={engine}
          models={loadedModels}
          onLocate={focusComponent}
          onClose={() => setSceneWorkflow(null)}
        />
      )}
      <ModelImportInput
        inputRef={uploadRef}
        locale={locale}
        scopeKey={project?.id}
        multiple
        rvtSettings={{
          mode: rvtConversionMode,
          revitVersion: rvtRevitVersion,
          runtime: revitRuntime,
          onModeChange: setRvtConversionMode,
          onRevitVersionChange: setRvtRevitVersion,
        }}
        onFiles={async (files, entries) => {
          const models = await uploadModels(files, entries);
          if (models.length) setUploadedImportModels(models);
        }}
      />
      {uploadedImportModels && (
        <div
          className="dialog-backdrop"
          ref={uploadedImportEscapeRef}
          onMouseDown={() => {
            if (!busy) setUploadedImportModels(null);
          }}
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={locale === "zh-CN" ? "选择模型处理方式" : "Choose model handling"}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">{locale === "zh-CN" ? "上传完成" : "UPLOAD COMPLETE"}</span>
            <h2>{locale === "zh-CN" ? "模型已上传" : "Models uploaded"}</h2>
            <p title={uploadedImportModels.map((model) => model.name).join("、")}>
              {locale === "zh-CN"
                ? `${uploadedImportModels.length} 个模型已进入项目。可直接插入当前场景，或先做轻量化优化。`
                : `${uploadedImportModels.length} models are in the project. Insert them into this scene or optimize them first.`}
            </p>
            <UploadedResourceThumbnails key={project?.id} items={uploadedImportModels} locale={locale} onSaved={refreshProject} />
            <div className="dialog-actions">
              <button type="button" className="button" disabled={busy} onClick={() => setUploadedImportModels(null)}>
                {locale === "zh-CN" ? "取消" : "Cancel"}
              </button>
              <button type="button" className="button" disabled={busy} onClick={optimizeUploadedModels}>
                {locale === "zh-CN" ? "进入优化" : "Optimize"}
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={() => void insertUploadedModels()}>
                {locale === "zh-CN" ? (busy ? "正在插入…" : "直接插入") : busy ? "Inserting…" : "Insert"}
              </button>
            </div>
          </section>
        </div>
      )}
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
