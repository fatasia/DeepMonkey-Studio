import type { ShaderNode, ShaderStageGraph, ShaderStageOutput } from "../shader/types.js";
import type { ShaderGraphAssetV1, ShaderGraphDiagnostic, ShaderGraphEdge, ShaderGraphNodeInstance, ShaderGraphStage } from "./graphTypes.js";
import { validateShaderGraphAsset } from "./graphValidation.js";
import { shaderGraphNodeInputCount } from "./nodeRegistry.js";

export interface ShaderGraphLoweringResult {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderGraphDiagnostic[];
  readonly stages?: readonly ShaderStageGraph[];
}

/**
 * 将编辑器图降级到既有 WGSL 编译器 IR。校验 error 先行短路；输入完备性在编辑中
 * 是 warning，降级时按节点给出精确失败（nodeId 归因）——不再以 tuple 异常冒泡成
 * 「输入待补全」的粗粒度提示。
 */
export function lowerShaderGraphAsset(asset: ShaderGraphAssetV1): ShaderGraphLoweringResult {
  const validation = validateShaderGraphAsset(asset);
  if (!validation.valid) return { success: false, diagnostics: validation.diagnostics.filter(d => d.severity === "error") };
  const stages: ShaderStageGraph[] = [];
  for (const stage of asset.stages) {
    const order = topologicalOrder(stage);
    if (!order) return { success: false, diagnostics: [{ severity: "error", code: "cycle",
      path: `stages.${stage.stage}`, message: "Shader graph contains a cycle." }] };
    const nodesById = new Map(stage.nodes.map(node => [node.id, node]));
    const lowered: ShaderNode[] = [];
    for (const id of order) {
      const result = lowerNode(nodesById.get(id)!, stage.edges);
      if ("diagnostic" in result) return { success: false, diagnostics: [result.diagnostic] };
      lowered.push(result.node);
    }
    const outputs = stage.outputs.map(output => lowerOutput(output));
    stages.push(Object.freeze({ nodes: Object.freeze(lowered), outputs: Object.freeze(outputs) }));
  }
  return { success: true, diagnostics: Object.freeze([]), stages: Object.freeze(stages) };
}

function topologicalOrder(stage: ShaderGraphStage): string[] | undefined {
  const ids = stage.nodes.map(node => node.id);
  const incoming = new Map(ids.map(id => [id, 0]));
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of stage.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = ids.filter(id => incoming.get(id) === 0).sort();
  const result: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    result.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const count = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, count);
      if (count === 0) { ready.push(next); ready.sort(); }
    }
  }
  return result.length === ids.length ? result : undefined;
}

type NodeLowering = { readonly node: ShaderNode } | { readonly diagnostic: ShaderGraphDiagnostic };

function lowerNode(node: ShaderGraphNodeInstance, edges: readonly ShaderGraphEdge[]): NodeLowering {
  const inputEdges = edges.filter(edge => edge.to === node.id)
    .sort((a, b) => (a.input ?? 0) - (b.input ?? 0));
  const inputs = inputEdges.map(edge => edge.from);
  const config = node.config ?? {};
  const expected = shaderGraphNodeInputCount(node.op);
  if (expected > 0 && inputs.length !== expected) {
    return { diagnostic: { severity: "error",
      code: inputs.length < expected ? "missing-input" : "extra-input",
      path: `nodes.${node.id}`, nodeId: node.id,
      message: `Node ${node.id} (${node.op}) expects ${expected} input${expected === 1 ? "" : "s"}, ${inputs.length} connected.` } };
  }
  switch (node.op) {
    case "literal": return { node: { id: node.id, op: node.op, type: node.type,
      value: config.value as number | boolean | readonly number[] } };
    case "property": return { node: { id: node.id, op: node.op, type: node.type, name: String(config.name ?? node.id) } };
    case "attribute": return { node: { id: node.id, op: node.op, type: node.type, name: String(config.name ?? node.id) } };
    case "varying": return { node: { id: node.id, op: node.op, type: node.type, name: String(config.name ?? node.id) } };
    case "pbr-frame-view": return { node: { id: node.id, op: node.op, type: node.type } };
    case "texture-sample": return { node: { id: node.id, op: node.op, type: node.type,
      texture: String(config.texture), sampler: String(config.sampler), inputs: tuple(inputs, 1) } };
    case "select": case "clamp": case "mix": case "smoothstep":
      return { node: { id: node.id, op: node.op, type: node.type, inputs: tuple(inputs, 3) } };
    case "normalize": case "negate": case "saturate": case "one-minus": case "abs": case "floor": case "fract":
      return { node: { id: node.id, op: node.op, type: node.type, inputs: tuple(inputs, 1) } };
    case "compose-vec4": return { node: { id: node.id, op: node.op, type: node.type, inputs: tuple(inputs, 2) } };
    case "swizzle": return { node: { id: node.id, op: node.op, type: node.type, mask: String(config.mask ?? "xyz"), inputs: tuple(inputs, 1) } };
    default: return { node: { id: node.id, op: node.op, type: node.type, inputs: tuple(inputs, 2) } as ShaderNode };
  }
}

function lowerOutput(output: Readonly<Record<string, unknown>>): ShaderStageOutput {
  const semantic = String(output.semantic);
  if (semantic === "position" || semantic === "color") return { semantic, node: String(output.node) };
  if (semantic === "varying") return { semantic, name: String(output.name), node: String(output.node) };
  if (semantic === "alpha-clip") return { semantic, alpha: String(output.alpha), cutoff: String(output.cutoff) };
  return { semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
    fields: output.fields as never };
}

function tuple(values: readonly string[], count: 1): readonly [string];
function tuple(values: readonly string[], count: 2): readonly [string, string];
function tuple(values: readonly string[], count: 3): readonly [string, string, string];
function tuple(values: readonly string[], count: 1 | 2 | 3): readonly string[] {
  if (values.length !== count) throw new Error(`Shader graph node expects ${count} inputs, got ${values.length}.`);
  return values;
}
