import type { ModelRecord, ParametricCadBuildSummary, ParametricCadDefinition, ParametricModelGeneration } from "@bim-studio/contracts";
import { cloneParametricDefinition } from "@bim-studio/parametric-modeling-plugin";

/** 从一次确定性构建结果生成可持久化证据；版本关系集中在这里，避免 UI 拼装出断裂版本。 */
export function createParametricGeneration(
  definition: ParametricCadDefinition,
  build: ParametricCadBuildSummary,
  previous?: ModelRecord,
  generatedAt = new Date().toISOString()
): ParametricModelGeneration {
  let revision = 1;
  let supersedesModelId: string | undefined;
  if (previous?.generation?.kind === "parametric") {
    revision = previous.generation.revision + 1;
    supersedesModelId = previous.id;
  }
  return {
    kind: "parametric",
    generatorId: "bim.parametric-modeling",
    generatorVersion: "1.0.0",
    definition: cloneParametricDefinition(definition),
    revision,
    generatedAt,
    build: structuredClone(build),
    ...(supersedesModelId ? { supersedesModelId } : {})
  };
}
