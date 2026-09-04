import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { createUpsertTopologyCommand } from "@bim-studio/studio-core";
import { api, setAuthToken } from "../api";
import { openBrowseRoute } from "../appRoute";
import { storeLocale, translate as tr } from "../i18n";
import type { AppViewBindings } from "./appViewBindings";
import { flushPendingBehaviorDraft } from "../behavior/behaviorDraftNavigation";

// 三个完整编辑工作区都不是登录首屏依赖，按路由加载可显著降低初始脚本体积。
const DashboardWorkspace = lazy(() => import("../components/DashboardWorkspace").then((module) => ({ default: module.DashboardWorkspace })));
const SceneManager = lazy(() => import("../components/SceneManager").then((module) => ({ default: module.SceneManager })));
const TopologyEditorPanel = lazy(() => import("../components/TopologyEditorPanel").then((module) => ({ default: module.TopologyEditorPanel })));
const ModelOptimizer = lazy(() => import("../components/ModelOptimizer").then((module) => ({ default: module.ModelOptimizer })));
const DataCenter = lazy(() => import("../components/DataCenter").then((module) => ({ default: module.DataCenter })));
const SystemCenter = lazy(() => import("../components/SystemCenter").then((module) => ({ default: module.SystemCenter })));
const BrandingSettingsPage = lazy(() => import("../components/BrandingSettingsPage").then((module) => ({ default: module.BrandingSettingsPage })));
const VisionCenter = lazy(() => import("../components/VisionCenter").then((module) => ({ default: module.VisionCenter })));
const OperationsCenter = lazy(() => import("../components/OperationsCenter").then((module) => ({ default: module.OperationsCenter })));

export function AppPlatformRoutes({ bindings }: { bindings: AppViewBindings }) {
  const { state, derived, sceneEditor, scenePersistence, applicationRuntime, actions } = bindings;
  const {
    initialPathRef,
    defaultEntryAppliedRef,
    viewportRef,
    uploadRef,
    importRef,
    environmentMapRef,
    materialTextureRef,
    materialTextureKindRef,
    sceneNameCommitRef,
    sceneApplyVersionRef,
    sceneWorkspaceLoadRef,
    rendererSnapshotRef,
    applicationSessionRef,
    activeSceneIdRef,
    pendingSceneFocusRef,
    visionEventCursorRef,
    behaviorManagerRef,
    behaviorCommandQueueRef,
    engine,
    setEngine,
    currentUser,
    setCurrentUser,
    branding,
    setBranding,
    authReady,
    setAuthReady,
    rendererBackend,
    setRendererBackend,
    rendererSwitching,
    setRendererSwitching,
    rendererDiagnosticsOpen,
    setRendererDiagnosticsOpen,
    systemInitialTab,
    setSystemInitialTab,
    studioPublishMode,
    setStudioPublishMode,
    studioPublishPerformance,
    setStudioPublishPerformance,
    studioPublishOpen,
    setStudioPublishOpen,
    studioCloudConfigured,
    setStudioCloudConfigured,
    projects,
    setProjects,
    project,
    setProject,
    scenes,
    setScenes,
    managerApplications,
    setManagerApplications,
    activeScene,
    setActiveScene,
    applicationRevision,
    setApplicationRevision,
    sceneName,
    setSceneName,
    selected,
    setSelected,
    measurements,
    setMeasurements,
    revision,
    setRevision,
    uploading,
    setUploading,
    rvtConversionMode,
    setRvtConversionMode,
    revitRuntime,
    setRevitRuntime,
    rvtRevitVersion,
    setRvtRevitVersion,
    busy,
    setBusy,
    viewerLoadState,
    setViewerLoadState,
    autoSaveEnabled,
    setAutoSaveEnabled,
    lastAutoSavedSceneRevisionRef,
    message,
    setMessage,
    error,
    setError,
    measureEnabled,
    setMeasureEnabled,
    annotationEnabled,
    setAnnotationEnabled,
    annotations,
    setAnnotations,
    selectedAnnotationId,
    setSelectedAnnotationId,
    selectedSpace,
    setSelectedSpace,
    transformMode,
    setTransformMode,
    selectionScope,
    setSelectionScope,
    navigationMode,
    setNavigationMode,
    navigationDiagnostics,
    setNavigationDiagnostics,
    measureMode,
    setMeasureMode,
    route,
    setRoute,
    dataReturnRouteRef,
    viewerRouteActive,
    applicationState,
    activeApplication,
    activeDashboardPage,
    activeTopology,
    topologyDataProducts,
    setTopologyDataProducts,
    topologyRuntimeStates,
    setTopologyRuntimeStates,
    avatarVisible,
    setAvatarVisible,
    cameraInfo,
    setCameraInfo,
    pointerInfo,
    setPointerInfo,
    infoEnabled,
    setInfoEnabled,
    frameRate,
    setFrameRate,
    weather,
    setWeather,
    environmentOpen,
    setEnvironmentOpen,
    lighting,
    setLighting,
    sceneEnvironment,
    setSceneEnvironment,
    sceneCoordinates,
    setSceneCoordinates,
    configuredDefaultEnvironment,
    postProcessing,
    setPostProcessing,
    physics,
    setPhysics,
    physicsOpen,
    setPhysicsOpen,
    selectedLightId,
    setSelectedLightId,
    creditsOpen,
    setCreditsOpen,
    digitalTwinOpen,
    setDigitalTwinOpen,
    sceneDataStatus,
    setSceneDataStatus,
    sceneDataReceived,
    setSceneDataReceived,
    aiAssistantOpen,
    setAiAssistantOpen,
    sceneDashboard,
    setSceneDashboard,
    sceneDataBindings,
    setSceneDataBindings,
    sceneDataBindingRuntime,
    setSceneDataBindingRuntime,
    sceneInteractions,
    setSceneInteractions,
    viewerToolsOpen,
    setViewerToolsOpen,
    xrPanelOpen,
    setXrPanelOpen,
    xrActiveMode,
    setXrActiveMode,
    xrCapabilities,
    setXrCapabilities,
    locale,
    setLocale,
    sceneAnimation,
    setSceneAnimation,
    cameraViews,
    setCameraViews,
    cameraConstraints,
    setCameraConstraints,
    navigationSettings,
    setNavigationSettings,
    defaultCameraViewId,
    setDefaultCameraViewId,
    cameraViewsOpen,
    setCameraViewsOpen,
    animationTime,
    setAnimationTime,
    animationPlaying,
    setAnimationPlaying,
    animationOpen,
    setAnimationOpen,
    componentQuery,
    setComponentQuery,
    componentLevel,
    setComponentLevel,
    componentCategory,
    setComponentCategory,
    floorExpansionByModel,
    setFloorExpansionByModel,
    clipping,
    setClippingState,
    expandedModels,
    setExpandedModels,
    sceneOrganizationOpen,
    setSceneOrganizationOpen,
    sceneImportOpen,
    setSceneImportOpen,
    sceneBehaviorOpen,
    setSceneBehaviorOpen,
    sceneBehaviorActive,
    setSceneBehaviorActive,
    sceneBehaviorPaused,
    setSceneBehaviorPaused,
    sceneBehaviorEntries,
    setSceneBehaviorEntries,
    sceneBehaviorLogs,
    setSceneBehaviorLogs,
    inspectorTab,
    setInspectorTab,
    sceneOrganizationSelection,
    setSceneOrganizationSelection,
    selectionSets,
    setSelectionSets,
    lastDeletedSelectionSet,
    setLastDeletedSelectionSet,
    projectDialogMode,
    setProjectDialogMode,
    newProjectName,
    setNewProjectName,
    newProjectDescription,
    setNewProjectDescription,
    primitiveColors,
    interactionTargetOptions,
    showError,
    rendererDiagnostics,
  } = state;
  const {
    loadedModels,
    loadedModelNames,
    sceneOrganizationObjects,
    behaviorScriptContext,
    behaviorCodeTargets,
    scenePrimitives,
    selectedTransform,
    selectedProjectPosition,
    selectionName,
    selectionVisible,
    selectionOpacity,
    selectionColor,
    selectionMaterial,
    selectedEffects,
    selectedPhysics,
    selectionProperties,
    selectedLayerId,
    selectedComponent,
    selectedBehaviorTarget,
    selectionLocked,
    componentFacets,
    floorStates,
    floorStatesByModel,
    selectedLight,
    componentResults,
    componentSearchActive,
    collisions,
    spaces,
    selectedAnnotation,
    clippingRange,
    clippingSceneBounds,
    explosionFactor,
    explosionMode,
    sceneStatistics,
  } = derived;
  const {
    loadModel,
    uploadModels,
    deleteModel,
    beginPrimitivePlacement,
    deletePrimitive,
    removeObjectInteractions,
    deleteMeasurement,
    toggleAnnotationPlacement,
    updateAnnotation,
    updateAnnotationPosition,
    deleteAnnotation,
    changeNavigation,
    changeTransform,
    toggleMeasurement,
    changeMeasureMode,
    focusComponent,
    updateClipping,
    changeClippingMode,
    updateClippingBox,
    toggleClipping,
    updateExplosion,
    updateSelectedTransform,
    changeWeather,
    changeLighting,
    changeSceneEnvironment,
    changePostProcessing,
    changePhysics,
    changeSelectedPhysics,
    uploadEnvironmentMap,
    updateLight,
    addLight,
    removeLight,
    updateSelectionMaterial,
    updateSelectedEffects,
    updateSelectionColor,
    updateSelectionOpacity,
    updateSelectionVisibility,
    addCameraView,
    changeCameraConstraints,
    uploadMaterialTexture,
    chooseMaterialTexture,
    changeNavigationSettings,
    updateCameraViewName,
    replaceCameraView,
    removeCameraView,
    updateFloor,
    expandFloors,
    replaceSceneOrganizationSelection,
    toggleSceneOrganizationObject,
    setSceneObjectsVisible,
    setSceneObjectsLocked,
    isolateSceneObjects,
    restoreSceneObjectIsolation,
    createSceneSelectionSet,
    createSceneGroup,
    moveSceneObjectsToGroup,
    reorderSceneGroup,
    renameSceneGroup,
    updateSceneSelectionSet,
    applySceneSelectionSet,
    deleteSceneSelectionSet,
    restoreDeletedSceneSelectionSet,
    selectLightForTransform,
    startXR,
    updateSceneAnimation,
    addCameraKeyframe,
    addModelKeyframe,
    toggleSceneAnimation,
    deleteKeyframe,
  } = sceneEditor;
  const {
    makeSnapshot,
    saveScene,
    browseActiveScene,
    publishActiveScene,
    commitSceneName,
    applyScene,
    ensureApplicationForScene,
    openSceneDashboard,
    openTopologyEditor,
    createScene,
    exportSceneConfig,
    exportSingleFileScene,
    exportGlbScene,
    exportFbxScene,
    importScene,
    deleteScene,
    copyScene,
    renameScene,
    publishScene,
    unpublishScene,
  } = scenePersistence;
  const {
    toggleModelTree,
    dispatchApplicationCommand,
    restoreScenePublication,
    enablePublishedCloudScene,
    createIndustrialShowcase,
    upsertBehaviorScript,
    deleteBehaviorScript,
    runSceneBehaviors,
    pauseResumeSceneBehaviors,
    stopSceneBehaviors,
    dispatchApplicationInteraction,
    updateComponentFromScript,
    dispatchDashboardNodeInteraction,
    dispatchSceneObjectInteraction,
    saveActiveApplication,
    publishActiveApplication,
    changeAutoSave,
    insertActiveTopologyIntoDashboard,
    enterSceneFromDashboard,
    returnFromSceneEditor,
  } = applicationRuntime;
  const {
    navigate,
    openDataCenter,
    closeDataCenter,
    openDocs,
    replaceDashboardView,
    changeRendererBackend,
    switchProjectById,
    openProjectDialog,
    submitProjectDialog,
    deleteCurrentProject,
    refreshProject,
  } = actions;
  if (!currentUser) return null;
  const flushBehaviorDraft = () => {
    const result = flushPendingBehaviorDraft(state.pendingBehaviorDraftRef, upsertBehaviorScript);
    if (result === "name-required") {
      state.setError(tr(locale, "请先填写脚本名称，再离开脚本编辑器", "Enter a script name before leaving the script editor"));
      return false;
    }
    return true;
  };
  const closeBehaviorEditor = () => {
    if (!flushBehaviorDraft()) return;
    setSceneBehaviorOpen(false);
  };
  const leaveDashboardAfterDraft = (action: () => void) => {
    if (!flushBehaviorDraft()) return;
    setSceneBehaviorOpen(false);
    globalThis.setTimeout(() => {
      void (async () => {
        if (activeApplication && !(await saveActiveApplication())) return;
        action();
      })();
    }, 0);
  };
  return (
    <>
      {route.view === "dashboard" && activeApplication && activeDashboardPage && project && (
        <Suspense fallback={<PlatformRouteLoading label={tr(locale, "正在加载二维工作区", "Loading 2D workspace")} />}>
          <DashboardWorkspace
          locale={locale}
          application={activeApplication}
          project={project}
          page={activeDashboardPage}
          rendererBackend={rendererBackend}
          {...(route.dashboardView ? { initialView: route.dashboardView } : {})}
          dirty={applicationState.dirty}
          canUndo={applicationState.canUndo}
          canRedo={applicationState.canRedo}
          busy={busy}
          autoSaveEnabled={autoSaveEnabled}
          selection={applicationState.selection}
          variables={applicationState.variables}
          filters={applicationState.filters}
          onBack={() => leaveDashboardAfterDraft(() => navigate({ view: "manager" }))}
          onSelectPage={(pageId, view) =>
            navigate({
              view: "dashboard",
              projectId: activeApplication.metadata.projectId,
              applicationId: activeApplication.metadata.id,
              pageId,
              dashboardView: { ...view, selectedNodeIds: [] },
            })
          }
          onEnterScene={enterSceneFromDashboard}
          onOpen3D={(sceneId, view) => leaveDashboardAfterDraft(() => enterSceneFromDashboard(sceneId, view))}
          onOpenTopology={() => void openTopologyEditor(activeApplication)}
          onOpenData={openDataCenter}
          onOpenScripts={(selection) => {
            applicationSessionRef.current.store.setSelection(selection);
            setSceneBehaviorOpen(true);
          }}
          scriptOpen={sceneBehaviorOpen}
          onCloseScripts={closeBehaviorEditor}
          onSelectionChange={(selection) => applicationSessionRef.current.store.setSelection(selection)}
          onFilterChange={(key, value) => applicationSessionRef.current.store.setFilter(key, value)}
          onVariableChange={(key, value) => applicationSessionRef.current.store.setVariable(key, value)}
          onObjectInteraction={dispatchSceneObjectInteraction}
          onNodeInteraction={dispatchDashboardNodeInteraction}
          onCommand={dispatchApplicationCommand}
          onUndo={() => applicationSessionRef.current.store.undo()}
          onRedo={() => applicationSessionRef.current.store.redo()}
          onSave={() => void saveActiveApplication()}
          onAutoSaveChange={changeAutoSave}
          onPublish={() => void publishActiveApplication()}
          onViewStateChange={replaceDashboardView}
          />
        </Suspense>
      )}
      {route.view === "dashboard" && (!activeApplication || !activeDashboardPage || !project) && (
        <div className="optimizer-loading">
          {" "}
          <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载二维工作区", "Loading 2D workspace")}{" "}
        </div>
      )}
      {route.view === "topology" && activeTopology && (
        <Suspense fallback={<PlatformRouteLoading label={tr(locale, "正在加载拓扑编辑器", "Loading topology editor")} />}>
          <TopologyEditorPanel
          locale={locale}
          document={activeTopology}
          dataProducts={topologyDataProducts}
          runtimeStates={topologyRuntimeStates}
          onAcknowledgeAlarm={(nodeId, alarm) => {
            const state = topologyRuntimeStates[nodeId];
            if (!state?.alarm?.active || state.alarm.id !== alarm.id) throw new Error("告警已恢复或发生变化，请刷新后重试");
            setTopologyRuntimeStates((current) => ({
              ...current,
              [nodeId]: { ...state, alarm: { ...state.alarm!, acknowledged: true, acknowledgedAt: new Date().toISOString(), acknowledgedBy: currentUser.displayName } },
            }));
          }}
          onChange={(topology) => dispatchApplicationCommand(createUpsertTopologyCommand(topology))}
          dirty={applicationState.dirty}
          busy={busy}
          autoSaveEnabled={autoSaveEnabled}
          onAutoSaveChange={changeAutoSave}
          onSave={() => void saveActiveApplication()}
          onPublish={() => void publishActiveApplication()}
          onInsertDashboard={insertActiveTopologyIntoDashboard}
          onClose={() =>
            void saveActiveApplication().then((saved) => {
              if (saved) navigate({ view: "manager" });
            })
          }
          onError={(message) => showError(new Error(message))}
          />
        </Suspense>
      )}
      {route.view === "topology" && !activeTopology && (
        <div className="optimizer-loading">
          {" "}
          <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载拓扑编辑器", "Loading topology editor")}{" "}
        </div>
      )}
      {route.view === "optimizer" && (
        <Suspense
          fallback={
            <div className="optimizer-loading">
              {" "}
              <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载模型优化器", "Loading model optimizer")}{" "}
            </div>
          }
        >
          <ModelOptimizer
            locale={locale}
            project={project}
            onProjectChange={(current) => {
              setProject(current);
              setProjects((items) => items.map((item) => (item.id === current.id ? current : item)));
            }}
            onBack={() => navigate({ view: "manager" })}
          />
        </Suspense>
      )}
      {route.view === "data" && project && (
        <Suspense
          fallback={
            <div className="optimizer-loading">
              {" "}
              <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载数据中心", "Loading data center")}{" "}
            </div>
          }
        >
          <DataCenter locale={locale} project={project} onBack={closeDataCenter} />
        </Suspense>
      )}
      {route.view === "vision" && project && (
        <Suspense
          fallback={
            <div className="optimizer-loading">
              {" "}
              <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载视觉中心", "Loading vision center")}{" "}
            </div>
          }
        >
          <VisionCenter locale={locale} project={project} scenes={scenes} onBack={() => navigate({ view: "manager" })} />
        </Suspense>
      )}
      {route.view === "operations" && project && (
        <Suspense
          fallback={
            <div className="optimizer-loading">
              {" "}
              <LoaderCircle className="spin" size={25} /> 正在加载智能运营{" "}
            </div>
          }
        >
          <OperationsCenter
            project={project}
            scenes={scenes}
            onOpenDataCenter={() => navigate({ view: "data" })}
            {...(route.operationsTab ? { initialTab: route.operationsTab } : {})}
            onTabChange={(tab) => navigate({ view: "operations", operationsTab: tab }, true)}
            onBack={() => navigate({ view: "manager" })}
            onOpenSceneTarget={(sceneId, objectId) => {
              const targetScene = scenes.find((scene) => scene.id === sceneId);
              if (!targetScene) {
                showError(new Error("映射的三维场景已不存在"));
                return;
              }
              const targetLabel = targetScene.models.find((item) => item.modelId === objectId)?.name ?? targetScene.primitives.find((item) => item.modelId === objectId)?.name;
              pendingSceneFocusRef.current = { sceneId, objectId, ...(targetLabel ? { label: targetLabel } : {}) };
              setActiveScene(undefined);
              navigate({ view: "studio", sceneId });
            }}
          />
        </Suspense>
      )}
      {route.view === "system" && currentUser.role === "admin" && (
        <Suspense
          fallback={
            <div className="optimizer-loading">
              {" "}
              <LoaderCircle className="spin" size={25} /> 正在加载设置{" "}
            </div>
          }
        >
          <SystemCenter locale={locale} currentUser={currentUser} projects={projects} initialTab={systemInitialTab} onBack={() => navigate({ view: "manager" })} />
        </Suspense>
      )}
      {route.view === "branding" && currentUser.role === "admin" && (
        <Suspense
          fallback={
            <div className="optimizer-loading">
              {" "}
              <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载全局设置", "Loading global settings")}{" "}
            </div>
          }
        >
          <BrandingSettingsPage locale={locale} value={branding} onChange={setBranding} onBack={() => navigate({ view: "manager" })} />
        </Suspense>
      )}
      {route.view === "manager" && (
        <Suspense fallback={<PlatformRouteLoading label={tr(locale, "正在加载项目工作台", "Loading project workspace")} />}>
          <SceneManager
          locale={locale}
          branding={branding}
          projects={projects}
           project={project}
           scenes={scenes}
           applications={managerApplications}
          topologies={managerApplications.flatMap((application) =>
            application.topologies.map((topology) => ({ applicationId: application.metadata.id, applicationName: application.metadata.name, topology })),
          )}
          userName={currentUser.displayName}
          isAdmin={currentUser.role === "admin"}
          onProjectChange={switchProjectById}
          onCreateProject={() => openProjectDialog("create")}
          onRenameProject={() => openProjectDialog("rename")}
          onDeleteProject={() => void deleteCurrentProject()}
          onCreate={async (name) => {
            try {
              await createScene(name);
            } catch (reason) {
              showError(reason);
            }
          }}
          onCreateShowcase={createIndustrialShowcase}
          showcaseExists={managerApplications.some(
            (application) =>
              application.metadata.name === "智造园区综合案例" &&
              application.data.variables.some((variable) => variable.id === "showcase.seed" && variable.value === "industrial-v1"),
          )}
          onOpen={async (scene) => {
            setActiveScene(undefined);
            await openSceneDashboard(scene);
          }}
          onOpenBehavior={async (scene) => {
            setActiveScene(undefined);
            await openSceneDashboard(scene);
            setSceneBehaviorOpen(true);
          }}
          onOpenSimulation={async (scene) => {
            setActiveScene(undefined);
            await openSceneDashboard(scene);
            setPhysicsOpen(true);
            setAnimationOpen(true);
          }}
          onCopy={copyScene}
          onRename={renameScene}
          onPublish={publishScene}
          onUnpublish={unpublishScene}
          onRestorePublication={restoreScenePublication}
          onBrowse={(scene) => openBrowseRoute("view", scene.id)}
          onBrowsePublished={(scene) => openBrowseRoute("published", scene.id)}
          onImport={() => importRef.current?.click()}
          onExportLoose={exportSceneConfig}
          onExportSingle={exportSingleFileScene}
          onExportGlb={exportGlbScene}
          onExportFbx={exportFbxScene}
          onDelete={deleteScene}
          onOptimizer={() => navigate({ view: "optimizer" })}
          onDataCenter={openDataCenter}
          onCreateTopology={() => void openTopologyEditor(managerApplications[0], undefined, true)}
          onOpenTopology={(applicationId, topologyId) => {
            const application = managerApplications.find((candidate) => candidate.metadata.id === applicationId);
            void openTopologyEditor(application, topologyId);
          }}
          onVisionCenter={() => navigate({ view: "vision" })}
          onOperationsCenter={() => navigate({ view: "operations" })}
          onAiAssistant={() => setAiAssistantOpen(true)}
          onDocs={() => openDocs()}
          onSystem={() => {
            setSystemInitialTab("users");
            navigate({ view: "system" });
          }}
          onCloudRender={() => {
            setSystemInitialTab("cloud-render");
            navigate({ view: "system" });
          }}
          onLocaleToggle={() => {
            const next = locale === "zh-CN" ? "en-US" : "zh-CN";
            setLocale(next);
            storeLocale(next);
          }}
          onConnectionStatus={() => setDigitalTwinOpen((value) => !value)}
          onCredits={() => setCreditsOpen(true)}
          onLogout={() =>
            void api.logout().finally(() => {
              setAuthToken();
              setCurrentUser(undefined);
              setProjects([]);
              setProject(undefined);
            })
          }
          onUploadModels={uploadModels}
          onDeleteModel={deleteModel}
          onRefreshModels={refreshProject}
          />
        </Suspense>
      )}
    </>
  );
}

function PlatformRouteLoading({ label }: { label: string }) {
  return <div className="optimizer-loading"><LoaderCircle className="spin" size={25} /> {label}</div>;
}
