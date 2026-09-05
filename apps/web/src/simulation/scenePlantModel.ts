import type { PlantLiteModel, PlantLiteNode, SceneSnapshot, SimulationEntityState, Vector3Value } from "@bim-studio/contracts";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";

export type SceneFlowNode = Extract<SimulationEntityState, { kind: "flowNode" }>;
export type SceneFlowRole = "source" | "queue-buffer" | "station" | "sink";
export const SCENE_FLOW_ROLES: Record<SceneFlowRole, string> = { source: "来料源", "queue-buffer": "队列", station: "工位", sink: "产出汇" };

export function createSceneFlowNode(objectId: string, name: string, role: SceneFlowRole, id: string = crypto.randomUUID()): SceneFlowNode {
  const base = { id, name: `${name} · ${SCENE_FLOW_ROLES[role]}` };
  const node: PlantLiteNode = role === "source" ? { ...base, kind: role, interarrivalTime: { kind: "deterministic", value: 1 } }
    : role === "queue-buffer" ? { ...base, kind: role, capacity: 10 }
      : role === "station" ? { ...base, kind: role, processingTime: { kind: "deterministic", value: 2 }, capacity: 1, queueCapacity: 20 }
        : { ...base, kind: role };
  return { id, kind: "flowNode", targetModelId: objectId, node };
}

/** 仅做合同适配；完整图校验及离散事件计算由既有 Plant Lite 实现。 */
export function compileScenePlantModel(scene: SceneSnapshot, resolvePosition: (id: string) => Vector3Value | undefined): { model: PlantLiteModel; errors: string[] } {
  const entities = scene.simulationEntities ?? [];
  const nodes = entities.filter((entity): entity is SceneFlowNode => entity.kind === "flowNode");
  const byObject = new Map(nodes.map(node => [node.targetModelId, node]));
  const errors: string[] = [];
  if (byObject.size !== nodes.length) errors.push("每个场景对象只能绑定一个物流角色");
  const bindings: NonNullable<PlantLiteModel["sceneBinding"]>["nodes"] = [];
  for (const node of nodes) {
    const position = resolvePosition(node.targetModelId);
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) errors.push(`${node.node.name}：场景对象已删除或尚未载入`);
    else bindings.push({ nodeId: node.id, objectId: node.targetModelId, position: [position.x, position.y, position.z] });
  }
  const model: PlantLiteModel = { id: `scene-logistics:${scene.id}`, name: `${scene.name} · 场景物流`, nodes: nodes.map(node => structuredClone(node.node)), edges: [], sceneBinding: { sceneId: scene.id, nodes: bindings } };
  for (const link of entities) {
    if (link.kind !== "flowLink") continue;
    const from = byObject.get(link.fromModelId), to = byObject.get(link.toModelId);
    if (!from || !to) { errors.push("流程连接的两端都需要绑定物流角色"); continue; }
    model.edges.push({ id: link.id, from: from.id, to: to.id });
  }
  const validation = validatePlantLiteModel(model);
  if (!validation.valid) errors.push(...validation.issues.map(issue => issue.message));
  return { model, errors: [...new Set(errors)] };
}

export function connectSceneFlowNodes(entities: SimulationEntityState[], from: string, to: string): SimulationEntityState[] {
  if (from === to || ![from, to].every(id => entities.some(entity => entity.kind === "flowNode" && entity.targetModelId === id))) throw new Error("请选择两个不同的物流节点");
  if (entities.some(entity => entity.kind === "flowLink" && entity.fromModelId === from && entity.toModelId === to)) return entities;
  return [...entities, { id: crypto.randomUUID(), kind: "flowLink", fromModelId: from, toModelId: to }];
}
