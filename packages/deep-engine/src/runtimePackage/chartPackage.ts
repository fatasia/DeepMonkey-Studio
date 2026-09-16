import { validateChartIR } from "../chartIrReader.js";
import { fields, record, requireValue, revision, string } from "./primitives.js";

/**
 * 包内 chart 载荷合同:信封身份与资源索引绑定,内层 ChartIR 走既有严格校验。
 * 语义校验(Native 侧 parse_chart_ir)与 TS validateChartIR 保持同版本同预算。
 */
export function validateRuntimeChartPackage(payload: unknown, id: string, indexRevision: number, path: string): unknown {
  const value = record(payload, path);
  fields(value, ["schema", "schemaVersion", "id", "revision", "chart"], [], path);
  requireValue(value.schema === "deep-engine.chart-runtime" && value.schemaVersion === 1, path, "Unsupported chart runtime payload schema or version.");
  requireValue(string(value.id, `${path}.id`) === id && revision(value.revision, `${path}.revision`) === indexRevision, path, "Chart payload identity differs from its index entry.");
  const result = validateChartIR(value.chart);
  requireValue(result.ok, path, result.diagnostics[0]?.message ?? "Invalid ChartIR payload.");
  return result.ir;
}

const SIM_FIELDS = ["schema", "schemaVersion", "id", "chartId", "datasetId", "dimensions", "rows", "seed", "intervalMs", "startTimeMs", "maxRows"];
const stableId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
const boundedInteger = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * 离线回放载荷:信封身份绑定资源索引;fixture 结构与 Rust parse_chart_sim_fixture +
 * ChartSimulationSource 构造规则一致,chartId 必须指向同包 chart。
 */
export function validateRuntimeChartSimPackage(payload: unknown, id: string, indexRevision: number, chartIr: unknown, path: string): void {
  const value = record(payload, path);
  fields(value, ["schema", "schemaVersion", "id", "revision", "fixture"], [], path);
  requireValue(value.schema === "deep-engine.chart-sim-runtime" && value.schemaVersion === 1, path, "Unsupported chart sim payload schema or version.");
  requireValue(string(value.id, `${path}.id`) === id && revision(value.revision, `${path}.revision`) === indexRevision, path, "Chart sim payload identity differs from its index entry.");
  const fixture = record(value.fixture, `${path}.fixture`);
  requireValue(Object.keys(fixture).length === SIM_FIELDS.length && SIM_FIELDS.every(key => Object.hasOwn(fixture, key)),
    `${path}.fixture`, "Chart sim fixture fields differ from the v1 contract.");
  requireValue(fixture.schema === "deep-engine.chart-sim" && fixture.schemaVersion === 1, `${path}.fixture`, "Unsupported chart sim fixture schema.");
  requireValue(stableId(fixture.id) && stableId(fixture.chartId) && stableId(fixture.datasetId), `${path}.fixture`, "Invalid sim fixture identity.");
  const chart = record(chartIr, path);
  requireValue(fixture.chartId === chart.id, `${path}.fixture`, "Sim fixture targets a chart other than the package chart.");
  requireValue(boundedInteger(fixture.seed, 0, 0xffffffff) && boundedInteger(fixture.intervalMs, 1, 86_400_000)
    && boundedInteger(fixture.startTimeMs, 0, 9_007_199_254_740_991) && boundedInteger(fixture.maxRows, 1, Number.MAX_SAFE_INTEGER),
  `${path}.fixture`, "Invalid sim fixture clock or window.");
  const rows = fixture.rows, dimensions = fixture.dimensions;
  requireValue(Array.isArray(rows) && rows.length > 0 && Array.isArray(dimensions) && dimensions.length > 0, `${path}.fixture`, "Sim fixture requires rows and dimensions.");
}
