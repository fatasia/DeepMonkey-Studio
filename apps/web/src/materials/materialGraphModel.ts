import type { PresetMaterialValues } from "./industrialMaterialPresets";

/**
 * 分层材质图数据模型(编辑器刀 7,轻量版)。
 *
 * 定位:底材质(既有 PBR 参数)+ ≤4 个调整层(颜色/粗糙度/金属度/凹凸 × 遮罩),
 * 编译为运行时可用的"参数+预合成贴图"组合(编辑器侧预合成,零引擎改动)。
 * 不做通用 shader 编译器、不做自定义 HLSL(那是 ShaderNodeCanvas + DeepSL 的领域)。
 *
 * 与预设库(刀 5)互通:预设 = 单节点快捷方式 —— `applyPresetToGraphBase` 把预设
 * 参数组合写入底材质节点;图再在其上叠层。两者共用既有材质写入路径
 * (updateSelectionMaterial → selectionMaterialCommand)。
 */

/** 单图调整层上限;超过即拒绝(轻量红线,防滥用成通用节点编辑器)。 */
export const MATERIAL_GRAPH_MAX_LAYERS = 4;

/** 预合成贴图边长(正方形);编译输出经 UV 重复平铺,256 平衡质量与 dataURL 体积。 */
export const MATERIAL_GRAPH_TEXTURE_SIZE = 256;

export type MaterialGraphMaskKind = "wear" | "dust" | "stripes" | "texture";

export const MATERIAL_GRAPH_MASK_KINDS: ReadonlyArray<{ kind: MaterialGraphMaskKind; zh: string; en: string }> = [
  { kind: "wear", zh: "磨损划痕", en: "Wear & scratches" },
  { kind: "dust", zh: "灰尘污渍", en: "Dust & stains" },
  { kind: "stripes", zh: "条纹标带", en: "Stripes" },
  { kind: "texture", zh: "纹理遮罩", en: "Texture mask" },
];

/** 遮罩参数域:程序化 3 种共用采样参数;texture 另带上传的 dataURL 灰度图。 */
export interface MaterialGraphMask {
  kind: MaterialGraphMaskKind;
  /** 确定性种子(整数);同图同输出字节的根。 */
  seed: number;
  /** 图案密度 1–8(周期格数,平铺无缝)。 */
  scale: number;
  /** 覆盖率 0–1(阈值方向:值越大遮罩面积越大)。 */
  coverage: number;
  /** 边缘柔和 0–1。 */
  softness: number;
  /** 图案角度(度,条纹/划痕方向)。 */
  angle: number;
  /** texture 遮罩的灰度源(dataURL);文件 ≤256KB。 */
  textureName?: string;
  textureUrl?: string;
}

/** 调整层:每通道独立开关,遮罩只作用于启用通道。 */
export interface MaterialGraphLayer {
  id: string;
  name: string;
  enabled: boolean;
  /** 颜色混合方式:mix 线性插值 / multiply 正片叠底。 */
  blend: "mix" | "multiply";
  color: string;
  useColor: boolean;
  roughness: number;
  useRoughness: boolean;
  metalness: number;
  useMetalness: boolean;
  /** 凹凸高度贡献 0–1(编译为法线贴图)。 */
  bump: number;
  /** 层强度 0–1(整体透明度,乘进遮罩)。 */
  opacity: number;
  mask: MaterialGraphMask;
}

/** 底材质节点 = 既有 PBR 参数快照(编译合成的基底,不直接写回对象)。 */
export interface MaterialGraphBase {
  color: string;
  metalness: number;
  roughness: number;
}

export interface MaterialGraphDefinition {
  /** 合同版本;序列化演进从 2 开始。 */
  version: 1;
  id: string;
  name: string;
  base: MaterialGraphBase;
  layers: MaterialGraphLayer[];
  updatedAt: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const SEED_MIN = 1;
const SEED_MAX = 9999;

function clamp01(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function normalizeMask(input: Partial<MaterialGraphMask> | undefined): MaterialGraphMask {
  const kind: MaterialGraphMaskKind = input?.kind && MATERIAL_GRAPH_MASK_KINDS.some(item => item.kind === input.kind) ? input.kind : "wear";
  const rawSeed = typeof input?.seed === "number" && Number.isFinite(input.seed) ? Math.round(input.seed) : 7;
  const rawScale = typeof input?.scale === "number" && Number.isFinite(input.scale) ? input.scale : 3;
  const mask: MaterialGraphMask = {
    kind,
    seed: Math.min(SEED_MAX, Math.max(SEED_MIN, rawSeed)),
    scale: Math.min(8, Math.max(1, rawScale)),
    coverage: clamp01(input?.coverage, 0.45),
    softness: clamp01(input?.softness, 0.3),
    angle: typeof input?.angle === "number" && Number.isFinite(input.angle)
      ? ((input.angle % 360) + 360) % 360
      : 0,
  };
  if (kind === "texture") {
    if (typeof input?.textureUrl === "string" && input.textureUrl) mask.textureUrl = input.textureUrl;
    if (typeof input?.textureName === "string" && input.textureName) mask.textureName = input.textureName;
  }
  return mask;
}

function normalizeLayer(input: Partial<MaterialGraphLayer>, index: number): MaterialGraphLayer {
  const blend = input.blend === "multiply" ? "multiply" : "mix";
  return {
    id: typeof input.id === "string" && input.id ? input.id : `layer-${index + 1}`,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : `调整层 ${index + 1}`,
    enabled: input.enabled !== false,
    blend,
    color: typeof input.color === "string" && HEX.test(input.color) ? input.color : "#8a6a3f",
    useColor: input.useColor === true,
    roughness: clamp01(input.roughness, 0.7),
    useRoughness: input.useRoughness === true,
    metalness: clamp01(input.metalness, 0),
    useMetalness: input.useMetalness === true,
    bump: clamp01(input.bump, 0),
    opacity: clamp01(input.opacity, 1),
    mask: normalizeMask(input.mask),
  };
}

/** 反序列化唯一入口:越界值收敛到合法域而非拒绝(定义可持久化,容错优先)。 */
export function normalizeMaterialGraph(input: unknown, fallbackName: string): MaterialGraphDefinition {
  const source = (typeof input === "object" && input !== null ? input : {}) as Partial<MaterialGraphDefinition>;
  const layers = Array.isArray(source.layers) ? source.layers.slice(0, MATERIAL_GRAPH_MAX_LAYERS) : [];
  return {
    version: 1,
    id: typeof source.id === "string" && source.id ? source.id : `matgraph:${crypto.randomUUID()}`,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : fallbackName,
    base: {
      color: typeof source.base?.color === "string" && HEX.test(source.base.color) ? source.base.color : "#9aa2a9",
      metalness: clamp01(source.base?.metalness, 0.1),
      roughness: clamp01(source.base?.roughness, 0.5),
    },
    layers: layers.map((layer, index) => normalizeLayer((layer ?? {}) as Partial<MaterialGraphLayer>, index)),
    updatedAt: typeof source.updatedAt === "string" && source.updatedAt ? source.updatedAt : new Date().toISOString(),
  };
}

/** 新建遮罩默认参数(按类型给出工业常用初值)。 */
export function defaultMask(kind: MaterialGraphMaskKind): MaterialGraphMask {
  const common = { kind, seed: 7, coverage: 0.45, softness: 0.3, angle: 0 };
  if (kind === "wear") return { ...common, seed: 12, scale: 5, coverage: 0.35, softness: 0.22, angle: 30 };
  if (kind === "dust") return { ...common, seed: 7, scale: 2.5, coverage: 0.5, softness: 0.55 };
  if (kind === "stripes") return { ...common, seed: 1, scale: 6, coverage: 0.4, softness: 0.05, angle: 0 };
  return { ...common, scale: 4, softness: 0.5 };
}

let layerCounter = 0;

/** 新建层:确定性 id(画布回放/测试可复现);id 冲突由调用方经 uniqueLayerId 处理。 */
export function createLayer(kind: MaterialGraphMaskKind = "wear", name?: string): MaterialGraphLayer {
  layerCounter += 1;
  return {
    id: `layer-${Date.now().toString(36)}-${layerCounter}`,
    name: name ?? `调整层 ${layerCounter}`,
    enabled: true,
    blend: "mix",
    color: "#8a6a3f",
    useColor: true,
    roughness: 0.72,
    useRoughness: true,
    metalness: 0,
    useMetalness: false,
    bump: 0.25,
    opacity: 1,
    mask: defaultMask(kind),
  };
}

/** 空图(仅底材质+输出);层由用户添加。 */
export function createMaterialGraph(name: string, base?: Partial<MaterialGraphBase>): MaterialGraphDefinition {
  return {
    version: 1,
    id: `matgraph:${crypto.randomUUID()}`,
    name,
    base: { color: base?.color ?? "#9aa2a9", metalness: base?.metalness ?? 0.1, roughness: base?.roughness ?? 0.5 },
    layers: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 预设库互通接口:把预设参数组合写入底材质节点(预设=单节点快捷方式)。 */
export function applyPresetToGraphBase(
  graph: MaterialGraphDefinition,
  preset: Pick<PresetMaterialValues, "color" | "metalness" | "roughness">,
): MaterialGraphDefinition {
  return {
    ...graph,
    base: {
      color: HEX.test(preset.color) ? preset.color : graph.base.color,
      metalness: clamp01(preset.metalness, graph.base.metalness),
      roughness: clamp01(preset.roughness, graph.base.roughness),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** 校验:返回可读问题列表(空 = 合法);域约束与 normalize 收敛域一致。 */
export function validateMaterialGraph(graph: MaterialGraphDefinition): string[] {
  const problems: string[] = [];
  if (!HEX.test(graph.base.color)) problems.push("底材质颜色必须是 #RRGGBB");
  if (graph.layers.length > MATERIAL_GRAPH_MAX_LAYERS) problems.push(`调整层不能超过 ${MATERIAL_GRAPH_MAX_LAYERS} 层`);
  graph.layers.forEach((layer, index) => {
    const label = `第 ${index + 1} 层「${layer.name}」`;
    if (!HEX.test(layer.color)) problems.push(`${label}颜色必须是 #RRGGBB`);
    if (!layer.useColor && !layer.useRoughness && !layer.useMetalness && layer.bump <= 0) {
      problems.push(`${label}未启用任何通道`);
    }
    if (layer.mask.kind === "texture" && !layer.mask.textureUrl) problems.push(`${label}纹理遮罩缺少贴图`);
    if (typeof layer.mask.seed !== "number" || !Number.isInteger(layer.mask.seed) || layer.mask.seed < SEED_MIN || layer.mask.seed > SEED_MAX) {
      problems.push(`${label}遮罩种子必须是 ${SEED_MIN}–${SEED_MAX} 的整数`);
    }
  });
  return problems;
}

/** 画布派生:节点集合(输出/底材质/层/遮罩)。位置由画布本地态管理,不入定义。 */
export type MaterialGraphNodeKind = "output" | "base" | "layer" | "mask";

export interface MaterialGraphNode {
  id: string;
  kind: MaterialGraphNodeKind;
  layerId?: string;
  title: string;
  subtitle: string;
}

/** 画布派生:边(mask→layer、layer→output、base→output);顺序确定性。 */
export interface MaterialGraphEdge {
  id: string;
  from: string;
  to: string;
  fromPort: "out";
  toPort: "in";
}

export function deriveGraphNodes(graph: MaterialGraphDefinition): MaterialGraphNode[] {
  const nodes: MaterialGraphNode[] = [{ id: "output", kind: "output", title: "输出", subtitle: "PBR 材质" }];
  nodes.push({ id: "base", kind: "base", title: "底材质", subtitle: `${graph.base.color} · 粗${graph.base.roughness.toFixed(2)} 金${graph.base.metalness.toFixed(2)}` });
  graph.layers.forEach((layer) => {
    nodes.push({
      id: layer.id,
      kind: "layer",
      layerId: layer.id,
      title: layer.name,
      subtitle: `${layer.enabled ? "" : "已停用 · "}${[layer.useColor && "色", layer.useRoughness && "粗", layer.useMetalness && "金", layer.bump > 0 && "凹"].filter(Boolean).join("/") || "无通道"}`,
    });
    nodes.push({
      id: `mask:${layer.id}`,
      kind: "mask",
      layerId: layer.id,
      title: "遮罩",
      subtitle: MATERIAL_GRAPH_MASK_KINDS.find(item => item.kind === layer.mask.kind)?.zh ?? layer.mask.kind,
    });
  });
  return nodes;
}

export function deriveGraphEdges(graph: MaterialGraphDefinition): MaterialGraphEdge[] {
  const edges: MaterialGraphEdge[] = [{ id: "edge-base-output", from: "base", to: "output", fromPort: "out", toPort: "in" }];
  for (const layer of graph.layers) {
    edges.push({ id: `edge-mask-${layer.id}`, from: `mask:${layer.id}`, to: layer.id, fromPort: "out", toPort: "in" });
    edges.push({ id: `edge-${layer.id}-output`, from: layer.id, to: "output", fromPort: "out", toPort: "in" });
  }
  return edges;
}
