import type { ShaderGraphAssetV1, ShaderGraphDiagnostic, ShaderGraphValidationResult } from "./graphTypes.js";
import { isShaderGraphNodeOp, shaderGraphNodeInputCount, shaderGraphNodeMetadata } from "./nodeRegistry.js";

/** 边的诊断键，与画布/编辑器模型共用同一形状：`${to}#${input ?? 0}`。 */
export function shaderGraphEdgeKey(to: string, input: number | undefined): string {
  return `${to}#${input ?? 0}`;
}

/**
 * 图结构校验：结构错误（error）阻断降级；输入完备性（warning）允许草稿在编辑中保存，
 * 由 lowering 阶段给出逐节点的精确失败。所有归因（nodeId/edgeKey）在此处产出，
 * 供画布标红与错误面板定位——不再只报索引级 path。
 */
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
        code: "duplicate-node", path: `${path}.id`, message: `Duplicate node id ${node.id}.`, nodeId: node.id });
      stageNodeIds.add(node.id); nodeIds.add(node.id);
      if (!isShaderGraphNodeOp(node.op) || !shaderGraphNodeMetadata(node.op)?.stages.includes(stage.stage)) {
        diagnostics.push({ severity: "error", code: "unknown-node", path: `${path}.op`,
          message: `Node ${node.op} is not registered for ${stage.stage}.`, nodeId: node.id });
      }
    });
    const edgeInputCounts = new Map<string, number>();
    const edgeKeys = new Set<string>();
    stage.edges.forEach((edge, edgeIndex) => {
      const path = `stages[${stageIndex}].edges[${edgeIndex}]`;
      if (!stageNodeIds.has(edge.from) || !stageNodeIds.has(edge.to)) diagnostics.push({ severity: "error",
        code: "missing-edge", path, message: `Edge ${edge.from} -> ${edge.to} references a missing node.`,
        edgeKey: shaderGraphEdgeKey(edge.to, edge.input) });
      const key = shaderGraphEdgeKey(edge.to, edge.input);
      if (edgeKeys.has(key)) diagnostics.push({ severity: "error", code: "duplicate-edge", path,
        message: `Edge into ${edge.to} input ${edge.input ?? 0} is declared more than once.`,
        edgeKey: key, nodeId: edge.to });
      edgeKeys.add(key);
      edgeInputCounts.set(edge.to, (edgeInputCounts.get(edge.to) ?? 0) + 1);
    });
    stage.nodes.forEach((node, nodeIndex) => {
      const expected = shaderGraphNodeInputCount(node.op);
      if (expected === 0) return;
      const actual = edgeInputCounts.get(node.id) ?? 0;
      const path = `stages[${stageIndex}].nodes[${nodeIndex}]`;
      if (actual < expected) diagnostics.push({ severity: "warning", code: "missing-input", path,
        message: `Node ${node.id} (${node.op}) expects ${expected} input${expected === 1 ? "" : "s"}, ${actual} connected.`,
        nodeId: node.id });
      else if (actual > expected) diagnostics.push({ severity: "warning", code: "extra-input", path,
        message: `Node ${node.id} (${node.op}) expects ${expected} input${expected === 1 ? "" : "s"}, ${actual} connected.`,
        nodeId: node.id });
    });
    stage.outputs.forEach((output, outputIndex) => {
      const path = `stages[${stageIndex}].outputs[${outputIndex}]`;
      const referenced = String((output as { node?: unknown }).node ?? "");
      if (referenced && !stageNodeIds.has(referenced)) diagnostics.push({ severity: "error",
        code: "dangling-output", path,
        message: `Output ${String((output as { semantic?: unknown }).semantic)} references missing node ${referenced}.` });
      const fields = (output as { fields?: Record<string, unknown> }).fields;
      if (typeof fields === "object" && fields !== null) {
        for (const [field, value] of Object.entries(fields)) {
          const fieldNode = String(value ?? "");
          if (fieldNode && !stageNodeIds.has(fieldNode)) diagnostics.push({ severity: "error",
            code: "dangling-output", path: `${path}.fields.${field}`,
            message: `Surface field ${field} references missing node ${fieldNode}.` });
        }
      }
      if ((output as { semantic?: unknown }).semantic === "alpha-clip") {
        for (const key of ["alpha", "cutoff"] as const) {
          const clipNode = String((output as Record<string, unknown>)[key] ?? "");
          if (clipNode && !stageNodeIds.has(clipNode)) diagnostics.push({ severity: "error",
            code: "dangling-output", path: `${path}.${key}`,
            message: `Alpha clip ${key} references missing node ${clipNode}.` });
        }
      }
    });
  });
  // valid = 无 error（warning 仅是编辑中的输入完备性提示，不阻断降级与草稿加载）。
  const hasErrors = diagnostics.some(diagnostic => diagnostic.severity === "error");
  return Object.freeze({ valid: !hasErrors, diagnostics: Object.freeze(diagnostics) });
}
