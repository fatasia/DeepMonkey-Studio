import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";

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
    const mappedId = modelIdMap.get(item.modelId);
    const target = project.models.find((model) => model.id === mappedId)
      ?? project.models.find((model) => model.id === item.modelId)
      ?? project.models.find((model) => model.name === item.sourceName && model.format === item.sourceFormat);
    if (!target) return item;
    modelIdMap.set(item.modelId, target.id);
    return { ...item, modelId: target.id, sourceName: target.name, sourceFormat: target.format };
  });

  const rebindId = (id: string) => modelIdMap.get(id) ?? id;
  const rebound: SceneSnapshot = {
    ...scene,
    models: reboundModels,
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
    missingModelCount: reboundModels.filter((item) => !project.models.some((model) => model.id === item.modelId)).length
  };
}
