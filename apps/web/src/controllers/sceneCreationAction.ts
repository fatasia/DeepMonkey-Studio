import type { SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import {
  DEFAULT_ANIMATION,
  DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_CLIPPING,
  DEFAULT_LIGHTING,
  DEFAULT_PHYSICS,
  DEFAULT_POST_PROCESSING,
} from "../appDefaults";
import { DEFAULT_DASHBOARD_STATE } from "../components/dashboardState";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";
import { DEFAULT_SCENE_COORDINATES } from "../viewer/sceneCoordinates";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type SceneCreationContext = Pick<
  ScenePersistenceControllerContext,
  | "engine"
  | "project"
  | "configuredDefaultEnvironment"
  | "sceneApplyVersionRef"
  | "primitiveColors"
  | "sortScenesByTime"
  | "setActiveScene"
  | "setAnimationPlaying"
  | "setAnimationTime"
  | "setAnnotations"
  | "setAvatarVisible"
  | "setCameraConstraints"
  | "setCameraViews"
  | "setClippingState"
  | "setDefaultCameraViewId"
  | "setLastDeletedSelectionSet"
  | "setLighting"
  | "setMeasurements"
  | "setMessage"
  | "setNavigationMode"
  | "setNavigationSettings"
  | "setPhysics"
  | "setPostProcessing"
  | "setRevision"
  | "setSceneAnimation"
  | "setSceneCoordinates"
  | "setSceneDashboard"
  | "setSceneDataBindingRuntime"
  | "setSceneDataBindings"
  | "setSceneEnvironment"
  | "setSceneInteractions"
  | "setSceneName"
  | "setSceneOrganizationSelection"
  | "setScenes"
  | "setSelected"
  | "setSelectedAnnotationId"
  | "setSelectionSets"
  | "setWeather"
>;

type OpenSceneDashboard = (scene: SceneSnapshot) => Promise<void>;

/** 新建场景的重置顺序集中在这里，防止旧场景的运行状态泄漏到新应用。 */
export function createSceneCreationAction(context: SceneCreationContext, openSceneDashboard: OpenSceneDashboard) {
  const {
    engine,
    project,
    configuredDefaultEnvironment,
    sceneApplyVersionRef,
    primitiveColors,
    sortScenesByTime,
    setActiveScene,
    setAnimationPlaying,
    setAnimationTime,
    setAnnotations,
    setAvatarVisible,
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
    setSceneAnimation,
    setSceneCoordinates,
    setSceneDashboard,
    setSceneDataBindingRuntime,
    setSceneDataBindings,
    setSceneEnvironment,
    setSceneInteractions,
    setSceneName,
    setSceneOrganizationSelection,
    setScenes,
    setSelected,
    setSelectedAnnotationId,
    setSelectionSets,
    setWeather,
  } = context;

  return async function createScene(name: string) {
    if (!project) return;
    sceneApplyVersionRef.current += 1;
    if (engine) {
      engine.clearSceneModels();
      engine.setClipping(DEFAULT_CLIPPING);
      engine.setWeather("sunny");
      engine.setGlobalLighting(DEFAULT_LIGHTING);
      engine.setSceneEnvironment(configuredDefaultEnvironment);
      engine.setPostProcessing(DEFAULT_POST_PROCESSING);
      engine.setPhysicsState(DEFAULT_PHYSICS);
      engine.setSceneAnimation(DEFAULT_ANIMATION);
      engine.setInteractionScripts([]);
      engine.setCameraConstraints(DEFAULT_CAMERA_CONSTRAINTS);
      engine.setNavigationSettings(DEFAULT_NAVIGATION_SETTINGS);
      engine.seekSceneAnimation(0);
    }

    setClippingState(DEFAULT_CLIPPING);
    primitiveColors.current.clear();
    setMeasurements([]);
    setAnnotations([]);
    setSelectedAnnotationId(undefined);
    setSelected(undefined);
    setSceneOrganizationSelection(new Set());
    setSelectionSets([]);
    setLastDeletedSelectionSet(undefined);
    setCameraViews([]);
    setCameraConstraints(DEFAULT_CAMERA_CONSTRAINTS);
    setNavigationSettings(DEFAULT_NAVIGATION_SETTINGS);
    setDefaultCameraViewId(undefined);

    const now = new Date().toISOString();
    const scene: SceneSnapshot = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      projectId: project.id,
      name,
      camera: { position: { x: 12, y: 8, z: 12 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" },
      coordinateSystem: DEFAULT_SCENE_COORDINATES,
      cameraConstraints: DEFAULT_CAMERA_CONSTRAINTS,
      navigationSettings: DEFAULT_NAVIGATION_SETTINGS,
      cameraViews: [],
      models: [],
      primitives: [],
      measurements: [],
      annotations: [],
      weather: "sunny",
      lighting: DEFAULT_LIGHTING,
      environment: configuredDefaultEnvironment,
      postProcessing: DEFAULT_POST_PROCESSING,
      physics: DEFAULT_PHYSICS,
      animation: DEFAULT_ANIMATION,
      dashboard: structuredClone(DEFAULT_DASHBOARD_STATE),
      dataBindings: [],
      interactions: [],
      selectionSets: [],
      createdAt: now,
      updatedAt: now,
    };
    const saved = await api.saveScene(scene);
    engine?.applyCamera(saved.camera);
    setActiveScene(saved);
    setSceneName(saved.name);
    setScenes((items) => sortScenesByTime([saved, ...items]));
    setNavigationMode("orbit");
    setAvatarVisible(false);
    setWeather("sunny");
    setLighting(DEFAULT_LIGHTING);
    setSceneDashboard(structuredClone(DEFAULT_DASHBOARD_STATE));
    setSceneDataBindings([]);
    setSceneDataBindingRuntime({});
    setSceneInteractions([]);
    setSelectionSets([]);
    setSceneEnvironment(configuredDefaultEnvironment);
    setSceneCoordinates(DEFAULT_SCENE_COORDINATES);
    setPostProcessing(DEFAULT_POST_PROCESSING);
    setPhysics(DEFAULT_PHYSICS);
    setSceneAnimation(DEFAULT_ANIMATION);
    setCameraViews([]);
    setDefaultCameraViewId(undefined);
    setAnimationTime(0);
    setAnimationPlaying(false);
    await openSceneDashboard(saved);
    setMessage(`应用“${saved.name}”已创建，默认进入二维设计`);
    setRevision((value) => value + 1);
  };
}
