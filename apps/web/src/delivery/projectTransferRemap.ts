import { getSceneModelAssetId, type ApplicationDocument, type ApplicationScriptDependency, type SceneModelState,
  type SceneSnapshot } from "@bim-studio/contracts";
import type { ProjectTransferDocument } from "./projectTransferModel";

export interface TransferMapping {
  projectId: string;
  models: Record<string, string>;
  assets: Record<string, string>;
  identities: Record<string, string>;
  urls: Record<string, string>;
  dependencies: Record<string, ApplicationScriptDependency>;
}

/** 只重写合同中的引用字段；对象/图层身份与脚本文本保持原样。 */
export function remapTransferValue<T>(input: T, mapping: TransferMapping): T {
  const visit = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (key === "projectId") return mapping.projectId;
      if (key === "assetModelId") return mapping.models[value] ?? value;
      if (key === "assetId") return mapping.assets[value] ?? value;
      if (["sceneId", "applicationId", "datasetId", "pipelineId", "connectionId", "productId"].includes(key)) return mapping.identities[value] ?? value;
      return mapping.urls[value] ?? value;
    }
    if (Array.isArray(value)) return value.map(item => visit(item, key));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, visit(child, childKey)]));
  };
  return visit(input) as T;
}
function modelsWithNewAssets(models: SceneModelState[], mapping: TransferMapping): SceneModelState[] {
  return models.map(model => ({ ...model, assetModelId: mapping.models[getSceneModelAssetId(model)] ?? getSceneModelAssetId(model) }));
}
export function remapTransferScene(scene: SceneSnapshot, mapping: TransferMapping): SceneSnapshot {
  const result = remapTransferValue(scene, mapping);
  result.id = mapping.identities[scene.id]!;
  result.projectId = mapping.projectId;
  result.models = modelsWithNewAssets(result.models, mapping);
  delete result.publishedAt;
  return result;
}
export function remapTransferApplication(app: ApplicationDocument, mapping: TransferMapping): ApplicationDocument {
  const result = remapTransferValue(app, mapping);
  result.metadata = { ...result.metadata, id: mapping.identities[app.metadata.id]!, projectId: mapping.projectId, revision: 1 };
  if (result.metadata.source) delete result.metadata.source.publishedAt;
  result.scenes = result.scenes.map(scene => ({ ...scene, id: mapping.identities[scene.id] ?? scene.id, models: modelsWithNewAssets(scene.models, mapping) }));
  result.assets = result.assets.map(asset => ({ ...asset, id: mapping.models[asset.id] ?? mapping.assets[asset.id] ?? asset.id, projectId: mapping.projectId }));
  result.scriptDependencies = (app.scriptDependencies ?? []).map(dependency => mapping.dependencies[dependency.id]).filter((item): item is ApplicationScriptDependency => Boolean(item));
  return result;
}
export function allocateTransferIdentities(document: ProjectTransferDocument): Record<string, string> {
  return Object.fromEntries([...new Set([
    ...document.scenes.map(scene => scene.id), ...document.applications.map(app => app.metadata.id),
    ...document.applications.flatMap(app => app.scenes.map(scene => scene.id)),
    ...document.runtime.connections.map(item => item.id), ...document.runtime.datasets.map(item => item.id), ...document.runtime.pipelines.map(item => item.id),
  ])].map(id => [id, crypto.randomUUID()]));
}
