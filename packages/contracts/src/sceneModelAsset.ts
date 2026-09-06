import type { SceneModelState } from "./scene.js";

/** 仅解析资源身份，不归一化或改写旧场景及实例引用。 */
export function getSceneModelAssetId(model: Pick<SceneModelState, "modelId" | "assetModelId">): string {
  return model.assetModelId ?? model.modelId;
}
