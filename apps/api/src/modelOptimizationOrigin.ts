import type { ModelRecord } from "@bim-studio/contracts";

/** 来源从当前项目的权威模型解析，客户端不得自报许可或跨项目拼接谱系。 */
export function resolveModelOptimizationOrigin(sourceId: unknown, models: ModelRecord[]): ModelRecord["optimization"] {
  if (sourceId === undefined) return undefined;
  if (typeof sourceId !== "string" || !sourceId || sourceId.length > 128) throw new Error("优化来源模型无效");
  const source = models.find(model => model.id === sourceId);
  if (!source || source.status !== "ready") throw new Error("优化来源必须是当前项目中可使用的模型");
  const origin = source.libraryOrigin ?? source.optimization?.libraryOrigin;
  return {
    sourceModelId: source.id, sourceModelName: source.name, sourceUpdatedAt: source.updatedAt,
    ...(origin ? { libraryOrigin: structuredClone(origin) } : {}),
  };
}
