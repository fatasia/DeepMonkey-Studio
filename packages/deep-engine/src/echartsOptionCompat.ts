import { CHART_BUDGETS, CHART_SPEC_SCHEMA_VERSION, compileChartSpec, validateChartJson, type ChartAction, type ChartAxisSpec, type ChartCompileResult, type ChartDataset, type ChartDiagnostic, type ChartSeries, type ChartValue } from "./chartIr.js";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const array = (v: unknown): v is unknown[] => Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const scalar = (v: unknown): v is ChartValue => v === null || ["string", "number", "boolean"].includes(typeof v);

function unsupported(out: ChartDiagnostic[], path: string, message: string): void { if (out.length < CHART_BUDGETS.diagnostics) out.push({ code: "unsupported", path, message }); }
function unknown(v: Obj, allowed: readonly string[], path: string, out: ChartDiagnostic[]): void { const set = new Set(allowed); for (const key of Object.keys(v)) if (!set.has(key)) unsupported(out, `${path}.${key}`, "ECharts field is outside the explicit compatibility subset."); }
function list(v: unknown): unknown[] { return v === undefined ? [] : array(v) ? v : [v]; }
function seriesId(v: Obj, index: number): string { return typeof v.id === "string" && v.id ? v.id : `series-${index}`; }
function axisId(channel: "x" | "y", v: Obj, index: number): string { return typeof v.id === "string" && v.id ? v.id : `${channel}-${index}`; }
function scale(v: unknown, path: string, out: ChartDiagnostic[]): ChartAxisSpec["scale"] { const map: Record<string, ChartAxisSpec["scale"]> = { value: "linear", log: "log", category: "category", time: "time" }; if (typeof v === "string" && map[v]) return map[v]; unsupported(out, path, "Only value, log, category and time axes are supported."); return "linear"; }

function axes(value: unknown, channel: "x" | "y", out: ChartDiagnostic[]): ChartAxisSpec[] {
  const values = list(value ?? {}); if (values.length > CHART_BUDGETS.axes) { unsupported(out, `$.${channel}Axis`, "Axis budget exceeded."); return []; }
  return values.flatMap((raw, index) => {
    const path = `$.${channel}Axis[${index}]`; if (!object(raw)) { unsupported(out, path, "Axis must be an object."); return []; }
    unknown(raw, ["id", "type", "min", "max"], path, out);
    if (raw.min !== undefined && raw.min !== null && !finite(raw.min)) unsupported(out, `${path}.min`, "Only finite numeric axis minima are supported.");
    if (raw.max !== undefined && raw.max !== null && !finite(raw.max)) unsupported(out, `${path}.max`, "Only finite numeric axis maxima are supported.");
    return [{ id: axisId(channel, raw, index), channel, scale: scale(raw.type ?? (channel === "x" ? "category" : "value"), `${path}.type`, out), ...(finite(raw.min) ? { min: raw.min } : {}), ...(finite(raw.max) ? { max: raw.max } : {}) }];
  });
}

function datasets(value: unknown, out: ChartDiagnostic[]): ChartDataset[] {
  const values = list(value); if (values.length > CHART_BUDGETS.datasets) { unsupported(out, "$.dataset", "Dataset budget exceeded."); return []; }
  return values.flatMap((raw, index) => {
    const path = `$.dataset[${index}]`; if (!object(raw)) { unsupported(out, path, "Dataset must be an object."); return []; }
    unknown(raw, ["id", "dimensions", "source"], path, out);
    if (!array(raw.source) || !array(raw.dimensions) || raw.dimensions.some((x) => typeof x !== "string")) { unsupported(out, path, "Dataset v1 requires dimensions and row-array source."); return []; }
    const dimensions = raw.dimensions as string[], source = raw.source;
    if (source.length > CHART_BUDGETS.rows) { unsupported(out, `${path}.source`, "Row budget exceeded."); return []; }
    const rows = source.flatMap((row, rowIndex) => { if (!array(row) || row.length !== dimensions.length || row.some((x) => !scalar(x))) { unsupported(out, `${path}.source[${rowIndex}]`, "Each source row must match dimensions and contain JSON scalars."); return []; } return [row as ChartValue[]]; });
    return [{ id: typeof raw.id === "string" && raw.id ? raw.id : `dataset-${index}`, dimensions, rows }];
  });
}

function dimension(value: unknown, dataset: ChartDataset | undefined, path: string, out: ChartDiagnostic[]): string {
  if (typeof value === "string") return value;
  if (Number.isSafeInteger(value) && (value as number) >= 0 && dataset?.dimensions[value as number]) return dataset.dimensions[value as number]!;
  unsupported(out, path, "Encode dimension must be a dimension name or valid zero-based index."); return "invalid";
}
function directDataset(type: string, data: unknown, id: string, path: string, out: ChartDiagnostic[]): { dataset: ChartDataset; fields: Obj } | undefined {
  if (!array(data) || data.length > CHART_BUDGETS.rows) { unsupported(out, path, "Series data must be a bounded array."); return; }
  if (["line", "bar", "scatter"].includes(type)) {
    const rows = data.flatMap((item, i) => { const value = object(item) ? item.value : item; if (object(item)) unknown(item, ["value"], `${path}[${i}]`, out); if (finite(value)) return [[i, value] as ChartValue[]]; if (array(value) && value.length === 2 && value.every(scalar)) return [value as ChartValue[]]; unsupported(out, `${path}[${i}]`, "Cartesian data must contain finite values or [x,y] scalar pairs."); return []; });
    return { dataset: { id, dimensions: ["x", "y"], rows }, fields: { x: "x", y: "y" } };
  }
  if (type === "heatmap") {
    const rows = data.flatMap((item, i) => array(item) && item.length === 3 && item.every(scalar) ? [item as ChartValue[]] : (unsupported(out, `${path}[${i}]`, "Heatmap data must contain [x,y,value]."), []));
    return { dataset: { id, dimensions: ["x", "y", "value"], rows }, fields: { x: "x", y: "y", value: "value" } };
  }
  const rows = data.flatMap((item, i) => { if (!object(item)) { unsupported(out, `${path}[${i}]`, `${type} data requires {name,value}.`); return []; } unknown(item, ["name", "value"], `${path}[${i}]`, out); if (typeof item.name !== "string" || !finite(item.value)) { unsupported(out, `${path}[${i}]`, `${type} name must be text and value finite.`); return []; } return [[item.name, item.value] as ChartValue[]]; });
  return { dataset: { id, dimensions: ["name", "value"], rows }, fields: { name: "name", value: "value" } };
}

function compileSeries(value: unknown, source: ChartDataset[], xAxes: ChartAxisSpec[], yAxes: ChartAxisSpec[], out: ChartDiagnostic[]): { datasets: ChartDataset[]; series: ChartSeries[] } {
  const generated: ChartDataset[] = [], result: ChartSeries[] = [], values = list(value);
  if (values.length > CHART_BUDGETS.series) { unsupported(out, "$.series", "Series budget exceeded."); return { datasets: generated, series: result }; }
  values.forEach((raw, index) => {
    const path = `$.series[${index}]`; if (!object(raw) || !["line", "bar", "scatter", "pie", "heatmap", "gauge"].includes(raw.type as string)) { unsupported(out, path, "Only line, bar, scatter, pie, heatmap and gauge series are supported."); return; }
    const type = raw.type as ChartSeries["type"], common = ["id", "name", "type", "data", "datasetIndex", "encode"];
    unknown(raw, type === "gauge" ? [...common, "min", "max"] : type === "pie" ? common : [...common, "xAxisIndex", "yAxisIndex"], path, out);
    const sid = seriesId(raw, index), direct = raw.data !== undefined;
    if (raw.name !== undefined && typeof raw.name !== "string") unsupported(out, `${path}.name`, "Series name must be text.");
    if (raw.datasetIndex !== undefined && (!Number.isSafeInteger(raw.datasetIndex) || (raw.datasetIndex as number) < 0)) unsupported(out, `${path}.datasetIndex`, "datasetIndex must be a non-negative integer.");
    for (const key of ["xAxisIndex", "yAxisIndex"] as const) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) unsupported(out, `${path}.${key}`, `${key} must be a non-negative integer.`);
    if (type === "gauge") for (const key of ["min", "max"] as const) if (raw[key] !== undefined && !finite(raw[key])) unsupported(out, `${path}.${key}`, `Gauge ${key} must be finite.`);
    if (direct && (raw.datasetIndex !== undefined || raw.encode !== undefined)) unsupported(out, path, "Series cannot mix direct data with dataset/encode.");
    let dataset: ChartDataset | undefined, fields: Obj;
    if (direct) { const built = directDataset(type, raw.data, `direct-${sid}`, `${path}.data`, out); if (!built) return; dataset = built.dataset; fields = built.fields; generated.push(dataset); }
    else { const datasetIndex = raw.datasetIndex === undefined ? 0 : raw.datasetIndex; dataset = Number.isSafeInteger(datasetIndex) ? source[datasetIndex as number] : undefined; if (!dataset || !object(raw.encode)) { unsupported(out, path, "Dataset series requires valid datasetIndex and explicit encode."); return; } fields = raw.encode; unknown(raw.encode, type === "pie" || type === "gauge" ? ["itemName", "value"] : type === "heatmap" ? ["x", "y", "value"] : ["x", "y"], `${path}.encode`, out); }
    const base = { id: sid, label: typeof raw.name === "string" && raw.name.trim() ? raw.name : sid, type, datasetId: dataset.id } as const;
    if (type === "pie") result.push({ ...base, type, name: dimension(fields.itemName ?? fields.name, dataset, `${path}.encode.itemName`, out), value: dimension(fields.value, dataset, `${path}.encode.value`, out) });
    else if (type === "gauge") result.push({ ...base, type, name: dimension(fields.itemName ?? fields.name, dataset, `${path}.encode.itemName`, out), value: dimension(fields.value, dataset, `${path}.encode.value`, out), min: finite(raw.min) ? raw.min : 0, max: finite(raw.max) ? raw.max : 100 });
    else { const xi = Number.isSafeInteger(raw.xAxisIndex) ? raw.xAxisIndex as number : 0, yi = Number.isSafeInteger(raw.yAxisIndex) ? raw.yAxisIndex as number : 0; const commonCartesian = { ...base, x: dimension(fields.x, dataset, `${path}.encode.x`, out), y: dimension(fields.y, dataset, `${path}.encode.y`, out), xAxisId: xAxes[xi]?.id ?? "missing-x", yAxisId: yAxes[yi]?.id ?? "missing-y" }; if (type === "heatmap") result.push({ ...commonCartesian, type, value: dimension(fields.value, dataset, `${path}.encode.value`, out) }); else result.push({ ...commonCartesian, type }); }
  });
  return { datasets: generated, series: result };
}

function legend(value: unknown, out: ChartDiagnostic[]): Obj | undefined { if (value === undefined) return; if (!object(value)) { unsupported(out, "$.legend", "Legend must be one object."); return; } unknown(value, ["show", "left", "top"], "$.legend", out); let position = "top"; if (["left", "right"].includes(value.left as string)) position = value.left as string; else if (["top", "bottom"].includes(value.top as string)) position = value.top as string; else if (value.left !== undefined && value.left !== "center" && value.left !== "auto") unsupported(out, "$.legend.left", "Unsupported legend position."); return { visible: value.show === undefined ? true : value.show, position }; }
function tooltip(value: unknown, out: ChartDiagnostic[]): Obj | undefined { if (value === undefined) return; if (!object(value)) { unsupported(out, "$.tooltip", "Tooltip must be one object."); return; } unknown(value, ["show", "trigger", "formatter"], "$.tooltip", out); if (value.formatter !== undefined) unsupported(out, "$.tooltip.formatter", "Formatter execution is not supported in the headless contract."); return { enabled: value.show === undefined ? true : value.show, trigger: value.trigger ?? "item" }; }

function interactions(zoomValue: unknown, actionValue: unknown, xAxes: ChartAxisSpec[], yAxes: ChartAxisSpec[], series: ChartSeries[], out: ChartDiagnostic[]): { zooms: Obj[]; actions: ChartAction[] } {
  const zooms = list(zoomValue).flatMap((raw, i) => { const p = `$.dataZoom[${i}]`; if (!object(raw)) { unsupported(out, p, "dataZoom must be an object."); return []; } unknown(raw, ["id", "type", "start", "end", "xAxisIndex", "yAxisIndex"], p, out); const x = raw.xAxisIndex, y = raw.yAxisIndex; if ((x === undefined) === (y === undefined)) { unsupported(out, p, "dataZoom must target exactly one axis index."); return []; } const target = x !== undefined ? xAxes[x as number] : yAxes[y as number]; if (!target) { unsupported(out, p, "dataZoom axis index is invalid."); return []; } return [{ id: typeof raw.id === "string" ? raw.id : `zoom-${i}`, axisId: target.id, start: raw.start ?? 0, end: raw.end ?? 100, mode: raw.type ?? "slider" }]; });
  const actions = list(actionValue).flatMap((raw, i) => { const p = `$actions[${i}]`; if (!object(raw) || !["highlight", "downplay", "select", "unselect", "dataZoom"].includes(raw.type as string)) { unsupported(out, p, "Unsupported ECharts dispatch action."); return []; } if (raw.type === "dataZoom") { unknown(raw, ["type", "xAxisIndex", "yAxisIndex", "start", "end"], p, out); const x = raw.xAxisIndex, y = raw.yAxisIndex; if ((x === undefined) === (y === undefined)) { unsupported(out, p, "dataZoom action must target one axis."); return []; } const target = x !== undefined ? xAxes[x as number] : yAxes[y as number]; return target ? [{ type: "dataZoom" as const, axisId: target.id, start: raw.start as number, end: raw.end as number }] : (unsupported(out, p, "Action axis index is invalid."), []); } unknown(raw, ["type", "seriesId", "seriesIndex", "dataIndex"], p, out); const target = typeof raw.seriesId === "string" ? series.find((s) => s.id === raw.seriesId) : series[raw.seriesIndex as number]; return target ? [{ type: raw.type, seriesId: target.id, dataIndex: raw.dataIndex ?? null } as ChartAction] : (unsupported(out, p, "Action series target is invalid."), []); });
  return { zooms, actions };
}

/** Compile a deliberately bounded ECharts option/action subset without importing or executing ECharts. */
export function compileEChartsOption(option: unknown, dispatchedActions: unknown = []): ChartCompileResult {
  const optionDiagnostics = validateChartJson(option), actionDiagnostics = validateChartJson(dispatchedActions).map((d) => ({ ...d, path: `$actions${d.path.slice(1)}` }));
  const diagnostics = [...optionDiagnostics, ...actionDiagnostics].map((d) => d.code === "invalid-json" ? { ...d, code: "unsupported" as const, message: "Dynamic functions, accessors and non-JSON values are unsupported." } : d);
  if (diagnostics.length || !object(option)) return { ok: false, diagnostics: diagnostics.length ? diagnostics : [{ code: "unsupported", path: "$", message: "ECharts option must be a JSON object." }] };
  unknown(option, ["id", "dataset", "xAxis", "yAxis", "series", "legend", "tooltip", "dataZoom"], "$", diagnostics);
  const xAxes = axes(option.xAxis, "x", diagnostics), yAxes = axes(option.yAxis, "y", diagnostics), source = datasets(option.dataset, diagnostics);
  const compiled = compileSeries(option.series, source, xAxes, yAxes, diagnostics), allSeries = compiled.series, allDatasets = [...source, ...compiled.datasets];
  const interaction = interactions(option.dataZoom, dispatchedActions, xAxes, yAxes, allSeries, diagnostics);
  const legendConfig = legend(option.legend, diagnostics), tooltipConfig = tooltip(option.tooltip, diagnostics);
  const spec = { schemaVersion: CHART_SPEC_SCHEMA_VERSION, id: typeof option.id === "string" ? option.id : "echarts-option", datasets: allDatasets, axes: [...xAxes, ...yAxes], series: allSeries, ...(legendConfig ? { legend: legendConfig } : {}), ...(tooltipConfig ? { tooltip: tooltipConfig } : {}), dataZoom: interaction.zooms, actions: interaction.actions };
  if (diagnostics.length) return { ok: false, diagnostics };
  const result = compileChartSpec(spec); return result.ok ? result : { ok: false, diagnostics: [...diagnostics, ...result.diagnostics] };
}
