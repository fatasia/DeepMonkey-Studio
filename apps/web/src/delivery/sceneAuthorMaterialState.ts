import type { SceneMaterialState, SceneSnapshot } from "@bim-studio/contracts";

/**
 * Reads the authored material state from the persisted scene contract.
 *
 * Runtime compilation must consume this snapshot boundary instead of asking a
 * ViewerEngine for a Three.js material. Returning a clone keeps compilation
 * deterministic when an editor continues mutating its live state.
 */
export function readSceneModelMaterialState(
  scene: Pick<SceneSnapshot, "models">,
  modelId: string,
): SceneMaterialState | undefined {
  const material = scene.models.find((model) => model.modelId === modelId)?.material;
  return material === undefined ? undefined : structuredClone(material);
}
