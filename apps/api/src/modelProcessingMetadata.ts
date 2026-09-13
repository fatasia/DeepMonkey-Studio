import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ModelProcessingRecord } from "@bim-studio/contracts";

/** 上传前校验尺寸与形状，配方仅作为数据持久化；重新执行仍需客户端完整参数校验。 */
export function parseModelProcessingRecord(field: unknown): ModelProcessingRecord | undefined {
  if (field === undefined) return;
  const item = field as { type?: unknown; value?: unknown };
  if (Array.isArray(field) || item.type !== "field" || typeof item.value !== "string" || item.value.length > 64_000) throw new Error("模型处理记录无效");
  const value = JSON.parse(item.value) as ModelProcessingRecord;
  if (!value || value.schemaVersion !== 1 || !["optimize", "layers"].includes(value.operation)
    || !["detail", "balanced", "mobile", "custom"].includes(value.preset)
    || typeof value.inputFileName !== "string" || !value.inputFileName.trim() || value.inputFileName.length > 255
    || !/^[a-f0-9]{64}$/.test(value.inputSha256)) throw new Error("模型处理记录无效");
  for (const key of ["optionsJson", "layerEditsJson"] as const) {
    if (typeof value[key] !== "string" || value[key].length > 24_000) throw new Error("处理参数无效或过大");
  }
  const options = JSON.parse(value.optionsJson), edits = JSON.parse(value.layerEditsJson);
  if (!options || typeof options !== "object" || Array.isArray(options) || !Array.isArray(edits) || edits.length > 1000) throw new Error("处理参数结构无效");
  const keys = ["bytes", "nodes", "meshes", "primitives", "triangles", "vertices", "materials", "textures"] as const;
  for (const stats of [value.before, value.after]) {
    if (!stats || keys.some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0)) throw new Error("模型统计值无效");
  }
  return {
    schemaVersion: 1, operation: value.operation, preset: value.preset,
    inputFileName: value.inputFileName, inputSha256: value.inputSha256,
    optionsJson: value.optionsJson, layerEditsJson: value.layerEditsJson,
    before: Object.fromEntries(keys.map(key => [key, value.before[key]])) as unknown as ModelProcessingRecord["before"],
    after: Object.fromEntries(keys.map(key => [key, value.after[key]])) as unknown as ModelProcessingRecord["after"],
  };
}

export async function hashModelFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
