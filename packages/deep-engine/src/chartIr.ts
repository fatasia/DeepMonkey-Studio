export const CHART_SPEC_SCHEMA_VERSION = 1 as const;
export const CHART_IR_SCHEMA_VERSION = 1 as const;
export const CHART_BUDGETS = Object.freeze({ datasets: 32, dimensions: 64, rows: 500_000, series: 128, axes: 16, zooms: 16, actions: 512, nodes: 2_000_000, depth: 32, stringCodeUnits: 4096, diagnostics: 128 } as const);

export type ChartValue = string | number | boolean | null;
export type ChartScale = "linear" | "log" | "category" | "time";
export type ChartSeriesType = "line" | "bar" | "scatter" | "pie" | "heatmap" | "gauge";
export interface ChartDataset { readonly id: string; readonly dimensions: readonly string[]; readonly rows: readonly (readonly ChartValue[])[] }
export interface ChartAxis { readonly id: string; readonly channel: "x" | "y"; readonly scale: ChartScale; readonly min: number | null; readonly max: number | null }
export interface ChartAxisSpec { readonly id: string; readonly channel: "x" | "y"; readonly scale: ChartScale; readonly min?: number | null; readonly max?: number | null }
interface CartesianSeries { readonly id: string; readonly label: string; readonly type: "line" | "bar" | "scatter"; readonly datasetId: string; readonly x: string; readonly y: string; readonly xAxisId: string; readonly yAxisId: string }
interface PieSeries { readonly id: string; readonly label: string; readonly type: "pie"; readonly datasetId: string; readonly name: string; readonly value: string }
interface HeatmapSeries { readonly id: string; readonly label: string; readonly type: "heatmap"; readonly datasetId: string; readonly x: string; readonly y: string; readonly value: string; readonly xAxisId: string; readonly yAxisId: string }
interface GaugeSeries { readonly id: string; readonly label: string; readonly type: "gauge"; readonly datasetId: string; readonly name: string; readonly value: string; readonly min: number; readonly max: number }
export type ChartSeries = CartesianSeries | PieSeries | HeatmapSeries | GaugeSeries;
export interface ChartLegend { readonly visible: boolean; readonly position: "top" | "right" | "bottom" | "left" }
export interface ChartTooltip { readonly enabled: boolean; readonly trigger: "item" | "axis" | "none" }
export interface ChartDataZoom { readonly id: string; readonly axisId: string; readonly start: number; readonly end: number; readonly mode: "inside" | "slider" }
export type ChartAction =
  | { readonly type: "highlight" | "downplay" | "select" | "unselect"; readonly seriesId: string; readonly dataIndex: number | null }
  | { readonly type: "dataZoom"; readonly axisId: string; readonly start: number; readonly end: number };
export interface ChartSpec { readonly schemaVersion: 1; readonly id: string; readonly datasets: readonly ChartDataset[]; readonly axes?: readonly ChartAxisSpec[]; readonly series: readonly ChartSeries[]; readonly legend?: Partial<ChartLegend>; readonly tooltip?: Partial<ChartTooltip>; readonly dataZoom?: readonly ChartDataZoom[]; readonly actions?: readonly ChartAction[] }
export interface ChartIR { readonly schemaVersion: 1; readonly sourceSpecVersion: 1; readonly id: string; readonly datasets: readonly ChartDataset[]; readonly axes: readonly ChartAxis[]; readonly series: readonly ChartSeries[]; readonly legend: ChartLegend; readonly tooltip: ChartTooltip; readonly dataZoom: readonly ChartDataZoom[]; readonly actions: readonly ChartAction[] }
export type ChartDiagnosticCode = "invalid-json" | "invalid-schema" | "invalid-value" | "unknown-field" | "duplicate-id" | "missing-reference" | "budget-exceeded" | "unsupported";
export interface ChartDiagnostic { readonly code: ChartDiagnosticCode; readonly path: string; readonly message: string }
export interface ChartCompileResult { readonly ok: boolean; readonly ir?: ChartIR; readonly diagnostics: readonly ChartDiagnostic[] }

type Obj = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arr = (v: unknown): v is unknown[] => Array.isArray(v)
  && Reflect.ownKeys(v).every((key) => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)))
  && Array.from({ length: v.length }, (_, i) => { const descriptor = Object.getOwnPropertyDescriptor(v, i); return descriptor?.enumerable === true && "value" in descriptor; }).every(Boolean);

function add(out: ChartDiagnostic[], code: ChartDiagnosticCode, path: string, message: string): void {
  if (out.length < CHART_BUDGETS.diagnostics) out.push({ code, path, message });
}
function keys(v: Obj, allowed: readonly string[], path: string, out: ChartDiagnostic[]): void {
  const set = new Set(allowed); for (const key of Object.keys(v)) if (!set.has(key)) add(out, "unknown-field", `${path}.${key}`, "Field is not defined by ChartSpec v1.");
}
function id(v: unknown, path: string, out: ChartDiagnostic[]): v is string {
  if (typeof v === "string" && ID.test(v) && !["__proto__", "prototype", "constructor"].includes(v)) return true;
  add(out, "invalid-value", path, "Expected a stable ASCII identifier of at most 256 characters."); return false;
}
function json(v: unknown, path: string, out: ChartDiagnostic[], state: { nodes: number }, depth = 0): void {
  if (++state.nodes > CHART_BUDGETS.nodes) { add(out, "budget-exceeded", path, "JSON node budget exceeded."); return; }
  if (depth > CHART_BUDGETS.depth) { add(out, "budget-exceeded", path, "JSON nesting depth exceeded."); return; }
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
  if (typeof v === "string") { if (v.length > CHART_BUDGETS.stringCodeUnits) add(out, "budget-exceeded", path, "String budget exceeded."); return; }
  if (arr(v)) { if (v.length + state.nodes > CHART_BUDGETS.nodes) { add(out, "budget-exceeded", path, "Array budget exceeded."); return; } v.forEach((x, i) => json(x, `${path}[${i}]`, out, state, depth + 1)); return; }
  if (object(v) && Reflect.ownKeys(v).every((key) => { const d = typeof key === "string" ? Object.getOwnPropertyDescriptor(v, key) : undefined; return d?.enumerable === true && "value" in d; })) { const entries = Object.entries(v); if (entries.length + state.nodes > CHART_BUDGETS.nodes) { add(out, "budget-exceeded", path, "Object budget exceeded."); return; } for (const [key, x] of entries) json(x, `${path}.${key}`, out, state, depth + 1); return; }
  add(out, "invalid-json", path, "Expected a dense, finite, plain JSON value without functions, symbols or accessors.");
}
export function validateChartJson(input: unknown): readonly ChartDiagnostic[] { const diagnostics: ChartDiagnostic[] = []; try { json(input, "$", diagnostics, { nodes: 0 }); } catch { add(diagnostics, "invalid-json", "$", "Input could not be inspected as plain JSON."); } return diagnostics; }
function boundedList(v: unknown, path: string, max: number, out: ChartDiagnostic[]): unknown[] {
  if (!arr(v)) { add(out, "invalid-value", path, "Expected a dense array."); return []; }
  if (v.length > max) { add(out, "budget-exceeded", path, `At most ${max} entries are allowed.`); return []; } return v;
}

function dataset(v: unknown, path: string, out: ChartDiagnostic[]): ChartDataset | undefined {
  if (!object(v)) { add(out, "invalid-value", path, "Expected a dataset object."); return; }
  keys(v, ["id", "dimensions", "rows"], path, out); if (!id(v.id, `${path}.id`, out)) return;
  const dimensions = boundedList(v.dimensions, `${path}.dimensions`, CHART_BUDGETS.dimensions, out);
  if (!dimensions.length || dimensions.some((x) => typeof x !== "string" || !ID.test(x))) add(out, "invalid-value", `${path}.dimensions`, "Dimensions must be unique stable identifiers.");
  if (new Set(dimensions).size !== dimensions.length) add(out, "duplicate-id", `${path}.dimensions`, "Dataset dimensions must be unique.");
  const rows = boundedList(v.rows, `${path}.rows`, CHART_BUDGETS.rows, out);
  rows.forEach((row, i) => { if (!arr(row) || row.length !== dimensions.length || row.some((x) => !(x === null || ["string", "number", "boolean"].includes(typeof x)))) add(out, "invalid-value", `${path}.rows[${i}]`, "Row must contain one JSON scalar per dimension."); });
  return { id: v.id, dimensions: dimensions as string[], rows: rows as ChartValue[][] };
}
function axis(v: unknown, path: string, out: ChartDiagnostic[]): ChartAxis | undefined {
  if (!object(v)) { add(out, "invalid-value", path, "Expected an axis object."); return; }
  keys(v, ["id", "channel", "scale", "min", "max"], path, out); if (!id(v.id, `${path}.id`, out)) return;
  if (!["x", "y"].includes(v.channel as string)) add(out, "invalid-value", `${path}.channel`, "Expected x or y.");
  if (!["linear", "log", "category", "time"].includes(v.scale as string)) add(out, "invalid-value", `${path}.scale`, "Unsupported scale.");
  for (const key of ["min", "max"] as const) if (v[key] !== undefined && v[key] !== null && !finite(v[key])) add(out, "invalid-value", `${path}.${key}`, "Expected a finite number or null.");
  if (finite(v.min) && finite(v.max) && v.min >= v.max) add(out, "invalid-value", path, "Axis min must be less than max.");
  return { id: v.id, channel: v.channel as "x" | "y", scale: v.scale as ChartScale, min: finite(v.min) ? v.min : null, max: finite(v.max) ? v.max : null };
}
function series(v: unknown, path: string, out: ChartDiagnostic[]): ChartSeries | undefined {
  if (!object(v) || !["line", "bar", "scatter", "pie", "heatmap", "gauge"].includes(v.type as string)) { add(out, "invalid-value", path, "Expected a supported series object."); return; }
  const type = v.type as ChartSeriesType, base = ["id", "label", "type", "datasetId"];
  const fields = type === "pie" ? ["name", "value"] : type === "gauge" ? ["name", "value", "min", "max"] : type === "heatmap" ? ["x", "y", "value", "xAxisId", "yAxisId"] : ["x", "y", "xAxisId", "yAxisId"];
  keys(v, [...base, ...fields], path, out); if (!id(v.id, `${path}.id`, out) || !id(v.datasetId, `${path}.datasetId`, out)) return;
  if (typeof v.label !== "string" || !v.label.trim() || v.label.length > CHART_BUDGETS.stringCodeUnits) add(out, "invalid-value", `${path}.label`, "Series label must be non-blank bounded text.");
  for (const field of fields.filter((x) => !["min", "max"].includes(x))) id(v[field], `${path}.${field}`, out);
  if (type === "gauge") { if (!finite(v.min) || !finite(v.max) || v.min >= v.max) add(out, "invalid-value", path, "Gauge requires finite min < max."); return v as unknown as GaugeSeries; }
  return v as unknown as ChartSeries;
}

export function compileChartSpec(input: unknown): ChartCompileResult {
  const diagnostics = [...validateChartJson(input)];
  if (diagnostics.some((item) => item.code === "invalid-json" || item.code === "budget-exceeded")) return { ok: false, diagnostics };
  if (!object(input)) return { ok: false, diagnostics: diagnostics.length ? diagnostics : [{ code: "invalid-value", path: "$", message: "Expected ChartSpec object." }] };
  keys(input, ["schemaVersion", "id", "datasets", "axes", "series", "legend", "tooltip", "dataZoom", "actions"], "$", diagnostics);
  if (input.schemaVersion !== CHART_SPEC_SCHEMA_VERSION) add(diagnostics, "invalid-schema", "$.schemaVersion", "Expected ChartSpec schema version 1."); id(input.id, "$.id", diagnostics);
  const datasets = boundedList(input.datasets, "$.datasets", CHART_BUDGETS.datasets, diagnostics).map((v, i) => dataset(v, `$.datasets[${i}]`, diagnostics)).filter(Boolean) as ChartDataset[];
  const axes = boundedList(input.axes ?? [], "$.axes", CHART_BUDGETS.axes, diagnostics).map((v, i) => axis(v, `$.axes[${i}]`, diagnostics)).filter(Boolean) as ChartAxis[];
  const seriesList = boundedList(input.series, "$.series", CHART_BUDGETS.series, diagnostics).map((v, i) => series(v, `$.series[${i}]`, diagnostics)).filter(Boolean) as ChartSeries[];
  const unique = (items: readonly { id: string }[], path: string): void => { const seen = new Set<string>(); items.forEach((x, i) => { if (seen.has(x.id)) add(diagnostics, "duplicate-id", `${path}[${i}].id`, `Duplicate id ${x.id}.`); seen.add(x.id); }); };
  unique(datasets, "$.datasets"); unique(axes, "$.axes"); unique(seriesList, "$.series");
  const datasetMap = new Map(datasets.map((x) => [x.id, x]));
  const axisMap = new Map(axes.map((x) => [x.id, x]));
  seriesList.forEach((s, i) => {
    const d = datasetMap.get(s.datasetId); if (!d) { add(diagnostics, "missing-reference", `$.series[${i}].datasetId`, `Missing dataset ${s.datasetId}.`); return; }
    const dimensions = s.type === "pie" || s.type === "gauge" ? [s.name, s.value] : s.type === "heatmap" ? [s.x, s.y, s.value] : [s.x, s.y];
    for (const key of dimensions) if (!d.dimensions.includes(key)) add(diagnostics, "missing-reference", `$.series[${i}]`, `Missing dimension ${key}.`);
    const numeric = s.type === "pie" || s.type === "gauge" ? [s.value] : s.type === "heatmap" ? [s.value] : [s.y];
    for (const dimensionName of numeric) { const column = d.dimensions.indexOf(dimensionName); if (column >= 0 && d.rows.some((row) => !finite(row[column]))) add(diagnostics, "invalid-value", `$.series[${i}]`, `Dimension ${dimensionName} must contain finite numbers.`); }
    if (s.type !== "pie" && s.type !== "gauge") {
      const xAxis = axisMap.get(s.xAxisId), yAxis = axisMap.get(s.yAxisId);
      if (xAxis?.channel !== "x") add(diagnostics, "missing-reference", `$.series[${i}].xAxisId`, "Missing x axis.");
      if (yAxis?.channel !== "y") add(diagnostics, "missing-reference", `$.series[${i}].yAxisId`, "Missing y axis.");
      for (const [dimensionName, target] of [[s.x, xAxis], [s.y, yAxis]] as const) if (target?.scale === "linear" || target?.scale === "log") { const column = d.dimensions.indexOf(dimensionName); if (column >= 0 && d.rows.some((row) => !finite(row[column]) || (target.scale === "log" && (row[column] as number) <= 0))) add(diagnostics, "invalid-value", `$.series[${i}]`, `${target.scale} axis dimension ${dimensionName} contains invalid values.`); }
    }
  });
  const legend = config(input.legend, ["visible", "position"], { visible: true, position: "top" }, "$.legend", diagnostics) as unknown as ChartLegend;
  const tooltip = config(input.tooltip, ["enabled", "trigger"], { enabled: true, trigger: "item" }, "$.tooltip", diagnostics) as unknown as ChartTooltip;
  if (typeof legend.visible !== "boolean" || !["top", "right", "bottom", "left"].includes(legend.position)) add(diagnostics, "invalid-value", "$.legend", "Invalid legend configuration.");
  if (typeof tooltip.enabled !== "boolean" || !["item", "axis", "none"].includes(tooltip.trigger)) add(diagnostics, "invalid-value", "$.tooltip", "Invalid tooltip configuration.");
  const zooms = boundedList(input.dataZoom ?? [], "$.dataZoom", CHART_BUDGETS.zooms, diagnostics) as unknown as ChartDataZoom[];
  const actions = boundedList(input.actions ?? [], "$.actions", CHART_BUDGETS.actions, diagnostics) as unknown as ChartAction[];
  unique(zooms.filter((zoom): zoom is ChartDataZoom => object(zoom) && typeof zoom.id === "string"), "$.dataZoom");
  validateInteractions(zooms, actions, axes, seriesList, datasets, diagnostics);
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, diagnostics, ir: { schemaVersion: CHART_IR_SCHEMA_VERSION, sourceSpecVersion: 1, id: input.id as string, datasets, axes, series: seriesList, legend, tooltip, dataZoom: zooms, actions } };
}

function config(v: unknown, allowed: string[], defaults: Obj, path: string, out: ChartDiagnostic[]): Obj { if (v === undefined) return defaults; if (!object(v)) { add(out, "invalid-value", path, "Expected object."); return defaults; } keys(v, allowed, path, out); return { ...defaults, ...v }; }
function validateInteractions(zooms: readonly ChartDataZoom[], actions: readonly ChartAction[], axes: readonly ChartAxis[], series: readonly ChartSeries[], datasets: readonly ChartDataset[], out: ChartDiagnostic[]): void {
  const axisIds = new Set(axes.map((x) => x.id)), seriesIds = new Set(series.map((x) => x.id));
  zooms.forEach((z, i) => { const p = `$.dataZoom[${i}]`; if (!object(z)) { add(out, "invalid-value", p, "Expected dataZoom object."); return; } keys(z, ["id", "axisId", "start", "end", "mode"], p, out); id(z.id, `${p}.id`, out); if (!axisIds.has(z.axisId)) add(out, "missing-reference", `${p}.axisId`, "Missing axis."); if (!finite(z.start) || !finite(z.end) || z.start < 0 || z.end > 100 || z.start >= z.end || !["inside", "slider"].includes(z.mode)) add(out, "invalid-value", p, "Expected 0 <= start < end <= 100 and a supported mode."); });
  actions.forEach((a, i) => { const p = `$.actions[${i}]`; if (!object(a) || !["highlight", "downplay", "select", "unselect", "dataZoom"].includes(a.type)) { add(out, "invalid-value", p, "Unsupported action."); return; } if (a.type === "dataZoom") { keys(a, ["type", "axisId", "start", "end"], p, out); if (!axisIds.has(a.axisId as string) || !finite(a.start) || !finite(a.end) || a.start < 0 || a.end > 100 || a.start >= a.end) add(out, "invalid-value", p, "Invalid dataZoom action."); } else { keys(a, ["type", "seriesId", "dataIndex"], p, out); const target = series.find((item) => item.id === a.seriesId), rowCount = target ? datasets.find((item) => item.id === target.datasetId)?.rows.length : undefined; if (!seriesIds.has(a.seriesId as string) || !(a.dataIndex === null || (Number.isSafeInteger(a.dataIndex) && (a.dataIndex as number) >= 0 && (rowCount === undefined || (a.dataIndex as number) < rowCount)))) add(out, "invalid-value", p, "Invalid series action target."); } });
}
