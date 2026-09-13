import type { SceneSnapshot, SimulationEntityState } from "@bim-studio/contracts";
import { validateSimulationEntities } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type Context = Pick<ScenePersistenceControllerContext, "activeScene" | "getActiveScene" | "engine" | "setActiveScene" | "setRevision" | "showError" | "recordSceneEdit">;

/** 仿真输入只写当前场景；保存、恢复副本和撤销均经既有快照链路。 */
export function createSceneSimulationController(context: Context) {
  const sceneId = context.activeScene?.id;
  // 先核验当前所有权，不能只在 React updater 中拒绝写入，却继续留下 dirty/history 副作用。
  function ownsEntity(entityId: string): boolean {
    const current = context.getActiveScene();
    return Boolean(sceneId && current?.id === sceneId && current.simulationEntities?.some(item => item.id === entityId));
  }
  function updateSimulationEntity(next: SimulationEntityState): void {
    if (!ownsEntity(next.id)) return;
    // 保留已有断链，允许修正参数；不因其它实体断链而阻断当前编辑。
    const referenceIds = new Set(context.engine?.listModels().map((item) => item.id) ?? []);
    for (const id of simulationEntityModelIds(next)) referenceIds.add(id);
    const errors = validateSimulationEntities([next], referenceIds);
    if (errors.length) { context.showError(new Error(errors.join("；"))); return; }
    context.setActiveScene((current) => !current || current.id !== sceneId ? current : {
      ...current,
      simulationEntities: current.simulationEntities?.map((item) => item.id === next.id ? structuredClone(next) : item) ?? [],
    });
    context.setRevision((value) => value + 1);
    context.recordSceneEdit("编辑仿真实体");
  }

  function deleteSimulationEntity(entityId: string): void {
    if (!ownsEntity(entityId)) return;
    context.setActiveScene((current) => !current || current.id !== sceneId ? current : {
      ...current, simulationEntities: current.simulationEntities?.filter((item) => item.id !== entityId) ?? [],
    });
    context.setRevision((value) => value + 1);
    context.recordSceneEdit("删除仿真实体");
  }

  function replaceSimulationEntities(entities: SimulationEntityState[]): void {
    const current = context.getActiveScene();
    if (!sceneId || current?.id !== sceneId) return;
    if (current.simulationEntities !== context.activeScene?.simulationEntities) throw new Error("场景物流配置已更新，请基于当前配置重新操作");
    const references = new Set(context.engine?.listModels().map(item => item.id) ?? []);
    // 已有断链保留以供修复；新增引用必须存在，不能静默绑定默认对象。
    for (const entity of current.simulationEntities ?? []) for (const id of simulationEntityModelIds(entity)) references.add(id);
    const errors = validateSimulationEntities(entities, references);
    if (errors.length) throw new Error(errors.join("；"));
    context.setActiveScene(value => value?.id === sceneId ? { ...value, simulationEntities: structuredClone(entities) } : value);
    context.setRevision(value => value + 1);
    context.recordSceneEdit("编辑场景物流流程");
  }
  return { updateSimulationEntity, deleteSimulationEntity, replaceSimulationEntities };
}

export function simulationEntityModelIds(entity: SimulationEntityState): string[] {
  return entity.kind === "flowLink" ? [entity.fromModelId, entity.toModelId]
    : entity.kind === "path" || entity.kind === "flowNode" ? [entity.targetModelId] : [entity.a.modelId, entity.b.modelId];
}

/** 保存响应不能覆盖请求期间的新编辑，也不能把切换后的场景拉回去。 */
export function mergeSavedSimulationScene(current: SceneSnapshot | undefined, submitted: SceneSnapshot | undefined, saved: SceneSnapshot): SceneSnapshot | undefined {
  if (!current && !submitted) return saved;
  if (current?.id !== saved.id) return current;
  return current.simulationEntities === submitted?.simulationEntities ? saved : {
    ...saved, ...(current.simulationEntities ? { simulationEntities: current.simulationEntities } : { simulationEntities: [] }),
  };
}
