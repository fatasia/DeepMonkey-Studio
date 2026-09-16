import { CHART_BUDGETS, validateChartJson, type ChartDiagnostic, type ChartValue } from "./chartIr.js";

export const CHART_DATA_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
export interface ChartDataUpdateMessage {
  readonly schema: "deep-engine.chart-data-update";
  readonly schemaVersion: 1;
  readonly chartId: string;
  readonly expectedDataRevision: number;
  readonly dataRevision: number;
  readonly datasets: readonly ChartDatasetRowsUpdate[];
}
export type ChartDatasetRowsUpdate =
  | { readonly kind: "replace"; readonly datasetId: string; readonly rows: readonly (readonly ChartValue[])[] }
  | { readonly kind: "append-window"; readonly datasetId: string; readonly rows: readonly (readonly ChartValue[])[]; readonly maxRows: number };
export interface ChartDataMessageResult {
  readonly ok: boolean;
  readonly message?: ChartDataUpdateMessage;
  readonly diagnostics: readonly ChartDiagnostic[];
}

const stableId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v)
  && !["__proto__", "prototype", "constructor"].includes(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Envelope validation is independent of the active chart; dataset references and row widths resolve at commit. */
export function validateChartDataUpdate(input: unknown): ChartDataMessageResult {
  const diagnostics = [...validateChartJson(input)];
  if (diagnostics.length) return { ok: false, diagnostics };
  const add = (path: string, message: string) => { if (diagnostics.length < CHART_BUDGETS.diagnostics)
    diagnostics.push({ code: "invalid-value", path, message }); };
  const keys = (value: Record<string, unknown>, allowed: string[], path: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${path}.${key}`, "Unknown data-message field.");
  };
  if (!object(input)) return { ok: false, diagnostics: [{ code: "invalid-schema", path: "$", message: "Expected chart data message." }] };
  keys(input, ["schema", "schemaVersion", "chartId", "expectedDataRevision", "dataRevision", "datasets"], "$");
  if (input.schema !== "deep-engine.chart-data-update" || input.schemaVersion !== 1) add("$", "Expected ChartDataUpdate v1.");
  if (!stableId(input.chartId)) add("$.chartId", "Expected a stable chart identifier.");
  for (const field of ["expectedDataRevision", "dataRevision"] as const)
    if (!Number.isSafeInteger(input[field]) || (input[field] as number) < 0) add(`$.${field}`, "Expected a nonnegative safe revision.");
  if ((input.expectedDataRevision as number) + 1 !== input.dataRevision) add("$.dataRevision", "Revision must advance exactly once.");
  if (!Array.isArray(input.datasets) || !input.datasets.length || input.datasets.length > CHART_BUDGETS.datasets) {
    add("$.datasets", "Expected a nonempty bounded dataset batch.");
  } else {
    const ids = new Set<string>();
    input.datasets.forEach((item: unknown, index: number) => {
      const path = `$.datasets[${index}]`;
      if (!object(item)) { add(path, "Expected a dataset update."); return; }
      keys(item, item.kind === "append-window" ? ["kind", "datasetId", "rows", "maxRows"] : ["kind", "datasetId", "rows"], path);
      if (!["replace", "append-window"].includes(item.kind as string)) add(`${path}.kind`, "Unsupported dataset update.");
      if (!stableId(item.datasetId) || ids.has(item.datasetId as string)) add(`${path}.datasetId`, "Expected a unique stable dataset identifier.");
      ids.add(item.datasetId as string);
      if (item.kind === "append-window" && (!Number.isSafeInteger(item.maxRows) || (item.maxRows as number) < 1 || (item.maxRows as number) > CHART_BUDGETS.rows))
        add(`${path}.maxRows`, "Window limit is outside the row budget.");
      if (!Array.isArray(item.rows) || item.rows.length > CHART_BUDGETS.rows) { add(`${path}.rows`, "Invalid or oversized row batch."); return; }
      item.rows.forEach((row: unknown, rowIndex: number) => {
        if (!Array.isArray(row) || row.length > CHART_BUDGETS.dimensions || row.some(value => value !== null && typeof value === "object"))
          add(`${path}.rows[${rowIndex}]`, "Expected bounded scalar cells.");
      });
    });
  }
  return diagnostics.length ? { ok: false, diagnostics }
    : { ok: true, diagnostics, message: structuredClone(input) as unknown as ChartDataUpdateMessage };
}

export function parseChartDataUpdate(text: string): ChartDataMessageResult {
  if (text.length > CHART_DATA_MESSAGE_MAX_BYTES || new TextEncoder().encode(text).byteLength > CHART_DATA_MESSAGE_MAX_BYTES)
    return { ok: false, diagnostics: [{ code: "budget-exceeded", path: "$", message: "Chart data message exceeds 16 MiB." }] };
  try { return validateChartDataUpdate(JSON.parse(text)); }
  catch { return { ok: false, diagnostics: [{ code: "invalid-json", path: "$", message: "Invalid chart data JSON." }] }; }
}
