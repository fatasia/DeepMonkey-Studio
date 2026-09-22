import type { ShaderGraphAssetV1, ShaderGraphDiagnostic, ShaderGraphValidationResult } from "./graphTypes.js";
import { isShaderGraphNodeOp, shaderGraphNodeMetadata } from "./nodeRegistry.js";

export function validateShaderGraphAsset(asset: ShaderGraphAssetV1): ShaderGraphValidationResult {
  const diagnostics: ShaderGraphDiagnostic[] = [];
  const nodeIds = new Set<string>();
  const stageNames = new Set(["vertex", "fragment"]);
  asset.stages.forEach((stage, stageIndex) => {
    if (!stageNames.has(stage.stage)) diagnostics.push({ severity: "error", code: "invalid-stage",
      path: `stages[${stageIndex}].stage`, message: `Unsupported stage ${stage.stage}.` });
    const stageNodeIds = new Set<string>();
    stage.nodes.forEach((node, nodeIndex) => {
      const path = `stages[${stageIndex}].nodes[${nodeIndex}]`;
      if (stageNodeIds.has(node.id) || nodeIds.has(node.id)) diagnostics.push({ severity: "error",
        code: "duplicate-node", path: `${path}.id`, message: `Duplicate node id ${node.id}.` });
      stageNodeIds.add(node.id); nodeIds.add(node.id);
      if (!isShaderGraphNodeOp(node.op) || !shaderGraphNodeMetadata(node.op)?.stages.includes(stage.stage)) {
        diagnostics.push({ severity: "error", code: "unknown-node", path: `${path}.op`,
          message: `Node ${node.op} is not registered for ${stage.stage}.` });
      }
    });
    stage.edges.forEach((edge, edgeIndex) => {
      if (!stageNodeIds.has(edge.from) || !stageNodeIds.has(edge.to)) diagnostics.push({ severity: "error",
        code: "missing-edge", path: `stages[${stageIndex}].edges[${edgeIndex}]`,
        message: `Edge ${edge.from} -> ${edge.to} references a missing node.` });
    });
  });
  return Object.freeze({ valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) });
}
