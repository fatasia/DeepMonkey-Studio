import type { ModelRecord, SceneModelState } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "./viewerTypes";
import type { ViewerEngineContract } from "./viewerEngineContract";

type StateReader = Pick<ViewerEngineContract,
  "getModelTransform" | "getModelColorOverride" | "getModelMaterialOverride" | "getModelRigState" |
  "getIndustrialPrefabState" | "getRobotPose" | "getSpatialAudioState" | "isModelLocked" | "getModelEffects" |
  "getPhysicsBodyState" | "isCollisionEnabled" | "getExplosionFactor" | "getExplosionMode" |
  "hasAnimation" | "isAnimationEnabled" | "getModelAnimationPlaybackState" | "getLayerStates">;

/** 保存与替换共用同一实例状态读取，资源链接不参与对象引用身份。 */
export function captureSceneModelState(engine: StateReader, item: LoadedSceneModel, source?: ModelRecord): SceneModelState | undefined {
  const transform = engine.getModelTransform(item.id);
  if (!transform) return;
  const colorOverride = engine.getModelColorOverride(item.id);
  const material = engine.getModelMaterialOverride(item.id);
  const rig = engine.getModelRigState(item.id);
  const robotPose = engine.getRobotPose?.(item.id);
  const prefab = engine.getIndustrialPrefabState(item.id);
  const spatialAudio = engine.getSpatialAudioState(item.id);
  return structuredClone({
    modelId: item.id,
    ...(item.assetModelId && item.assetModelId !== item.id ? { assetModelId: item.assetModelId } : {}),
    name: item.name,
    ...(source ? { sourceName: source.name, sourceFormat: source.format } : {}),
    visible: item.visible, locked: engine.isModelLocked(item.id), opacity: item.opacity,
    ...(colorOverride ? { colorOverride } : {}), ...(material ? { material } : {}),
    ...(spatialAudio ? { spatialAudio } : {}), ...(rig ? { rig } : {}), ...(prefab ? { prefab } : {}),
    ...(robotPose ? { robotPose } : {}),
    effects: engine.getModelEffects(item.id), physics: engine.getPhysicsBodyState(item.id), transform,
    collisionEnabled: engine.isCollisionEnabled(item.id),
    explosionFactor: engine.getExplosionFactor(item.id), explosionMode: engine.getExplosionMode(item.id),
    ...(engine.hasAnimation(item.id) ? {
      animationEnabled: engine.isAnimationEnabled(item.id), animationPlayback: engine.getModelAnimationPlaybackState(item.id),
    } : {}),
    layers: engine.getLayerStates(item.id),
  });
}
