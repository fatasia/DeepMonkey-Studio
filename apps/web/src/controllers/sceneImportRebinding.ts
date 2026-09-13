import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { getSceneModelAssetId } from "@bim-studio/contracts";

export interface SceneImportRebindingResult {
  scene: SceneSnapshot;
  missingModelCount: number;
}

/**
 * 将场景文件中的旧模型 ID 绑定到目标项目资源。
 * 所有引用在同一处重写，避免模型主体、动画和标注出现不同步的孤儿 ID。
 */
export function rebindImportedSceneModels(
  scene: SceneSnapshot,
  project: ProjectRecord,
  modelIdMap: Map<string, string>
): SceneImportRebindingResult {
  const reboundModels = scene.models.map((item) => {
    const assetId = getSceneModelAssetId(item);
    const mappedId = modelIdMap.get(assetId);
    const target = project.models.find((model) => model.id === mappedId)
      ?? project.models.find((model) => model.id === assetId)
      ?? project.models.find((model) => model.name === item.sourceName && model.format === item.sourceFormat);
    if (!target) return item;
    // 显式实例只重绑素材；旧格式仍沿用原有 ID 迁移以兼容历史文件。
    if (item.assetModelId) return { ...item, assetModelId: target.id, sourceName: target.name, sourceFormat: target.format };
    modelIdMap.set(item.modelId, target.id);
    return { ...item, modelId: target.id, sourceName: target.name, sourceFormat: target.format };
  });

  const instanceIds = new Set(scene.models.filter(item => item.assetModelId).map(item => item.modelId));
  const rebindId = (id: string) => instanceIds.has(id) ? id : modelIdMap.get(id) ?? id;
  const rebound: SceneSnapshot = {
    ...scene,
    models: reboundModels,
    ...(scene.dataBindings ? { dataBindings: scene.dataBindings.map(binding => ({ ...binding,
      target: { ...binding.target, ...(binding.target.modelId ? { modelId: rebindId(binding.target.modelId) } : {}) },
    })) } : {}),
    ...(scene.assetBindings ? { assetBindings: scene.assetBindings.map(binding => {
      const modelId = rebindId(binding.modelId);
      const sceneObjectId = binding.sceneObjectId.startsWith(`${binding.modelId}:`) || binding.sceneObjectId.startsWith(`${binding.modelId}/`)
        ? modelId + binding.sceneObjectId.slice(binding.modelId.length) : binding.sceneObjectId;
      return { ...binding, modelId, sceneObjectId };
    }) } : {}),
    ...(scene.interactions ? { interactions: scene.interactions.map(interaction => ({ ...interaction,
      target: interaction.target.kind === "object" ? { ...interaction.target, modelId: rebindId(interaction.target.modelId) } : interaction.target,
      ...(interaction.actions ? { actions: interaction.actions.map(action => action.target
        ? { ...action, target: { ...action.target, modelId: rebindId(action.target.modelId) } } : action) } : {}),
    })) } : {}),
    ...(scene.simulationEntities ? {
      simulationEntities: scene.simulationEntities.map((entity) => entity.kind === "flowLink"
        ? { ...entity, fromModelId: rebindId(entity.fromModelId), toModelId: rebindId(entity.toModelId) }
        : entity.kind === "path" || entity.kind === "flowNode" ? { ...entity, targetModelId: rebindId(entity.targetModelId) }
          : { ...entity, a: { ...entity.a, modelId: rebindId(entity.a.modelId) }, b: { ...entity.b, modelId: rebindId(entity.b.modelId) } }),
    } : {}),
    ...(scene.animation ? {
      animation: {
        ...scene.animation,
        models: scene.animation.models.map((frame) => ({ ...frame, modelId: rebindId(frame.modelId) }))
      }
    } : {}),
    ...(scene.annotations ? {
      annotations: scene.annotations.map((annotation) => ({
        ...annotation,
        ...(annotation.modelId ? { modelId: rebindId(annotation.modelId) } : {})
      }))
    } : {}),
    ...(scene.floors ? {
      floors: scene.floors.map((floor) => ({ ...floor, modelId: rebindId(floor.modelId) }))
    } : {}),
    ...(scene.selectionSets ? {
      selectionSets: scene.selectionSets.map((set) => ({
        ...set,
        objectIds: set.objectIds.map(rebindId)
      }))
    } : {}),
    ...(scene.selectedModelId ? { selectedModelId: rebindId(scene.selectedModelId) } : {})
  };

  return {
    scene: rebound,
    missingModelCount: reboundModels.filter((item) => !project.models.some((model) => model.id === getSceneModelAssetId(item))).length
  };
}
