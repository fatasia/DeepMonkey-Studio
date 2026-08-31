import type { ModelRecord, ParametricCadBuildSummary, ParametricModelGeneration } from "@bim-studio/contracts";
import { assertParametricCadDefinition } from "@bim-studio/parametric-modeling-plugin";

const GENERATION_FIELDS = new Set(["kind", "generatorId", "generatorVersion", "definition", "revision", "generatedAt", "build", "supersedesModelId"]);
const BUILD_FIELDS = new Set(["durationMs", "volumeMm3", "faceCount", "edgeCount", "triangleCount", "bounds", "warnings"]);

/** 解析 multipart 文本字段；生成元数据是审计证据，不能接受松散或部分合法对象。 */
export function parseParametricModelGeneration(field: unknown): ParametricModelGeneration | undefined {
  const raw = multipartFieldText(field);
  if (raw === undefined) return undefined;
  if (raw.length > 256 * 1024) throw new Error("参数化模型元数据不能超过 256 KiB");
  let input: unknown;
  try { input = JSON.parse(raw); }
  catch { throw new Error("参数化模型元数据不是有效 JSON"); }
  if (!isRecord(input)) throw new Error("参数化模型元数据必须是对象");
  rejectUnknown(input, GENERATION_FIELDS, "generation");
  if (input.kind !== "parametric" || input.generatorId !== "bim.parametric-modeling") throw new Error("参数化模型生成器标识无效");
  if (typeof input.generatorVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(input.generatorVersion)) throw new Error("参数化模型生成器版本无效");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) throw new Error("参数化模型 revision 必须是正整数");
  if (typeof input.generatedAt !== "string" || !Number.isFinite(Date.parse(input.generatedAt))) throw new Error("参数化模型 generatedAt 无效");
  if (input.supersedesModelId !== undefined && (typeof input.supersedesModelId !== "string" || !input.supersedesModelId.trim() || input.supersedesModelId.length > 120)) throw new Error("supersedesModelId 无效");
  const definition = assertParametricCadDefinition(input.definition);
  const build = parseBuildSummary(input.build);
  return {
    kind: "parametric", generatorId: "bim.parametric-modeling", generatorVersion: input.generatorVersion,
    definition, revision: input.revision as number, generatedAt: new Date(input.generatedAt).toISOString(), build,
    ...(typeof input.supersedesModelId === "string" ? { supersedesModelId: input.supersedesModelId.trim() } : {})
  };
}

/**
 * 校验不可变资源的版本链。首个资源必须从 revision 1 开始，后续资源只能基于同项目中
 * 已存在的参数化资源递增，避免客户端伪造断裂或跳号的版本证据。
 */
export function assertParametricModelLineage(generation: ParametricModelGeneration, models: ModelRecord[]): void {
  if (!generation.supersedesModelId) {
    if (generation.revision !== 1) throw new Error("新的参数化资源 revision 必须从 1 开始");
    return;
  }
  const previous = models.find((model) => model.id === generation.supersedesModelId);
  if (!previous?.generation || previous.generation.kind !== "parametric") throw new Error("参数化资源的上一版本不存在");
  if (generation.revision !== previous.generation.revision + 1) throw new Error(`参数化资源 revision 必须为 ${previous.generation.revision + 1}`);
}

function parseBuildSummary(input: unknown): ParametricCadBuildSummary {
  if (!isRecord(input)) throw new Error("参数化模型 build 必须是对象");
  rejectUnknown(input, BUILD_FIELDS, "generation.build");
  const durationMs = nonNegative(input.durationMs, "durationMs");
  const volumeMm3 = nonNegative(input.volumeMm3, "volumeMm3");
  const faceCount = nonNegativeInteger(input.faceCount, "faceCount");
  const edgeCount = nonNegativeInteger(input.edgeCount, "edgeCount");
  const triangleCount = nonNegativeInteger(input.triangleCount, "triangleCount");
  if (!Array.isArray(input.bounds) || input.bounds.length !== 2 || input.bounds.some((point) => !Array.isArray(point) || point.length !== 3 || point.some((value) => !finite(value)))) throw new Error("参数化模型 bounds 必须是两个三维有限向量");
  if (!Array.isArray(input.warnings) || input.warnings.length > 50 || input.warnings.some((warning) => typeof warning !== "string" || warning.length > 500)) throw new Error("参数化模型 warnings 无效");
  return { durationMs, volumeMm3, faceCount, edgeCount, triangleCount, bounds: structuredClone(input.bounds) as ParametricCadBuildSummary["bounds"], warnings: [...input.warnings] as string[] };
}

function multipartFieldText(field: unknown): string | undefined {
  if (field === undefined) return undefined;
  if (typeof field === "string") return field;
  if (isRecord(field) && typeof field.value === "string") return field.value;
  throw new Error("参数化模型元数据字段类型无效");
}

function rejectUnknown(input: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} 是未知字段`);
}

function nonNegative(value: unknown, field: string): number {
  if (!finite(value) || value < 0) throw new Error(`${field} 必须是非负有限数字`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} 必须是非负整数`);
  return value as number;
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
