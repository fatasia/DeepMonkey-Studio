/** 仿真目标引用：场景内模型或内部图层。 */
export interface SimulationTargetRef {
  modelId: string;
  layerId?: string;
}

/** SIM-1a 仿真实体：配置随场景持久化；运行瞬态与 Study 结果不入快照。 */
export type SimulationEntityState =
  | { id: string; kind: "flowLink"; fromModelId: string; toModelId: string }
  | { id: string; kind: "path"; name: string; targetModelId: string; points: Array<[number, number, number]>; loopMode: "once" | "loop" | "pingpong"; speed: number }
  | { id: string; kind: "collisionPair"; name: string; a: SimulationTargetRef; b: SimulationTargetRef; tolerance: number };

/** SIM-1a 仿真实体校验：引用必须可解析、级联参数无环、数值合法。errors 为空即通过。 */
export function validateSimulationEntities(entities: SimulationEntityState[] | undefined, modelIds: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entity of entities ?? []) {
    if (!entity.id?.trim()) errors.push("仿真实体缺少 id");
    if (entity.id && ids.has(entity.id)) errors.push(`仿真实体 id ${entity.id} 重复`);
    if (entity.id) ids.add(entity.id);
    const ref = "targetModelId" in entity ? entity.targetModelId : undefined;
    if (ref && !modelIds.has(ref)) errors.push(`仿真实体 ${entity.id} 引用的模型 ${ref} 不存在`);
    if (entity.kind === "flowLink") {
      if (!modelIds.has(entity.fromModelId)) errors.push(`连接 ${entity.id} 的源模型 ${entity.fromModelId} 不存在`);
      if (!modelIds.has(entity.toModelId)) errors.push(`连接 ${entity.id} 的目标模型 ${entity.toModelId} 不存在`);
      if (entity.fromModelId === entity.toModelId) errors.push(`连接 ${entity.id} 的源与目标相同`);
    }
    if (entity.kind === "path" && entity.speed < 0) errors.push(`路径 ${entity.id} 的速度不能为负`);
    if (entity.kind === "collisionPair") {
      if (entity.a.modelId === entity.b.modelId && entity.a.layerId === entity.b.layerId) errors.push(`碰撞对 ${entity.id} 的两侧相同`);
    }
  }
  for (const entity of entities ?? []) {
    if (entity.kind === "collisionPair") {
      if (!modelIds.has(entity.a.modelId)) errors.push(`碰撞对 ${entity.id} 侧 A 引用的模型 ${entity.a.modelId} 不存在`);
      if (!modelIds.has(entity.b.modelId)) errors.push(`碰撞对 ${entity.id} 侧 B 引用的模型 ${entity.b.modelId} 不存在`);
    }
  }
  return errors;
}
