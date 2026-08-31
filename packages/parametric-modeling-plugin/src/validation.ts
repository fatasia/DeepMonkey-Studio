import type { ParametricCadDefinition, ParametricCadFeature, ParametricCadValue } from "@bim-studio/contracts";
import { evaluateParametricValue } from "./expression.js";

export interface ParametricValidationIssue { path: string; message: string; }
export type ParametricValidationResult =
  | { valid: true; definition: ParametricCadDefinition; issues: [] }
  | { valid: false; issues: ParametricValidationIssue[] };

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PRIMITIVES = new Set(["box", "cylinder", "sphere", "ellipsoid"]);
const OPERATIONS = new Set(["base", "union", "cut", "intersect"]);

export function validateParametricCadDefinition(input: unknown): ParametricValidationResult {
  const issues: ParametricValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, issues: [{ path: "$", message: "参数化定义必须是对象" }] };
  if (input.schemaVersion !== 1) add(issues, "$.schemaVersion", "仅支持 schemaVersion 1");
  text(input.name, "$.name", 120, issues);
  text(input.summary, "$.summary", 500, issues, true);
  if (input.unit !== "mm") add(issues, "$.unit", "当前几何内核统一使用 mm");

  const parameters = Array.isArray(input.parameters) ? input.parameters : [];
  if (parameters.length < 1 || parameters.length > 64) add(issues, "$.parameters", "参数数量必须为 1–64");
  const values: Record<string, number> = {};
  const parameterIds = new Set<string>();
  parameters.forEach((parameter, index) => validateParameter(parameter, index, parameterIds, values, issues));

  const features = Array.isArray(input.features) ? input.features : [];
  if (features.length < 1 || features.length > 80) add(issues, "$.features", "特征数量必须为 1–80");
  const featureIds = new Set<string>();
  features.forEach((feature, index) => validateFeature(feature, index, featureIds, values, issues));

  if (input.edgeTreatment !== undefined) validateEdgeTreatment(input.edgeTreatment, values, issues);
  if (input.semanticBindings !== undefined) validateBindings(input.semanticBindings, parameterIds, issues);
  return issues.length > 0 ? { valid: false, issues } : { valid: true, definition: structuredClone(input as unknown as ParametricCadDefinition), issues: [] };
}

export function assertParametricCadDefinition(input: unknown): ParametricCadDefinition {
  const result = validateParametricCadDefinition(input);
  if (!result.valid) throw new Error(result.issues.slice(0, 6).map((issue) => `${issue.path}: ${issue.message}`).join("；"));
  return result.definition;
}

function validateParameter(input: unknown, index: number, ids: Set<string>, values: Record<string, number>, issues: ParametricValidationIssue[]): void {
  const path = `$.parameters[${index}]`;
  if (!isRecord(input)) { add(issues, path, "参数必须是对象"); return; }
  identifier(input.id, `${path}.id`, ids, issues);
  text(input.label, `${path}.label`, 100, issues);
  if (input.unit !== "mm" && input.unit !== "deg" && input.unit !== "count") add(issues, `${path}.unit`, "单位必须是 mm、deg 或 count");
  for (const field of ["value", "min", "max", "step"] as const) if (!finite(input[field])) add(issues, `${path}.${field}`, "必须是有限数字");
  if (finite(input.min) && finite(input.max) && input.min > input.max) add(issues, path, "最小值不能大于最大值");
  if (finite(input.step) && input.step <= 0) add(issues, `${path}.step`, "步长必须大于 0");
  if (finite(input.value) && finite(input.min) && finite(input.max) && (input.value < input.min || input.value > input.max)) add(issues, `${path}.value`, "当前值超出允许范围");
  if (input.semantic !== undefined) text(input.semantic, `${path}.semantic`, 200, issues, true);
  if (typeof input.id === "string" && finite(input.value)) values[input.id] = input.value;
}

function validateFeature(input: unknown, index: number, ids: Set<string>, values: Record<string, number>, issues: ParametricValidationIssue[]): void {
  const path = `$.features[${index}]`;
  if (!isRecord(input)) { add(issues, path, "特征必须是对象"); return; }
  identifier(input.id, `${path}.id`, ids, issues);
  text(input.label, `${path}.label`, 100, issues);
  if (!PRIMITIVES.has(String(input.primitive))) add(issues, `${path}.primitive`, "不支持的基础体");
  if (!OPERATIONS.has(String(input.operation))) add(issues, `${path}.operation`, "不支持的布尔操作");
  if (index === 0 && input.operation !== "base") add(issues, `${path}.operation`, "首个特征必须是 base");
  if (index > 0 && input.operation === "base") add(issues, `${path}.operation`, "只有首个特征可以是 base");
  vector(input.position, `${path}.position`, values, issues, false);
  if (input.rotation !== undefined) vector(input.rotation, `${path}.rotation`, values, issues, false);
  if (input.primitive === "box") vector(input.size, `${path}.size`, values, issues, true);
  if (input.primitive === "ellipsoid") vector(input.axes, `${path}.axes`, values, issues, true);
  if (input.primitive === "cylinder" || input.primitive === "sphere") positive(input.radius, `${path}.radius`, values, issues);
  if (input.primitive === "cylinder") positive(input.height, `${path}.height`, values, issues);
}

function validateEdgeTreatment(input: unknown, values: Record<string, number>, issues: ParametricValidationIssue[]): void {
  if (!isRecord(input)) { add(issues, "$.edgeTreatment", "边处理必须是对象"); return; }
  if (input.kind !== "fillet" && input.kind !== "chamfer") add(issues, "$.edgeTreatment.kind", "边处理必须是 fillet 或 chamfer");
  try {
    if (evaluateParametricValue(input.radius as ParametricCadValue, values) < 0) add(issues, "$.edgeTreatment.radius", "半径不能小于 0");
  } catch (error) { add(issues, "$.edgeTreatment.radius", message(error)); }
}

function validateBindings(input: unknown, parameterIds: Set<string>, issues: ParametricValidationIssue[]): void {
  if (!Array.isArray(input) || input.length > 128) { add(issues, "$.semanticBindings", "语义绑定必须是最多 128 项的数组"); return; }
  input.forEach((binding, index) => {
    const path = `$.semanticBindings[${index}]`;
    if (!isRecord(binding)) { add(issues, path, "语义绑定必须是对象"); return; }
    if (typeof binding.parameterId !== "string" || !parameterIds.has(binding.parameterId)) add(issues, `${path}.parameterId`, "引用的参数不存在");
    text(binding.source, `${path}.source`, 200, issues);
    text(binding.meaning, `${path}.meaning`, 300, issues);
    if (binding.targetId !== undefined) text(binding.targetId, `${path}.targetId`, 200, issues);
    if (binding.target !== undefined) validateBindingTarget(binding.target, `${path}.target`, issues);
  });
}

function validateBindingTarget(input: unknown, path: string, issues: ParametricValidationIssue[]): void {
  if (!isRecord(input)) { add(issues, path, "运行绑定必须是对象"); return; }
  if (input.kind !== "dataset-field" && input.kind !== "simulation-signal" && input.kind !== "device-point") add(issues, `${path}.kind`, "不支持的运行绑定类型");
  text(input.connectionId, `${path}.connectionId`, 120, issues);
  text(input.datasetId, `${path}.datasetId`, 120, issues);
  text(input.field, `${path}.field`, 200, issues);
}

function vector(input: unknown, path: string, values: Record<string, number>, issues: ParametricValidationIssue[], strictlyPositive: boolean): void {
  if (!Array.isArray(input) || input.length !== 3) { add(issues, path, "必须是三个分量的向量"); return; }
  input.forEach((value, index) => {
    try {
      const resolved = evaluateParametricValue(value as ParametricCadValue, values);
      if (strictlyPositive && resolved <= 0) add(issues, `${path}[${index}]`, "尺寸必须大于 0");
    } catch (error) { add(issues, `${path}[${index}]`, message(error)); }
  });
}

function positive(input: unknown, path: string, values: Record<string, number>, issues: ParametricValidationIssue[]): void {
  try { if (evaluateParametricValue(input as ParametricCadValue, values) <= 0) add(issues, path, "尺寸必须大于 0"); }
  catch (error) { add(issues, path, message(error)); }
}

function identifier(input: unknown, path: string, ids: Set<string>, issues: ParametricValidationIssue[]): void {
  if (typeof input !== "string" || !ID_PATTERN.test(input)) { add(issues, path, "ID 必须以字母或下划线开头，最长 64 位"); return; }
  if (ids.has(input)) add(issues, path, "ID 不能重复");
  ids.add(input);
}

function text(input: unknown, path: string, maximum: number, issues: ParametricValidationIssue[], allowEmpty = false): void {
  if (typeof input !== "string" || (!allowEmpty && !input.trim()) || input.length > maximum) add(issues, path, `文本长度必须在 ${allowEmpty ? 0 : 1}–${maximum} 之间`);
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function add(issues: ParametricValidationIssue[], path: string, message: string): void { issues.push({ path, message }); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
