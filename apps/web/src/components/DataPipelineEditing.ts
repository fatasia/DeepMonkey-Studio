import type { DataPipelineDefinition, DataPipelineNode } from "@bim-studio/contracts";
import { normalizeLinearPipeline } from "./DataPipelineStudioParts";

export function insertPipelineNodeAfter(
  definition: DataPipelineDefinition,
  node: DataPipelineNode,
  afterNodeId?: string,
): DataPipelineDefinition {
  const outputIndex = definition.nodes.findIndex((item) => item.type === "output");
  const fallbackIndex = outputIndex < 0 ? definition.nodes.length : outputIndex;
  const selectedIndex = definition.nodes.findIndex((item) => item.id === afterNodeId);
  const insertIndex = selectedIndex < 0
    ? fallbackIndex
    : Math.min(selectedIndex + 1, fallbackIndex);
  const nodes = [...definition.nodes];
  nodes.splice(insertIndex, 0, node);
  return normalizeLinearPipeline({ ...definition, nodes });
}
