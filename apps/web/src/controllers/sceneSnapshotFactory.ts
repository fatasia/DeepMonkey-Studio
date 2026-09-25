import type { SceneSnapshot } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import { captureSceneModelState } from "../viewer/captureSceneModelState";
import { validateSceneSnapshotTransforms } from "../viewer/sceneTransformProjection";

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
  | "engineeringAnalysis"
  | "sceneDataBindings"
  | "sceneAssetBindings"
  | "sceneInteractions"
  | "selectionSets"
  | "rootLayerOrder"
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
    engineeringAnalysis,
    sceneDataBindings,
    sceneAssetBindings,
    sceneInteractions,
    selectionSets,
    rootLayerOrder,
    selected,
    selectedLayerId,
    selectedAnnotationId,
    primitiveColors,
  } = source;
  if (!engine || !project) return;

  const now = new Date().toISOString();
  const currentModels = engine.listModels();
  const snapshot: SceneSnapshot = {
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
        const sourceModel = project.models.find((model) => model.id === (item.assetModelId ?? item.id));
        const state = captureSceneModelState(engine, item, sourceModel);
        return state ? [state] : [];
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
    engineeringAnalysis,
    dashboard: sceneDashboard,
    dataBindings: sceneDataBindings,
    assetBindings: sceneAssetBindings,
    interactions: sceneInteractions,
    selectionSets,
    ...(rootLayerOrder ? { rootLayerOrder: structuredClone(rootLayerOrder) } : {}),
    // 仿真输入不属于引擎对象；显式复制，避免保存遗漏或后续编辑污染历史快照。
    ...(activeScene?.simulationEntities ? { simulationEntities: structuredClone(activeScene.simulationEntities) } : {}),
    ...(activeScene?.thumbnail ? { thumbnail: activeScene.thumbnail } : {}),
    ...(activeScene?.publicationToolbarVisible !== undefined ? { publicationToolbarVisible: activeScene.publicationToolbarVisible } : {}),
    ...(selected ? { selectedModelId: selected.id } : {}),
    ...(selectedLayerId ? { selectedLayerId } : {}),
    ...(selectedAnnotationId ? { selectedAnnotationId } : {}),
    ...(activeScene?.publishedAt ? { publishedAt: activeScene.publishedAt } : {}),
    ...(activeScene?.publicationMode ? { publicationMode: activeScene.publicationMode } : {}),
    ...(activeScene?.publicationPerformance ? { publicationPerformance: activeScene.publicationPerformance } : {}),
    createdAt: activeScene?.createdAt ?? now,
    updatedAt: now,
  };
  validateSceneSnapshotTransforms(snapshot);
  return snapshot;
}
