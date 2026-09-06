import {
  assertPathSafeResourceId,
  getSceneModelAssetId,
  type ApplicationDocument,
  type DatabaseDocument,
  type SceneDocument,
} from "@bim-studio/contracts";
import { changed, requireProject, unchanged } from "./storeUtils.js";

type ModelScene = Pick<SceneDocument, "models" | "primitives">;

export class ModelAssetReferenceError extends Error {
  constructor(message: string, public readonly statusCode = 409) {
    super(message);
    this.name = "ModelAssetReferenceError";
  }
}

/** 新实例合同在存储事务内验证；省略资源字段的历史快照保持原有兼容行为。 */
export function assertSceneAssetReferences(document: DatabaseDocument, projectId: string, scenes: readonly ModelScene[]): void {
  for (const scene of scenes) {
    const models = scene.models ?? [];
    if (!models.some(model => Object.hasOwn(model, "assetModelId"))) continue;
    const ids = new Set<string>();
    for (const model of [...models, ...(scene.primitives ?? [])]) {
      if (typeof model.modelId !== "string" || !model.modelId.trim() || ids.has(model.modelId)) {
        throw new ModelAssetReferenceError("场景实例 ID 不能为空或重复", 400);
      }
      ids.add(model.modelId);
    }
    for (const model of models) {
      if (!Object.hasOwn(model, "assetModelId")) continue;
      try { assertPathSafeResourceId(model.assetModelId, "assetModelId"); }
      catch { throw new ModelAssetReferenceError("模型资源 ID 无效", 400); }
      const project = document.projects.find(item => item.id === projectId);
      const asset = project?.models.find(item => item.id === model.assetModelId && item.projectId === projectId);
      if (!asset) throw new ModelAssetReferenceError(`模型“${model.name}”引用的项目资源不存在`);
      if (asset.status !== "ready" || !asset.manifest?.geometryUrl || !asset.manifest.viewerKind || asset.manifest.modelId !== asset.id) {
        throw new ModelAssetReferenceError(`模型“${model.name}”引用的资源尚未准备好`);
      }
    }
  }
}

/** 发布历史继续引用旧资源；仅移除实例或替换资源都不授权销毁资源二进制。 */
export function isModelAssetReferenced(document: DatabaseDocument, projectId: string, assetModelId: string): boolean {
  const sceneUsesAsset = (scene: Pick<ModelScene, "models">) => (scene.models ?? []).some(model => getSceneModelAssetId(model) === assetModelId);
  const applicationUsesAsset = (application: ApplicationDocument) => application.scenes.some(sceneUsesAsset)
    || application.assets.some(asset => asset.kind === "model" && asset.id === assetModelId);
  return document.scenes.some(scene => scene.projectId === projectId && sceneUsesAsset(scene))
    || [...(document.publishedScenes ?? []), ...(document.scenePublicationHistory ?? [])]
      .some(publication => publication.projectId === projectId && sceneUsesAsset(publication.snapshot))
    || (document.applications ?? []).some(application => application.metadata.projectId === projectId && applicationUsesAsset(application))
    || (document.publishedApplications ?? []).some(publication => publication.projectId === projectId && applicationUsesAsset(publication.document));
}

/** 与保存共用串行文档事务，不能在路由预检查后留下保存/删除竞态。 */
export function removeUnreferencedModel(document: DatabaseDocument, projectId: string, assetModelId: string) {
  const project = requireProject(document, projectId);
  if (!project.models.some(model => model.id === assetModelId)) return unchanged(false);
  if (isModelAssetReferenced(document, projectId, assetModelId)) {
    throw new ModelAssetReferenceError("模型资源仍被场景、应用或发布历史引用；请先移除相关引用");
  }
  project.models = project.models.filter(model => model.id !== assetModelId);
  project.updatedAt = new Date().toISOString();
  return changed(true);
}
