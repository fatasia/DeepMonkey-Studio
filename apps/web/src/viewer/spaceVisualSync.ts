import * as THREE from "three";
import type { LoadedSceneModel } from "./viewerTypes";

export interface SpaceVisualRuntime {
  modelId: string;
  object: THREE.Group;
  modelMatrix?: THREE.Matrix4;
}

/**
 * 空间覆盖层与模型根矩阵保持一致。多个空间共享同一模型时只更新一次模型世界矩阵，
 * 根矩阵未变化时不重复触发覆盖层及其子节点的矩阵传播。
 */
export function syncSpaceVisualTransforms(
  visuals: Iterable<SpaceVisualRuntime>,
  models: ReadonlyMap<string, LoadedSceneModel>,
): void {
  const modelMatrices = new Map<string, THREE.Matrix4>();
  for (const visual of visuals) {
    const model = models.get(visual.modelId);
    if (!model) continue;
    let modelMatrix = modelMatrices.get(visual.modelId);
    if (!modelMatrix) {
      model.object.updateWorldMatrix(true, false);
      modelMatrix = model.object.matrixWorld;
      modelMatrices.set(visual.modelId, modelMatrix);
    }

    const visible = model.visible && model.object.visible;
    if (visual.object.visible !== visible) visual.object.visible = visible;
    if (visual.modelMatrix?.equals(modelMatrix)) continue;

    // 覆盖层直接挂在 Scene 下，模型世界矩阵即为它的局部矩阵。
    visual.object.matrix.copy(modelMatrix);
    visual.object.matrixWorldNeedsUpdate = true;
    visual.object.updateMatrixWorld(true);
    if (visual.modelMatrix) visual.modelMatrix.copy(modelMatrix);
    else visual.modelMatrix = modelMatrix.clone();
  }
}
