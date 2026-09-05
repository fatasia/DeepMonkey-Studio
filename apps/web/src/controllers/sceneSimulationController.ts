import type { SceneSnapshot, SimulationEntityState } from "@bim-studio/contracts";
import { validateSimulationEntities } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type Context = Pick<ScenePersistenceControllerContext, "activeScene" | "engine" | "setActiveScene" | "setRevision" | "showError" | "recordSceneEdit">;

/** 仿真输入只写当前场景；保存、恢复副本和撤销均经既有快照链路。 */
export function createSceneSimulationController(context: Context) {
  function updateSimulationEntity(next: SimulationEntityState): void {
    const sceneId = context.activeScene?.id;
    if (!sceneId || !context.activeScene?.simulationEntities?.some((item) => item.id === next.id)) return;
    // 保留已有断链，允许修正参数；不因其它实体断链而阻断当前编辑。
    const referenceIds = new Set(context.engine?.listModels().map((item) => item.id) ?? []);
    for (const id of simulationEntityModelIds(next)) referenceIds.add(id);
    const errors = validateSimulationEntities([next], referenceIds);
    if (errors.length) { context.showError(new Error(errors.join("；"))); return; }
    context.setActiveScene((current) => current?.id !== sceneId ? current : {
      ...current,
      simulationEntities: current.simulationEntities?.map((item) => item.id === next.id ? structuredClone(next) : item) ?? [],
    });
    context.setRevision((value) => value + 1);
    context.recordSceneEdit("编辑仿真实体");
  }

  function deleteSimulationEntity(entityId: string): void {
    const sceneId = context.activeScene?.id;
    if (!sceneId || !context.activeScene?.simulationEntities?.some((item) => item.id === entityId)) return;
    context.setActiveScene((current) => current?.id !== sceneId ? current : {
      ...current, simulationEntities: current.simulationEntities?.filter((item) => item.id !== entityId) ?? [],
    });
    context.setRevision((value) => value + 1);
    context.recordSceneEdit("删除仿真实体");
  }

  return { updateSimulationEntity, deleteSimulationEntity };
}

export function simulationEntityModelIds(entity: SimulationEntityState): string[] {
  return entity.kind === "flowLink" ? [entity.fromModelId, entity.toModelId]
    : entity.kind === "path" ? [entity.targetModelId] : [entity.a.modelId, entity.b.modelId];
}

/** 保存响应不能覆盖请求期间的新编辑，也不能把切换后的场景拉回去。 */
export function mergeSavedSimulationScene(current: SceneSnapshot | undefined, submitted: SceneSnapshot | undefined, saved: SceneSnapshot): SceneSnapshot | undefined {
  if (current?.id !== saved.id) return current;
  return current.simulationEntities === submitted?.simulationEntities ? saved : {
    ...saved, ...(current.simulationEntities ? { simulationEntities: current.simulationEntities } : { simulationEntities: [] }),
  };
}
