import type { SceneMaterialState } from "@bim-studio/contracts";
import type { MaterialGraphDefinition } from "./materialGraphModel";
import { normalizeMaterialGraph } from "./materialGraphModel";

/**
 * 材质图定义持久化(编辑器刀 7,v1 层)。
 *
 * 持久化分层(诚实边界):
 * - 编译结果(参数+预合成贴图 dataURL)走既有材质序列化 —— 随场景快照保存/发布,
 *   观众端与导出可见,零契约改动;
 * - 可编辑图定义 v1 存 localStorage(键 = sceneId:modelId),刷新/重开自动恢复;
 *   场景导出不携带定义 —— Tier-2(刀 5 契约落定后)迁 SceneSnapshot.materialGraphs,
 *   本模块即唯一搬迁点(读写都过这两个函数)。
 *
 * 接管登记:图首次应用前捕获对象原材质状态;"断开图"用它还原(贴图槽显式回填,
 * 引擎对 url==="" 执行清槽、undefined 视为不动)。
 */

const KEY_PREFIX = "bim-studio.material-graph";
const CAPTURE_PREFIX = "bim-studio.material-graph.capture";
const MAX_TEXTURE_URL_BYTES = 256 * 1024;

export function graphStorageKey(sceneId: string, modelId: string): string {
  return `${KEY_PREFIX}:${sceneId}:${modelId}`;
}

/** 读取图定义;缺失/损坏返回 undefined(损坏时清键,不留毒数据)。 */
export function loadMaterialGraph(sceneId: string, modelId: string): MaterialGraphDefinition | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(graphStorageKey(sceneId, modelId));
  if (!raw) return undefined;
  try {
    return normalizeMaterialGraph(JSON.parse(raw) as unknown, "恢复的材质图");
  } catch {
    localStorage.removeItem(graphStorageKey(sceneId, modelId));
    return undefined;
  }
}

/** 写入图定义;超配额时静默失败(定义小,贴图 dataURL 是唯一膨胀源,已限 256KB)。 */
export function saveMaterialGraph(sceneId: string, modelId: string, graph: MaterialGraphDefinition): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(graphStorageKey(sceneId, modelId), JSON.stringify(graph));
    return true;
  } catch {
    return false;
  }
}

export function deleteMaterialGraph(sceneId: string, modelId: string): void {
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
