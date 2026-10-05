import type { SceneMaterialGraphDefinition, SceneMaterialState, SceneSnapshot } from "@bim-studio/contracts";
import type { MaterialGraphDefinition } from "./materialGraphModel";
import { normalizeMaterialGraph } from "./materialGraphModel";

/**
 * 材质图定义持久化(Tier-2:迁 SceneSnapshot.materialGraphs)。
 *
 * 持久化分层(诚实边界):
 * - 编译结果(参数+预合成贴图 dataURL)走既有材质序列化 —— 随场景快照保存/发布,
 *   观众端与导出可见,零契约改动;
 * - 可编辑图定义自 Tier-2 起存 SceneSnapshot.materialGraphs(键 = 场景对象 id),
 *   保存/发布/导出/复制经快照序列化自动携带;场景读写面由持久化控制器装配时经
 *   setMaterialGraphSceneBridge 注入(先于任何编辑器子组件 effect,无时序竞态);
 * - v1 的 localStorage(键 = sceneId:modelId)仅保留一次性迁移读取:快照缺失该
 *   对象定义且旧键存在时,迁入快照并清除旧键;接桥后的写路径只做残键清理,不再落盘;
 * - 未接桥环境(组件单测/预览渲染)回落 v1 localStorage 行为,不参与生产持久化;
 * - 接管登记(原材质捕获)是运行时撤销辅助、不入场景契约,仍存 localStorage。
 */

/** 场景快照读写面:由场景持久化控制器注入,store 据此经快照存取图定义。 */
export interface MaterialGraphSceneBridge {
  /** 读取活动场景快照;场景 id 不匹配(已切换/未载入)返回 undefined。 */
  getScene(sceneId: string): SceneSnapshot | undefined;
  /** 写回单对象图定义;graph = undefined 表示删除该对象条目;写他场景静默拒绝。 */
  commitMaterialGraph(sceneId: string, modelId: string, graph: MaterialGraphDefinition | undefined): void;
}

let sceneBridge: MaterialGraphSceneBridge | undefined;

/** 接线点:场景持久化控制器装配时调用;传 undefined 解除(测试隔离用)。 */
export function setMaterialGraphSceneBridge(bridge: MaterialGraphSceneBridge | undefined): void {
  sceneBridge = bridge;
}

const KEY_PREFIX = "bim-studio.material-graph";
const CAPTURE_PREFIX = "bim-studio.material-graph.capture";
const MAX_TEXTURE_URL_BYTES = 256 * 1024;

export function graphStorageKey(sceneId: string, modelId: string): string {
  return `${KEY_PREFIX}:${sceneId}:${modelId}`;
}

/** 结构可信性闸:非对象或缺 layers 数组视为损坏(拒收);字段级越界交给 normalize 收敛。 */
function isPlausibleGraph(input: unknown): input is SceneMaterialGraphDefinition {
  return typeof input === "object" && input !== null && Array.isArray((input as { layers?: unknown }).layers);
}

/** v1 残键清理(只清图定义键;接管捕获键由 capture/delete 各自管理)。 */
function purgeLegacyKey(sceneId: string, modelId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(graphStorageKey(sceneId, modelId));
}

/**
 * 读取图定义:快照优先;缺失时执行 v1 → 快照一次性迁移;损坏条目拒收并清除,
 * 不给消费方喂毒数据。
 */
export function loadMaterialGraph(sceneId: string, modelId: string): MaterialGraphDefinition | undefined {
  const stored = sceneBridge?.getScene(sceneId)?.materialGraphs?.[modelId];
  if (stored !== undefined) {
    purgeLegacyKey(sceneId, modelId); // 快照已是权威,顺手清掉 v1 残键
    if (!isPlausibleGraph(stored)) {
      sceneBridge?.commitMaterialGraph(sceneId, modelId, undefined); // 快照内损坏条目摘除
      return undefined;
    }
    return normalizeMaterialGraph(stored, "恢复的材质图");
  }
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(graphStorageKey(sceneId, modelId));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlausibleGraph(parsed)) throw new Error("损坏的材质图定义");
    const graph = normalizeMaterialGraph(parsed, "恢复的材质图");
    if (sceneBridge) {
      // 一次性迁移:定义迁入快照后清除旧键。
      sceneBridge.commitMaterialGraph(sceneId, modelId, graph);
      localStorage.removeItem(graphStorageKey(sceneId, modelId));
    }
    return graph;
  } catch {
    localStorage.removeItem(graphStorageKey(sceneId, modelId));
    return undefined;
  }
}

/** 写入图定义;接桥时写快照(场景不匹配拒绝),未接桥回落 v1 localStorage。 */
export function saveMaterialGraph(sceneId: string, modelId: string, graph: MaterialGraphDefinition): boolean {
  if (sceneBridge) {
    if (!sceneBridge.getScene(sceneId)) return false; // 场景已切换/未载入:拒绝写错场景
    sceneBridge.commitMaterialGraph(sceneId, modelId, structuredClone(graph));
    purgeLegacyKey(sceneId, modelId);
    return true;
  }
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(graphStorageKey(sceneId, modelId), JSON.stringify(graph));
    return true;
  } catch {
    return false;
  }
}

export function deleteMaterialGraph(sceneId: string, modelId: string): void {
  if (sceneBridge && sceneBridge.getScene(sceneId)) {
    sceneBridge.commitMaterialGraph(sceneId, modelId, undefined);
  }
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(graphStorageKey(sceneId, modelId));
  localStorage.removeItem(`${CAPTURE_PREFIX}:${sceneId}:${modelId}`);
}

/** 纹理遮罩大小闸:超限拒绝上传(dataURL 入库前拦截)。 */
export function isTextureMaskUrlSizeOk(dataUrl: string): boolean {
  return dataUrl.length <= MAX_TEXTURE_URL_BYTES;
}

/** 图接管的贴图槽键(还原时显式回填)。 */
const GRAPH_OWNED_TEXTURE_KEYS = [
  "baseColorMapUrl", "baseColorMapName",
  "roughnessMapUrl", "roughnessMapName",
  "metalnessMapUrl", "metalnessMapName",
  "normalMapUrl", "normalMapName",
] as const satisfies ReadonlyArray<keyof SceneMaterialState>;

/** 图接管的标量键。 */
const GRAPH_OWNED_SCALAR_KEYS = ["roughness", "metalness", "normalScale"] as const satisfies ReadonlyArray<keyof SceneMaterialState>;

/** 首次应用前捕获对象原材质(仅捕获图会接管的键;JSON 往返防引用漂移)。 */
export function captureOriginalMaterial(sceneId: string, modelId: string, material: SceneMaterialState): void {
  if (typeof localStorage === "undefined") return;
  const snapshot: Record<string, unknown> = {};
  for (const key of [...GRAPH_OWNED_TEXTURE_KEYS, ...GRAPH_OWNED_SCALAR_KEYS]) {
    const value = material[key];
    if (value !== undefined) snapshot[key] = structuredClone(value as unknown);
  }
  try {
    localStorage.setItem(`${CAPTURE_PREFIX}:${sceneId}:${modelId}`, JSON.stringify(snapshot));
  } catch {
    /* 配额满时放弃捕获;还原按钮此时不可用,面板按无捕获渲染 */
  }
}

/** 读取捕获的原材质;无捕获返回 undefined。 */
export function loadCapturedMaterial(sceneId: string, modelId: string): SceneMaterialState | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(`${CAPTURE_PREFIX}:${sceneId}:${modelId}`);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SceneMaterialState;
  } catch {
    return undefined;
  }
}

/**
 * 断开图还原 patch:图接管键全部回填原值;原图没有的键显式 ""(贴图槽)/undefined 语义
 * 由调用方处理 —— 引擎对贴图 url==="" 执行清槽;标量键缺失 = 不动,故标量必须回填,
 * 否则残留 1(打包贴图语义)。捕获里没有的标量键回 PBR 中性值。
 */
export function restoreMaterialPatch(sceneId: string, modelId: string): SceneMaterialState | undefined {
  const captured = loadCapturedMaterial(sceneId, modelId);
  if (!captured) return undefined;
  const patch: Record<string, unknown> = {};
  for (const key of GRAPH_OWNED_TEXTURE_KEYS) {
    const value = captured[key];
    patch[key] = typeof value === "string" && value ? value : "";
  }
  for (const key of GRAPH_OWNED_SCALAR_KEYS) {
    const value = captured[key];
    patch[key] = typeof value === "number" ? value : key === "normalScale" ? 1 : 0.5;
  }
  return patch as SceneMaterialState;
}
