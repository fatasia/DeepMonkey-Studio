import type { ShaderGraphAssetV1, ShaderGraphStage } from "@bim-studio/deep-engine/shader-graph";
import type { ShaderGraphNodeInstance } from "@bim-studio/deep-engine/shader-graph";

type NodeValueType = ShaderGraphNodeInstance["type"];
import { shaderGraphNodeMetadata, shaderGraphNodeRegistry } from "@bim-studio/deep-engine/shader-graph";

/** 画布节点 UI 态(位置不进资产合同;由画布本地保存)。 */
export interface CanvasNodePosition { x: number; y: number }

export const FRAGMENT_STAGE: ShaderGraphStage["stage"] = "fragment";

/** 深拷贝 asset 的 fragment stage(M1 只编辑 fragment;vertex/stage 输出层 M2)。 */
export function fragmentStageOf(asset: ShaderGraphAssetV1): ShaderGraphStage {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (stage) return stage;
  return { stage: FRAGMENT_STAGE, nodes: [], edges: [], outputs: [] };
}

/** 注册表按类目分组(画布侧栏调色板)。 */
export function registryByCategory(): Record<string, readonly string[]> {
  const groups: Record<string, string[]> = {};
  for (const meta of shaderGraphNodeRegistry()) {
    (groups[meta.category] ??= []).push(meta.op);
  }
  return groups;
}

/** 添加节点:生成确定性 id(op 序号递增),带默认 config(literal 给 0)。 */
export function addNode(asset: ShaderGraphAssetV1, op: string): { asset: ShaderGraphAssetV1; nodeId: string } {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  const existing = stage?.nodes ?? [];
  const meta = shaderGraphNodeMetadata(op as never);
  if (!meta) throw new Error(`unknown node op: ${op}`);
  let seq = existing.filter(n => n.op === op).length + 1;
  let nodeId = `${op}-${seq}`;
  const taken = new Set(existing.map(n => n.id));
  while (taken.has(nodeId)) { seq += 1; nodeId = `${op}-${seq}`; }
  const node: ShaderGraphNodeInstance = {
    id: nodeId,
    op: op as never,
    type: defaultTypeFor(meta ?? { ports: [] }),
    ...(op === "literal" ? { config: { value: 0 } } : {}),
    ...(op === "property" || op === "attribute" || op === "varying" ? { config: { name: "" } } : {}),
  };
  const nextStage: ShaderGraphStage = stage
    ? { ...stage, nodes: [...stage.nodes, node] }
    : { stage: FRAGMENT_STAGE, nodes: [node], edges: [], outputs: [] };
  return {
    asset: { ...asset, stages: replaceStage(asset.stages, nextStage) },
    nodeId,
  };
}

/** 删除节点与其关联边。 */
export function removeNode(asset: ShaderGraphAssetV1, nodeId: string): ShaderGraphAssetV1 {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (!stage) return asset;
  return {
    ...asset,
    stages: replaceStage(asset.stages, {
      ...stage,
      nodes: stage.nodes.filter(n => n.id !== nodeId),
      edges: stage.edges.filter(e => e.from !== nodeId && e.to !== nodeId),
    }),
  };
}

/** 更新节点 config(literal value/property name 等)。 */
export function updateNodeConfig(asset: ShaderGraphAssetV1, nodeId: string, config: Readonly<Record<string, unknown>>): ShaderGraphAssetV1 {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (!stage) return asset;
  return {
    ...asset,
    stages: replaceStage(asset.stages, {
      ...stage,
      nodes: stage.nodes.map(n => n.id === nodeId ? { ...n, config } : n),
    }),
  };
}

/** 连线:输出节点 → 输入节点(端口槽位 = 目标输入序)。 */
export function connect(asset: ShaderGraphAssetV1, from: string, to: string, input: number): ShaderGraphAssetV1 {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (!stage) return asset;
  const filtered = stage.edges.filter(e => !(e.to === to && e.input === input));
  return { ...asset, stages: replaceStage(asset.stages, { ...stage, edges: [...filtered, { from, to, input }] }) };
}

/** 断开连线。 */
export function disconnect(asset: ShaderGraphAssetV1, from: string, to: string, input: number): ShaderGraphAssetV1 {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (!stage) return asset;
  return { ...asset, stages: replaceStage(asset.stages, { ...stage, edges: stage.edges.filter(e => !(e.from === from && e.to === to && e.input === input)) }) };
}

/** asset → ReactFlow 节点数据(位置由调用方本地态合并)。 */
export function canvasNodes(asset: ShaderGraphAssetV1): Array<{ id: string; label: string; category: string; type: string; config: Readonly<Record<string, unknown>> | undefined }> {
  const registry = shaderGraphNodeRegistry();
  const metaByOp = new Map(registry.map(m => [m.op as string, m]));
  return fragmentStageOf(asset).nodes.map(node => {
    const meta = metaByOp.get(node.op);
    return {
      id: node.id,
      label: meta?.label ?? node.op,
      category: meta?.category ?? "math",
      type: node.type,
      config: node.config,
    };
  });
}

/** asset → ReactFlow 边数据。 */
export function canvasEdges(asset: ShaderGraphAssetV1): Array<{ id: string; source: string; target: string; targetHandle: string }> {
  return fragmentStageOf(asset).edges.map((edge, index) => ({
    id: `edge-${index}`,
    source: edge.from,
    target: edge.to,
    targetHandle: edge.input === undefined ? "in" : `in-${edge.input}`,
  }));
}

function defaultTypeFor(meta: { ports: readonly { direction: string; type: NodeValueType }[] }): NodeValueType {
  const out = meta.ports.find(p => p.direction === "output");
  return out?.type ?? "f32";
}

function replaceStage(stages: readonly ShaderGraphStage[], next: ShaderGraphStage): readonly ShaderGraphStage[] {
  return stages.map(s => s.stage === FRAGMENT_STAGE ? next : s);
}
