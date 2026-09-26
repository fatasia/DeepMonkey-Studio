import type {
  ModelFormat,
  ModelStructureNode,
  ModelStructurePropertiesResponse,
  ModelStructurePropertyEntry,
  ModelStructureResponse,
} from "@bim-studio/contracts";

/** 结构侧车（hierarchy.json / properties.json）的只读裁剪层：
 *  展示需要的是层级与计数，不是 meshIds、装配路径这类随装配规模线性膨胀的大数组。 */

export const MODEL_STRUCTURE_NODE_LIMIT = 50_000;
export const MODEL_STRUCTURE_PROPERTY_ID_LIMIT = 16;
export const MODEL_STRUCTURE_MESH_SAMPLE_LIMIT = 8;
export const MODEL_STRUCTURE_JSON_LIMIT_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const optionalCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export interface SlimHierarchyInput {
  sourceFormat: ModelFormat;
  sourceName: string;
}

export type SlimHierarchyResult =
  | { ok: false; message: string }
  | { ok: true; value: ModelStructureResponse };

/** 校验并裁剪 hierarchy.json：丢弃大数组，仅保留 id/name/type/meshCount/childCount/children。 */
export function slimModelHierarchy(raw: unknown, input: SlimHierarchyInput): SlimHierarchyResult {
  if (!isRecord(raw) || !isRecord(raw.root)) return { ok: false, message: "hierarchy.json 缺少 root 节点" };
  let nodeCount = 0;
  let truncated = false;
  const walk = (value: unknown): ModelStructureNode | undefined => {
    if (!isRecord(value)) return undefined;
    const id = optionalText(value.id);
    if (!id) return undefined;
    if (nodeCount >= MODEL_STRUCTURE_NODE_LIMIT) {
      truncated = true;
      return undefined;
    }
    nodeCount += 1;
    const rawChildren = Array.isArray(value.children) ? value.children : [];
    const children: ModelStructureNode[] = [];
    for (const child of rawChildren) {
      const slimmed = walk(child);
      if (slimmed) children.push(slimmed);
      if (truncated) break;
    }
    const meshSampleIds = (Array.isArray(value.meshIds) ? value.meshIds : [])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .slice(0, MODEL_STRUCTURE_MESH_SAMPLE_LIMIT);
    const meshCount = Array.isArray(value.meshIds)
      ? value.meshIds.length
      : optionalCount(value.meshCount);
    const nodeType = optionalText(value.type);
    return {
      id,
      name: optionalText(value.name) ?? id,
      ...(nodeType ? { type: nodeType } : {}),
      meshCount,
      ...(meshSampleIds.length ? { meshSampleIds } : {}),
      childCount: rawChildren.length,
      children,
    };
  };
  const root = walk(raw.root);
  if (!root) return { ok: false, message: "hierarchy.json 的 root 节点无法解析" };
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      sourceFormat: input.sourceFormat,
      sourceName: input.sourceName,
      nodeCount,
      truncated,
      root,
    },
  };
}

/** 从 properties.json 按 id 白名单抽取展示属性；非字符串值做有限类型的确定性转换，其余丢弃。 */
export function pickStructureProperties(raw: unknown, ids: readonly string[]): ModelStructurePropertiesResponse {
  const elements: Record<string, ModelStructurePropertyEntry> = {};
  const missing: string[] = [];
  const source = isRecord(raw) && isRecord(raw.elements) ? raw.elements : undefined;
  for (const id of ids) {
    const entry = source?.[id];
    if (!isRecord(entry)) {
      missing.push(id);
      continue;
    }
    const display = isRecord(entry.displayProperties) ? entry.displayProperties : undefined;
    const displayProperties: Record<string, string> = {};
    if (display) {
      for (const [key, value] of Object.entries(display)) {
        if (typeof value === "string") displayProperties[key] = value;
        else if (typeof value === "number" && Number.isFinite(value)) displayProperties[key] = String(value);
        else if (typeof value === "boolean") displayProperties[key] = value ? "是" : "否";
      }
    }
    elements[id] = { elementId: id, displayProperties };
  }
  return { schemaVersion: 1, elements, missing };
}

/** 把 manifest 里的 /assets/... URL 还原为对象存储 key，并强制归属当前模型，杜绝跨模型读取。 */
export function assetObjectKey(projectId: string, modelId: string, url: string): string {
  if (url.includes("?") || url.includes("#")) throw new Error("结构数据地址不允许携带查询参数");
  const prefix = `/assets/projects/${projectId}/models/${modelId}/`;
  if (!url.startsWith(prefix)) throw new Error("结构数据地址不属于该模型");
  const key = decodeURIComponent(url.slice("/assets/".length));
  const parts = key.split("/");
  if (!key.startsWith(`projects/${projectId}/models/${modelId}/`) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("结构数据地址无效");
  }
  return key;
}

/** 解析 properties 查询的 ids 参数；空与超量都是请求错误，不静默截断。 */
export function parseStructurePropertyIds(query: string | undefined): { ok: false; message: string } | { ok: true; ids: string[] } {
  const ids = (query ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return { ok: false, message: "请提供要查询的节点编号（ids）" };
  if (ids.length > MODEL_STRUCTURE_PROPERTY_ID_LIMIT) {
    return { ok: false, message: `单次最多查询 ${MODEL_STRUCTURE_PROPERTY_ID_LIMIT} 个节点编号` };
  }
  return { ok: true, ids };
}
