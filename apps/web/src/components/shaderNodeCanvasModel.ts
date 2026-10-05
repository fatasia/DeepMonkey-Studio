import type { ShaderGraphAssetV1, ShaderGraphStage } from "@bim-studio/deep-engine/shader-graph";
import type { ShaderGraphNodeInstance } from "@bim-studio/deep-engine/shader-graph";

type NodeValueType = ShaderGraphNodeInstance["type"];
import { SHADER_GRAPH_SCHEMA_VERSION, shaderGraphNodeMetadata, shaderGraphNodeRegistry,
  validateShaderGraphAsset } from "@bim-studio/deep-engine/shader-graph";

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

/** 删除节点与其关联边,并清理指向该节点的表面输出绑定(不给降级器留悬挂引用)。 */
export function removeNode(asset: ShaderGraphAssetV1, nodeId: string): ShaderGraphAssetV1 {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (!stage) return asset;
  let next: ShaderGraphAssetV1 = {
    ...asset,
    stages: replaceStage(asset.stages, {
      ...stage,
      nodes: stage.nodes.filter(n => n.id !== nodeId),
      edges: stage.edges.filter(e => e.from !== nodeId && e.to !== nodeId),
    }),
  };
  const bindings = surfaceBindings(next);
  for (const field of SURFACE_FIELD_KEYS) {
    if (bindings[field] === nodeId) next = bindSurfaceField(next, field, undefined);
  }
  return next;
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

/** 表面输出字段槽位(与引擎 ShaderStandardSurfaceFields 对齐;值为产出该字段的节点 id)。 */
export const SURFACE_FIELD_KEYS = ["baseColor", "normal", "metallic", "roughness", "occlusion", "emission", "alpha"] as const;
export type SurfaceFieldKey = (typeof SURFACE_FIELD_KEYS)[number];

/** 读取 fragment 表面输出绑定(field → 节点 id);无 surface 输出返回空表。 */
export function surfaceBindings(asset: ShaderGraphAssetV1): Partial<Record<SurfaceFieldKey, string>> {
  const stage = fragmentStageOf(asset);
  const surface = stage.outputs.find(
    output => (output as { semantic?: unknown }).semantic === "surface",
  ) as { fields?: Record<string, unknown> } | undefined;
  const result: Partial<Record<SurfaceFieldKey, string>> = {};
  if (!surface || typeof surface.fields !== "object" || surface.fields === null) return result;
  for (const key of SURFACE_FIELD_KEYS) {
    const value = surface.fields[key];
    if (typeof value === "string" && value) result[key] = value;
  }
  return result;
}

/**
 * 绑定/解绑表面输出字段:nodeId=undefined 为解绑;最后一个字段解绑后整个 surface
 * 输出条目移除(空 fields 条目对降级器是噪音)。形状对齐引擎 lowerOutput 的
 * surface 分支(model/context 为合同固定值)。
 */
export function bindSurfaceField(asset: ShaderGraphAssetV1, field: SurfaceFieldKey, nodeId: string | undefined): ShaderGraphAssetV1 {
  const stage = asset.stages.find(s => s.stage === FRAGMENT_STAGE);
  if (!stage) return asset;
  const others = stage.outputs.filter(output => (output as { semantic?: unknown }).semantic !== "surface");
  const fields: Partial<Record<SurfaceFieldKey, string>> = { ...surfaceBindings(asset) };
  if (nodeId === undefined) delete fields[field];
  else fields[field] = nodeId;
  const outputs = Object.keys(fields).length === 0 ? others
    : [...others, { semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1", fields }];
  return { ...asset, stages: replaceStage(asset.stages, { ...stage, outputs }) };
}

/** 空白图资产(画布初始化与草稿回退共用,形状同 CustomShaderEditor 既有内联值)。 */
export function emptyShaderGraph(id = "custom-material"): ShaderGraphAssetV1 {
  return { schemaVersion: SHADER_GRAPH_SCHEMA_VERSION, id, target: "webgpu-forward",
    properties: [], stages: [{ stage: FRAGMENT_STAGE, nodes: [], edges: [], outputs: [] }] };
}

/** 草稿持久化的最小存储面(组件层注入 localStorage;测试注入内存实现)。 */
export interface KeyValueStore {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 读取图草稿:仅接受 schemaVersion 匹配、target 为 forward、且通过引擎校验的资产;
 * 损坏/不合法一律返回 undefined,由调用方回退 emptyShaderGraph(绝不半信脏数据)。
 */
export function loadShaderGraphDraft(store: KeyValueStore | undefined, key: string | undefined): ShaderGraphAssetV1 | undefined {
  if (!store || !key) return undefined;
  try {
    const raw = store.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ShaderGraphAssetV1;
    if (parsed?.schemaVersion !== SHADER_GRAPH_SCHEMA_VERSION) return undefined;
    if (typeof parsed.id !== "string" || parsed.target !== "webgpu-forward" || !Array.isArray(parsed.stages)) return undefined;
    return validateShaderGraphAsset(parsed).valid ? parsed : undefined;
  } catch { return undefined; }
}

/** 已存草稿或空白图(load 的便利封装;undefined 存储/键 = 会话空白图)。 */
export function resolveShaderGraphDraft(store: KeyValueStore | undefined, key: string | undefined): ShaderGraphAssetV1 {
  return loadShaderGraphDraft(store, key) ?? emptyShaderGraph();
}

/** 写入图草稿;存储异常(配额/隐私模式)静默——草稿退化为会话内存态,不阻塞编辑。 */
export function saveShaderGraphDraft(store: KeyValueStore | undefined, key: string | undefined, asset: ShaderGraphAssetV1): void {
  if (!store || !key) return;
  try { store.setItem(key, JSON.stringify(asset)); } catch { /* ignore */ }
}
