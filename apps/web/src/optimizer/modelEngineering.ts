import type { ModelProcessingRecord, ModelRecord } from "@bim-studio/contracts";
import type { ModelFileStatistics, ModelOptimizationOptions } from "./modelOptimizer";
import type { OptimizerLayerEdit } from "./optimizerLayers";

export type OptimizationPresetId = "detail" | "balanced" | "mobile";
export const OPTIMIZATION_PRESETS = {
  detail: { zh: "保留细节", en: "Preserve detail", triangles: 2_000_000, bytes: 100 * 1024 * 1024, materials: 200, patch: { simplifyEnabled: false, simplifyRatio: 1, textureSize: 4096 } },
  balanced: { zh: "桌面浏览器", en: "Desktop browser", triangles: 500_000, bytes: 30 * 1024 * 1024, materials: 100, patch: { simplifyEnabled: true, simplifyRatio: .7, textureSize: 2048 } },
  mobile: { zh: "移动端", en: "Mobile", triangles: 100_000, bytes: 10 * 1024 * 1024, materials: 40, patch: { simplifyEnabled: true, simplifyRatio: .35, textureSize: 1024 } },
} as const;

export function applyOptimizationPreset(options: ModelOptimizationOptions, id: OptimizationPresetId): ModelOptimizationOptions {
  return { ...options, ...OPTIMIZATION_PRESETS[id].patch, simplifyError: .001, dracoEnabled: true,
    textureEnabled: true, textureFormat: id === "mobile" ? "ktx2-etc1s" : "ktx2-uastc", bakeEnabled: false, origin: "keep", removeUnused: false };
}

export function assessModelQuality(stats: Partial<ModelFileStatistics> | undefined, preset: OptimizationPresetId) {
  const budget = OPTIMIZATION_PRESETS[preset];
  if (!stats) return { status: "unknown" as const, issues: ["尚未检查几何，请进入优化器分析"] };
  if (stats.meshes === 0 || stats.triangles === 0) return { status: "blocked" as const, issues: ["没有可交付的三角面几何"] };
  const issues: string[] = [];
  if ((stats.triangles ?? 0) > budget.triangles) issues.push(`三角面超过 ${budget.triangles.toLocaleString("zh-CN")} 面预算`);
  if ((stats.bytes ?? 0) > budget.bytes) issues.push(`文件超过 ${budget.bytes / 1024 / 1024} MB 预算`);
  if ((stats.materials ?? 0) > budget.materials) issues.push(`材质超过 ${budget.materials} 个预算`);
  return { status: issues.length ? "warning" as const : stats.triangles === undefined || stats.materials === undefined ? "unknown" as const : "ready" as const, issues };
}

export function modelParentId(model: ModelRecord): string | undefined {
  return model.optimization?.sourceModelId ?? model.generation?.supersedesModelId;
}

/** 返回真实祖先链；缺失和环路由调用方明确展示，不伪造 v1。 */
export function modelVersionChain(model: ModelRecord, models: readonly ModelRecord[]): ModelRecord[] {
  const chain: ModelRecord[] = [], seen = new Set<string>();
  let current: ModelRecord | undefined = model;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); chain.unshift(current);
    const parent = modelParentId(current); current = parent ? models.find(item => item.id === parent) : undefined;
  }
  return chain;
}

export async function modelInputHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createProcessingRecord(file: File, options: ModelOptimizationOptions, edits: readonly OptimizerLayerEdit[], before: ModelFileStatistics, after: ModelFileStatistics, operation: ModelProcessingRecord["operation"], preset: OptimizationPresetId): Promise<ModelProcessingRecord> {
  return { schemaVersion: 1, operation, preset, optionsJson: JSON.stringify(options), layerEditsJson: JSON.stringify(edits), inputFileName: file.name, inputSha256: await modelInputHash(file), before, after };
}

/** 配方可以来自导入包，执行前按当前控件边界核验；不向 Worker 传任意 JSON。 */
export function readProcessingRecipe(record: ModelProcessingRecord, defaults: ModelOptimizationOptions): { options: ModelOptimizationOptions; edits: OptimizerLayerEdit[] } {
  const options = JSON.parse(record.optionsJson) as ModelOptimizationOptions;
  const edits = JSON.parse(record.layerEditsJson) as OptimizerLayerEdit[];
  if (!options || Object.keys(options).some(key => !(key in defaults)) || Object.entries(defaults).some(([key, value]) => typeof options[key as keyof ModelOptimizationOptions] !== typeof value)) throw new Error("处理配方与当前版本不兼容");
  const range = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (!range(options.simplifyRatio, .01, 1) || !range(options.simplifyError, .000001, 1)
    || ![512, 1024, 2048, 4096].includes(options.textureSize) || ![256, 512, 1024].includes(options.lightmapResolution)
    || !["webp", "jpeg", "original", "ktx2-uastc", "ktx2-etc1s"].includes(options.textureFormat) || !["keep", "center", "ground"].includes(options.origin)
    || !["vertex", "lightmap"].includes(options.bakeMode) || !range(options.bakeStrength, 0, 1) || !range(options.bakeAmbient, 0, 1)
    || ![4, 8].includes(options.lightmapAoSamples) || ![1, 4, 8].includes(options.lightmapShadowSamples) || ![0, 2, 4, 64].includes(options.lightmapIndirectSamples)
    || !/^#[a-f\d]{6}$/i.test(options.bakeAmbientColor) || !Array.isArray(options.bakeLights) || options.bakeLights.length > 8
    || options.bakeLights.some(light => !light || typeof light.id !== "string" || typeof light.name !== "string" || typeof light.enabled !== "boolean" || !["directional", "point"].includes(light.type)
      || !/^#[a-f\d]{6}$/i.test(light.color) || !range(light.intensity, 0, 100) || !range(light.range, 0, 1_000_000)
      || [light.direction, light.position].some(vector => !Array.isArray(vector) || vector.length !== 3 || vector.some(value => !range(value, -1_000_000, 1_000_000))))) throw new Error("处理配方参数超出可执行范围");
  if (!Array.isArray(edits) || edits.length > 1000 || edits.some(edit => !edit || !Number.isSafeInteger(edit.id) || edit.id < 0 || !["rename", "hidden", "delete"].includes(edit.action)
    || (edit.action === "rename" && (typeof edit.name !== "string" || !edit.name.trim() || edit.name.length > 120)) || (edit.action === "hidden" && typeof edit.hidden !== "boolean"))) throw new Error("处理配方图层记录无效");
  return { options, edits };
}
