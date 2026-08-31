import type { SceneSnapshot } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type SceneSnapshotSource = Pick<
  ScenePersistenceControllerContext,
  | "engine"
  | "project"
  | "activeScene"
  | "sceneName"
  | "sceneCoordinates"
  | "cameraViews"
  | "defaultCameraViewId"
  | "measurements"
  | "sceneDashboard"
  | "sceneDataBindings"
  | "sceneAssetBindings"
  | "sceneInteractions"
  | "selectionSets"
  | "selected"
  | "selectedLayerId"
  | "selectedAnnotationId"
  | "primitiveColors"
>;

/**
 * 从当前编辑器状态构建可持久化快照。
 *
 * 这里只读取引擎和 React 状态，不触发网络或界面更新；保存、发布、导出可以共享同一份事实来源。
 */
export function makeSceneSnapshot(source: SceneSnapshotSource): SceneSnapshot | undefined {
  const {
    engine,
    project,
    activeScene,
    sceneName,
    sceneCoordinates,
    cameraViews,
    defaultCameraViewId,
    measurements,
    sceneDashboard,
    sceneDataBindings,
    sceneAssetBindings,
    sceneInteractions,
    selectionSets,
    selected,
    selectedLayerId,
    selectedAnnotationId,
    primitiveColors,
  } = source;
  if (!engine || !project) return;

  const now = new Date().toISOString();
  const currentModels = engine.listModels();
  return {
    schemaVersion: 1,
    id: activeScene?.id ?? crypto.randomUUID(),
    projectId: project.id,
    name: sceneName.trim() || "未命名场景",
    camera: engine.getCameraState(),
    coordinateSystem: sceneCoordinates,
    cameraConstraints: engine.getCameraConstraints(),
    navigationSettings: engine.getNavigationSettings(),
    cameraViews,
    ...(defaultCameraViewId ? { defaultCameraViewId } : {}),
    models: currentModels
      .filter((item) => item.kind === "model")
      .flatMap((item) => {
        const transform = engine.getModelTransform(item.id);
        const sourceModel = project.models.find((model) => model.id === item.id);
        const colorOverride = engine.getModelColorOverride(item.id);
        const material = engine.getModelMaterialOverride(item.id);
        const rig = engine.getModelRigState(item.id);
        const prefab = engine.getIndustrialPrefabState(item.id);
        const spatialAudio = engine.getSpatialAudioState(item.id);
        return transform
          ? [{
              modelId: item.id,
              name: item.name,
              ...(sourceModel ? { sourceName: sourceModel.name, sourceFormat: sourceModel.format } : {}),
              visible: item.visible,
              locked: engine.isModelLocked(item.id),
              opacity: item.opacity,
              ...(colorOverride ? { colorOverride } : {}),
              ...(material ? { material } : {}),
              ...(spatialAudio ? { spatialAudio } : {}),
              ...(rig ? { rig } : {}),
              ...(prefab ? { prefab } : {}),
              effects: engine.getModelEffects(item.id),
              physics: engine.getPhysicsBodyState(item.id),
              transform,
              collisionEnabled: engine.isCollisionEnabled(item.id),
              explosionFactor: engine.getExplosionFactor(item.id),
              explosionMode: engine.getExplosionMode(item.id),
              ...(engine.hasAnimation(item.id) ? { animationEnabled: engine.isAnimationEnabled(item.id) } : {}),
              ...(engine.hasAnimation(item.id) ? { animationPlayback: engine.getModelAnimationPlaybackState(item.id) } : {}),
              layers: engine.getLayerStates(item.id),
            }]
          : [];
      }),
    primitives: currentModels
      .filter((item) => item.kind === "primitive")
      .flatMap((item) => {
        const state = engine.primitiveState(item.id, primitiveColors.current.get(item.id) ?? "#d4a84f");
        return state ? [state] : [];
      }),
    measurements,
    annotations: engine.listAnnotations(),
    clipping: engine.getClippingState(),
    weather: engine.getWeather(),
    lighting: engine.getGlobalLighting(),
    environment: engine.getSceneEnvironment(),
    floors: engine.getFloorStates(),
    postProcessing: engine.getPostProcessing(),
    physics: engine.getPhysicsState(),
    animation: engine.getSceneAnimation(),
    dashboard: sceneDashboard,
    dataBindings: sceneDataBindings,
    assetBindings: sceneAssetBindings,
    interactions: sceneInteractions,
    selectionSets,
    ...(selected ? { selectedModelId: selected.id } : {}),
    ...(selectedLayerId ? { selectedLayerId } : {}),
    ...(selectedAnnotationId ? { selectedAnnotationId } : {}),
    ...(activeScene?.publishedAt ? { publishedAt: activeScene.publishedAt } : {}),
    ...(activeScene?.publicationMode ? { publicationMode: activeScene.publicationMode } : {}),
    ...(activeScene?.publicationPerformance ? { publicationPerformance: activeScene.publicationPerformance } : {}),
    createdAt: activeScene?.createdAt ?? now,
    updatedAt: now,
  };
}
