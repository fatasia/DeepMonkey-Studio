import type { GlobalLightingState, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import {
  DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_CLIPPING,
  DEFAULT_ENVIRONMENT,
  DEFAULT_LIGHTING,
  DEFAULT_PHYSICS,
  DEFAULT_POST_PROCESSING,
  normalizeCameraConstraints,
} from "../appDefaults";
import { createBrowserCooperativeWorkScheduler, type CooperativeWorkScheduler } from "../cooperativeWorkScheduler";
import { DEFAULT_NAVIGATION_SETTINGS, normalizeNavigationSettings } from "../navigationSettings";
import type { ViewerEngine } from "../viewer/ViewerEngine";

export interface ApplySceneViewerSnapshotOptions {
  /** React 卸载或渲染后端切换时停止继续写入已释放的引擎。 */
  isCancelled?: () => boolean;
  /** 允许测试注入确定性的分片边界；生产环境默认使用浏览器协作式调度。 */
  primitiveScheduler?: Pick<CooperativeWorkScheduler, "checkpoint">;
}

/** 将不可变发布快照应用到独立 ViewerEngine，不经过任何编辑器控制器。 */
export async function applySceneViewerSnapshot(
  engine: ViewerEngine,
  scene: SceneSnapshot,
  project: ProjectRecord,
  options: ApplySceneViewerSnapshotOptions = {},
): Promise<void> {
  engine.setReadOnly(true);
  engine.setFastRuntime(scene.publicationPerformance === "fast");
  engine.clearSceneModels();
  engine.setInteractionScripts(scene.interactions ?? []);

  for (const state of scene.models) {
    const record = project.models.find((model) => model.id === state.modelId);
    if (!record?.manifest) throw new Error(`发布包缺少模型“${state.name}”的浏览清单`);
    await engine.loadManifest(record.manifest);
    if (options.isCancelled?.()) return;
    engine.applyModelState(state.modelId, state);
    engine.rename(state.modelId, state.name);
  }
  const primitiveScheduler = options.primitiveScheduler ?? createBrowserCooperativeWorkScheduler();
  for (const primitive of scene.primitives) {
    engine.createPrimitive(primitive.modelId, primitive.name, primitive.kind, primitive.color);
    engine.applyModelState(primitive.modelId, primitive);
    if ((await primitiveScheduler.checkpoint()) && options.isCancelled?.()) return;
  }
  engine.clearMeasurements();
  for (const measurement of scene.measurements) engine.addMeasurementVisual(measurement);
  for (const annotation of scene.annotations ?? []) engine.addAnnotation(annotation);

  const views = scene.cameraViews ?? [];
  const camera = views.find((view) => view.id === scene.defaultCameraViewId)?.camera ?? scene.camera;
  engine.setCameraConstraints(normalizeCameraConstraints({ ...DEFAULT_CAMERA_CONSTRAINTS, ...scene.cameraConstraints }));
  engine.setNavigationSettings(normalizeNavigationSettings(scene.navigationSettings ?? DEFAULT_NAVIGATION_SETTINGS));
  engine.applyCamera(camera);
  engine.setWeather(scene.weather ?? "sunny");
  engine.setGlobalLighting(publishedLighting(scene.lighting));
  engine.setSceneEnvironment({ ...DEFAULT_ENVIRONMENT, ...scene.environment });
  engine.applyFloorStates(scene.floors);
  engine.setPostProcessing({ ...DEFAULT_POST_PROCESSING, ...scene.postProcessing });
  engine.setPhysicsState({
    ...DEFAULT_PHYSICS,
    ...scene.physics,
    gravity: { ...DEFAULT_PHYSICS.gravity, ...scene.physics?.gravity },
  });
  if (scene.animation) {
    engine.setSceneAnimation(scene.animation);
    engine.seekSceneAnimation(0);
  }
  engine.setClipping(scene.clipping ?? DEFAULT_CLIPPING);
  if (scene.selectedAnnotationId) engine.selectAnnotation(scene.selectedAnnotationId);
  else if (scene.selectedModelId && scene.selectedLayerId) engine.selectLayer(scene.selectedModelId, scene.selectedLayerId);
  else engine.select(scene.selectedModelId);
}

function publishedLighting(value: GlobalLightingState | undefined): GlobalLightingState {
  const authored = value?.lights?.filter((light) => !["ambient-default", "hemisphere-default"].includes(light.id));
  return {
    ...DEFAULT_LIGHTING,
    ...value,
    lights: authored?.length ? authored : (DEFAULT_LIGHTING.lights ?? []),
  };
}
