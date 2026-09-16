import { CHART_BUDGETS, CHART_IR_SCHEMA_VERSION, CHART_SPEC_SCHEMA_VERSION, compileChartSpec, validateChartJson,
  type ChartCompileResult, type ChartDiagnostic } from "./chartIr.js";

const ROOT_FIELDS = ["schemaVersion", "sourceSpecVersion", "id", "datasets", "axes", "series", "legend", "tooltip", "dataZoom", "actions"] as const;

/** 读取已编译 IR；运行时必须拒绝缺字段，不能再套用作者侧默认值。 */
export function validateChartIR(input: unknown): ChartCompileResult {
  const diagnostics = [...validateChartJson(input)];
  if (diagnostics.length) return { ok: false, diagnostics };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid-schema", "$", "Expected ChartIR v1 object.");
  }
  // 校验后的纯 JSON 快照与调用方脱离，数据行和交互数组不会随源对象变化。
  const value = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  required(value, ROOT_FIELDS, "$", diagnostics);
  for (const field of ["datasets", "axes", "series", "dataZoom", "actions"]) {
    if (!Array.isArray(value[field])) diagnostics.push({ code: "invalid-schema", path: `$.${field}`, message: "Compiled collection must be an array." });
  }
  if (value.schemaVersion !== CHART_IR_SCHEMA_VERSION) {
    diagnostics.push({ code: "invalid-schema", path: "$.schemaVersion", message: "Expected ChartIR schema version 1." });
  }
  if (value.sourceSpecVersion !== CHART_SPEC_SCHEMA_VERSION) {
    diagnostics.push({ code: "invalid-schema", path: "$.sourceSpecVersion", message: "Expected source ChartSpec version 1." });
  }
  if (Array.isArray(value.axes)) value.axes.slice(0, CHART_BUDGETS.axes).forEach((axis, index) => {
    required(axis, ["min", "max"], `$.axes[${index}]`, diagnostics);
  });
  required(value.legend, ["visible", "position"], "$.legend", diagnostics);
  required(value.tooltip, ["enabled", "trigger"], "$.tooltip", diagnostics);
  if (diagnostics.length) return { ok: false, diagnostics };
  const { sourceSpecVersion: _source, ...spec } = value;
  // 复用现有字段、预算及引用规则，避免运行时另建一套近似校验。
  return compileChartSpec(spec);
}

export function parseChartIR(text: string): ChartCompileResult {
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { return failure("invalid-json", "$", "ChartIR is not valid JSON."); }
  return validateChartIR(input);
}

function required(value: unknown, fields: readonly string[], path: string, diagnostics: ChartDiagnostic[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({ code: "invalid-schema", path, message: "Expected a complete compiled object." });
    return;
  }
  for (const field of fields) if (!Object.hasOwn(value, field)) {
    diagnostics.push({ code: "invalid-schema", path: `${path}.${field}`, message: "Compiled field is required." });
  }
}

function failure(code: ChartDiagnostic["code"], path: string, message: string): ChartCompileResult {
  return { ok: false, diagnostics: [{ code, path, message }] };
}
