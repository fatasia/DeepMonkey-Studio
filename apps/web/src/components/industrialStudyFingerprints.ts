import type { IndustrialValidationStudyContext, SceneSnapshot } from "@bim-studio/contracts";
import { createEvidenceFingerprint } from "@bim-studio/studio-core";

/** 固定排除当前选择等纯 UI 状态，避免同一工程工况因一次点击产生虚假的版本漂移。 */
export function buildIndustrialStudyContext(
  scene: SceneSnapshot,
  engineId: string,
  engineVersion: string,
): IndustrialValidationStudyContext {
  const modelState = {
    models: scene.models,
    primitives: scene.primitives,
  };
  const sceneState = {
    schemaVersion: scene.schemaVersion,
    id: scene.id,
    coordinateSystem: scene.coordinateSystem,
    models: scene.models,
    primitives: scene.primitives,
    clipping: scene.clipping,
    physics: scene.physics,
  };
  return {
    sceneFingerprint: createEvidenceFingerprint(sceneState),
    modelFingerprint: createEvidenceFingerprint(modelState),
    versionFingerprint: createEvidenceFingerprint({
      sceneId: scene.id,
      sceneUpdatedAt: scene.updatedAt,
      engineId,
      engineVersion,
    }),
  };
}
