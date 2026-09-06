import {
  type GlobalLightingState,
  type SceneEnvironmentState,
  type SceneSnapshot,
} from "@bim-studio/contracts";
import { api } from "../api";
import { normalizeDashboardState } from "../components/dashboardState";
import { normalizeInteractionScripts } from "../interactionState";
import { normalizeNavigationSettings } from "../navigationSettings";
import { normalizeSceneDataBindings } from "../sceneDataBindings";
import {
  DEFAULT_ANIMATION,
  DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_CLIPPING,
  DEFAULT_LIGHTING,
  DEFAULT_PHYSICS,
  DEFAULT_POST_PROCESSING,
  normalizeCameraConstraints,
} from "../appDefaults";
import { syncSceneIntoApplication } from "../studio/sceneApplicationSync";
import { resolveSceneEntryCamera } from "../studio/sceneEntryCamera";
import { captureSceneThumbnail } from "../studio/sceneThumbnailCapture";
import { workspaceSaveFailureGuidance } from "../studio/workspaceSaveProtection";
import { createWorkspaceRecoveryDraft, deleteWorkspaceRecoveryDraft, writeWorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import { normalizeSceneCoordinates } from "../viewer/sceneCoordinates";
import { createBrowserCooperativeWorkScheduler } from "../cooperativeWorkScheduler";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import { shouldRecycleWebGpuRenderer, webGpuSceneReplacementThreshold } from "../viewer/webGpuRendererLifecyclePolicy";
import { createSceneFileTransferActions } from "./sceneFileTransferActions";
import { createSceneCreationAction } from "./sceneCreationAction";
import { createScenePublicationActions } from "./scenePublicationActions";
import { makeSceneSnapshot } from "./sceneSnapshotFactory";
import { createSceneWorkspaceNavigationActions } from "./sceneWorkspaceNavigationActions";
import { createSceneSimulationController, mergeSavedSimulationScene } from "./sceneSimulationController";

/** 统一场景快照、保存、发布、导入导出事务，保证各入口使用同一套一致性规则。 */
export function createScenePersistenceController(context: ScenePersistenceControllerContext) {
  const {
    engine,
    project,
    activeScene,
    activeApplication,
    route,
    locale,
    sceneName,
    revision,
    configuredDefaultEnvironment,
    applicationSessionRef,
    rendererSnapshotRef,
    webGpuSceneReplacementCountRef,
    sceneNameCommitRef,
    sceneApplyVersionRef,
    lastAutoSavedSceneRevisionRef,
    primitiveColors,
    navigate,
    loadModel,
    isModelLoadSuperseded,
    sortScenesByTime,
    showError,
    setActiveScene,
    setAutoSaveEnabled,
    setAnimationPlaying,
    setAnimationTime,
    setAnnotations,
    setAvatarVisible,
    setBusy,
    setCameraConstraints,
    setCameraViews,
    setClippingState,
    setDefaultCameraViewId,
    setLastDeletedSelectionSet,
    setLighting,
    setMeasurements,
    setMessage,
    setNavigationMode,
    setNavigationSettings,
    setPhysics,
    setPostProcessing,
    setRevision,
    setRendererGeneration,
    setRendererSwitching,
    setSceneAnimation,
    setSceneCoordinates,
    setSceneDashboard,
    setSceneDataBindingRuntime,
    setSceneDataBindings,
    setSceneAssetBindings,
    setSceneEnvironment,
    setSceneInteractions,
    setSceneName,
    setSceneOrganizationSelection,
    setScenes,
    setSelected,
    setSelectedAnnotationId,
    setSelectedSpace,
    setSelectionSets,
    setViewerLoadState,
    setWeather,
  } = context;

  function makeSnapshot(): SceneSnapshot | undefined {
    return makeSceneSnapshot(context);
  }

  async function saveScene(automatic = false): Promise<SceneSnapshot | undefined> {
    const applicationBaseline = applicationSessionRef.current.getDocument();
    const snapshot = makeSnapshot();
    if (!snapshot || !project) return;
    const projectId = project.id;
    const applyVersion = sceneApplyVersionRef.current;
    if (route.applicationId && (applicationBaseline?.metadata.id !== route.applicationId || applicationBaseline.metadata.projectId !== projectId)) return;
    if (!automatic) setBusy(true);
    try {
      // 保存时抓取当前视口作为场景缩略图（U1-9d：卡片默认展示最后保存的画面）；失败不阻断保存。
      const sceneThumbnail = captureSceneThumbnail(engine);
      if (sceneThumbnail) snapshot.thumbnail = sceneThumbnail;
      // 引擎快照可比 React 闭包中的应用更新；送出前 Store 是并发编辑合并的唯一基线。
      const applicationDraft = route.applicationId && applicationBaseline?.metadata.id === route.applicationId
        && applicationBaseline.metadata.projectId === projectId ? syncSceneIntoApplication(applicationBaseline, snapshot) : undefined;
      // 网络请求发出前先保存轻量恢复副本；IndexedDB 不可用时仍继续正式保存。
      await writeWorkspaceRecoveryDraft(createWorkspaceRecoveryDraft(projectId, applicationDraft, snapshot));
      const workspace = applicationDraft ? await api.saveApplicationWorkspace(applicationDraft, snapshot) : undefined;
      const saved = workspace?.scene ?? (await api.saveScene(snapshot));
      if (workspace) applicationSessionRef.current.acknowledgeSave(workspace.application, applicationBaseline);
      if (sceneApplyVersionRef.current !== applyVersion || context.getActiveScene()?.id !== activeScene?.id) return saved;
      setActiveScene((current) => mergeSavedSimulationScene(current, activeScene, saved));
      setSceneName(saved.name);
      setScenes((items) => sortScenesByTime([saved, ...items.filter((item) => item.id !== saved.id)]));
      lastAutoSavedSceneRevisionRef.current = revision;
      await deleteWorkspaceRecoveryDraft(projectId, applicationDraft?.metadata.id, snapshot.id);
      if (!automatic) setMessage(`项目“${saved.name}”已保存`);
      return saved;
    } catch (reason) {
      const guidance = workspaceSaveFailureGuidance(reason, locale);
      if (guidance) {
        if (guidance.pauseAutoSave) setAutoSaveEnabled(false);
        showError(new Error(guidance.message));
      } else {
        showError(reason);
      }
    } finally {
      if (!automatic) setBusy(false);
    }
  }

  async function commitSceneName(): Promise<boolean> {
    const name = sceneName.trim();
    if (!activeScene || !project) return true;
    if (!name) {
      setSceneName(activeScene.name);
      showError(new Error("场景名称不能为空"));
      return false;
    }
    if (name === activeScene.name) {
      if (sceneName !== name) setSceneName(name);
      return true;
    }
    if (sceneNameCommitRef.current) return sceneNameCommitRef.current;
    const pending = api
      .renameScene(project.id, activeScene.id, name)
      .then((saved) => {
        setActiveScene(saved);
        setSceneName(saved.name);
        setScenes((items) => sortScenesByTime([saved, ...items.filter((item) => item.id !== saved.id)]));
        setMessage(`场景已重命名为“${saved.name}”`);
        return true;
      })
      .catch((reason) => {
        setSceneName(activeScene.name);
        showError(reason);
        return false;
      })
      .finally(() => {
        sceneNameCommitRef.current = undefined;
      });
    sceneNameCommitRef.current = pending;
    return pending;
  }

  const workspaceNavigation = createSceneWorkspaceNavigationActions(context);
  const fileTransfer = createSceneFileTransferActions(context, makeSnapshot, applyScene);
  const publication = createScenePublicationActions(context, () => saveScene());

  async function applyScene(scene: SceneSnapshot, updateRoute = true, sceneProject = project, readOnly = false, fastRuntime = false, safeAuthoringEntry = false) {
    if (!engine || !sceneProject) return;
    const applyVersion = ++sceneApplyVersionRef.current;
    setBusy(true);
    if (updateRoute) navigate(route.applicationId ? { ...route, view: "studio", sceneId: scene.id } : { view: "studio", sceneId: scene.id });
    try {
      if (engine.getRendererBackend() === "webgpu") {
        const replacementCount = webGpuSceneReplacementCountRef.current + 1;
        const replacementThreshold = webGpuSceneReplacementThreshold(engine.getSceneStatistics().componentCount);
        if (shouldRecycleWebGpuRenderer("webgpu", replacementCount, replacementThreshold)) {
          webGpuSceneReplacementCountRef.current = 0;
          rendererSnapshotRef.current = {
            scene,
            readOnly,
            fastRuntime,
            recoveryMessage: "WebGPU 资源水位已自动回收，场景状态与画质保持不变",
          };
          setRendererSwitching(true);
          setRendererGeneration((value) => value + 1);
          return;
        }
        webGpuSceneReplacementCountRef.current = replacementCount;
      } else {
        webGpuSceneReplacementCountRef.current = 0;
      }
      engine.setReadOnly(readOnly);
      engine.setFastRuntime(fastRuntime);
      engine.clearSceneModels();
      const nextInteractions = normalizeInteractionScripts(scene.interactions);
      const nextDataBindings = normalizeSceneDataBindings(scene.dataBindings);
      engine.setInteractionScripts(nextInteractions);
      setSceneInteractions(nextInteractions);
      setSceneDataBindings(nextDataBindings);
      setSceneAssetBindings(structuredClone(scene.assetBindings ?? []));
      setSceneDataBindingRuntime({});
      primitiveColors.current.clear();
      setSelected(undefined);
      setMeasurements([]);
      setAnnotations([]);
      setSelectedAnnotationId(undefined);
      setSelectedSpace(undefined);
      setSceneOrganizationSelection(new Set());
      setSelectionSets(structuredClone(scene.selectionSets ?? []));
      setLastDeletedSelectionSet(undefined);
      const loadSceneModel = async (item: SceneSnapshot["models"][number]) => {
        const record = sceneProject.models.find((model) => model.id === item.modelId);
        if (record) await loadModel(record, true);
        if (applyVersion !== sceneApplyVersionRef.current) return false;
        engine.applyModelState(item.modelId, item);
        engine.rename(item.modelId, item.name);
        return true;
      };
      const essentialModels = readOnly ? scene.models.slice(0, 1) : scene.models;
      const deferredModels = readOnly ? scene.models.slice(1) : [];
      if (readOnly) setViewerLoadState({ loaded: 0, total: scene.models.length, current: essentialModels[0]?.name ?? scene.name, phase: "essential" });
      for (const [index, item] of essentialModels.entries()) {
        if (!(await loadSceneModel(item))) return;
        if (readOnly) setViewerLoadState({ loaded: index + 1, total: scene.models.length, current: item.name, phase: deferredModels.length ? "streaming" : "ready" });
      }
      for (const item of engine.listModels().filter((model) => model.kind === "primitive")) engine.removeModel(item.id);
      const primitiveScheduler = createBrowserCooperativeWorkScheduler();
      for (const primitive of scene.primitives) {
        primitiveColors.current.set(primitive.modelId, primitive.color);
        engine.createPrimitive(primitive.modelId, primitive.name, primitive.kind ?? "box", primitive.color);
        engine.applyModelState(primitive.modelId, primitive);
        // 场景切换可在分片让出主线程时发生，旧任务必须停止继续写入新场景。
        if ((await primitiveScheduler.checkpoint()) && applyVersion !== sceneApplyVersionRef.current) return;
      }
      engine.clearMeasurements();
      for (const measurement of scene.measurements) engine.addMeasurementVisual(measurement);
      setMeasurements(scene.measurements);
      for (const annotation of scene.annotations ?? []) engine.addAnnotation(annotation);
      setAnnotations(engine.listAnnotations());
      const nextCameraViews = scene.cameraViews ?? [];
      const authoredEntryCamera = nextCameraViews.find((item) => item.id === scene.defaultCameraViewId)?.camera ?? scene.camera;
      const entryCamera = resolveSceneEntryCamera(authoredEntryCamera, { readOnly, safeAuthoringEntry });
      const nextCameraConstraints = normalizeCameraConstraints({ ...DEFAULT_CAMERA_CONSTRAINTS, ...scene.cameraConstraints });
      const nextNavigationSettings = normalizeNavigationSettings(scene.navigationSettings);
      engine.setCameraConstraints(nextCameraConstraints);
      engine.setNavigationSettings(nextNavigationSettings);
      engine.applyCamera(entryCamera);
      setCameraConstraints(nextCameraConstraints);
      setNavigationSettings(nextNavigationSettings);
      setCameraViews(nextCameraViews);
      setDefaultCameraViewId(scene.defaultCameraViewId);
      const nextWeather = scene.weather ?? "sunny";
      const savedLights = scene.lighting?.lights?.filter((light) => !["ambient-default", "hemisphere-default"].includes(light.id));
      const authoredLighting: GlobalLightingState = { ...DEFAULT_LIGHTING, ...scene.lighting, lights: savedLights?.length ? savedLights : (DEFAULT_LIGHTING.lights ?? []) };
      const nextLighting = authoredLighting;
      const nextEnvironment: SceneEnvironmentState = { ...configuredDefaultEnvironment, ...scene.environment };
      const nextCoordinates = normalizeSceneCoordinates(scene.coordinateSystem);
      const nextAnimation = scene.animation ?? DEFAULT_ANIMATION;
      // 自动性能守卫不得改写作者效果或业务仿真；它只治理瞬时渲染填充率。
      const nextPostProcessing = { ...DEFAULT_POST_PROCESSING, ...scene.postProcessing };
      const nextPhysics = { ...DEFAULT_PHYSICS, ...scene.physics, gravity: { ...DEFAULT_PHYSICS.gravity, ...scene.physics?.gravity } };
      const nextDashboard = normalizeDashboardState(scene.dashboard);
      engine.setWeather(nextWeather);
      engine.setGlobalLighting(nextLighting);
      engine.setSceneEnvironment(nextEnvironment);
      engine.applyFloorStates(scene.floors);
      engine.setPostProcessing(nextPostProcessing);
      engine.setPhysicsState(nextPhysics);
      engine.setSceneAnimation(nextAnimation);
      engine.seekSceneAnimation(0);
      setWeather(nextWeather);
      setLighting(nextLighting);
      setSceneEnvironment(nextEnvironment);
      setSceneCoordinates(nextCoordinates);
      setSceneAnimation(nextAnimation);
      setPostProcessing(nextPostProcessing);
      setPhysics(nextPhysics);
      setSceneDashboard(nextDashboard);
      setAnimationTime(0);
      setAnimationPlaying(false);
      const nextClipping = scene.clipping ?? DEFAULT_CLIPPING;
      engine.setClipping(nextClipping);
      setClippingState(nextClipping);
      if (scene.selectedAnnotationId) engine.selectAnnotation(scene.selectedAnnotationId);
      else if (scene.selectedModelId && scene.selectedLayerId) engine.selectLayer(scene.selectedModelId, scene.selectedLayerId);
      else engine.select(scene.selectedModelId);
      setNavigationMode(entryCamera.mode);
      setAvatarVisible(entryCamera.avatarVisible ?? false);
      setActiveScene(scene);
      setSceneName(scene.name);
      setMessage(`场景“${scene.name}”已恢复`);
      setRevision((value) => {
        const nextRevision = value + 1;
        // Applying a persisted/recovered snapshot establishes a new clean baseline. Updating the
        // guard in the same state transition prevents the load itself from recreating a recovery draft.
        lastAutoSavedSceneRevisionRef.current = nextRevision;
        return nextRevision;
      });
      if (readOnly && deferredModels.length) {
        void (async () => {
          let loaded = essentialModels.length;
          for (const item of deferredModels) {
            if (!(await loadSceneModel(item))) return;
            loaded += 1;
            setViewerLoadState({ loaded, total: scene.models.length, current: item.name, phase: loaded === scene.models.length ? "ready" : "streaming" });
          }
          window.setTimeout(() => {
            if (applyVersion === sceneApplyVersionRef.current) setViewerLoadState(undefined);
          }, 900);
        })().catch((reason) => {
          if (applyVersion !== sceneApplyVersionRef.current) return;
          setViewerLoadState({ phase: "error", loaded: 0, total: scene.models.length, current: reason instanceof Error ? reason.message : "模型加载失败" });
          showError(reason);
        });
      } else if (readOnly) {
        setViewerLoadState({ phase: "ready", loaded: scene.models.length, total: scene.models.length, current: scene.name });
        window.setTimeout(() => {
          if (applyVersion === sceneApplyVersionRef.current) setViewerLoadState(undefined);
        }, 600);
      } else {
        setViewerLoadState(undefined);
      }
    } catch (reason) {
      if (isModelLoadSuperseded(reason) || applyVersion !== sceneApplyVersionRef.current) return;
      if (readOnly) setViewerLoadState({ phase: "error", loaded: 0, total: scene.models.length, current: reason instanceof Error ? reason.message : "场景加载失败" });
      showError(reason);
    } finally {
      if (applyVersion === sceneApplyVersionRef.current) setBusy(false);
    }
  }

  const createScene = createSceneCreationAction(context, workspaceNavigation.openSceneDashboard);

  return {
    makeSnapshot,
    saveScene,
    commitSceneName,
    applyScene,
    createScene,
    ...workspaceNavigation,
    ...fileTransfer,
    ...publication,
    ...createSceneSimulationController(context),
  };
}

export type ScenePersistenceController = ReturnType<typeof createScenePersistenceController>;
