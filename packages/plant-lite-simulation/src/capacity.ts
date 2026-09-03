import type { PlantLiteModel, PlantLiteNode } from "./modelTypes.js";

type ProcessingNode = Extract<PlantLiteNode, { kind: "station" | "transport" }>;

/**
 * 节点的真实并行能力由节点槽位和全部绑定资源共同约束。
 * 工位可同时绑定设备与人工池，有效并行能力取工位、设备、人工容量的最小值。
 */
export function plantLiteEffectiveCapacity(model: PlantLiteModel, node: ProcessingNode): number {
  const nodeCapacity = node.kind === "station" ? node.capacity ?? 1 : Number.POSITIVE_INFINITY;
  return plantLiteRequiredResourceIds(node).reduce((capacity, resourceId) => {
    const resource = model.resources?.find((candidate) => candidate.id === resourceId);
    if (!resource) throw new Error(`unknown resource ${resourceId}`);
    return Math.min(capacity, resource.capacity);
  }, nodeCapacity);
}

/** 按稳定顺序返回一次作业必须原子占用的资源。 */
export function plantLiteRequiredResourceIds(node: ProcessingNode): string[] {
  const ids = [node.resourceId];
  if (node.kind === "station") ids.push(node.workerResourceId);
  return ids.filter((id): id is string => Boolean(id));
}
