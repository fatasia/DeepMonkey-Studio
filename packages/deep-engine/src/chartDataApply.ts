import type { ChartAction, ChartIR } from "./chartIr.js";
import { validateChartIR } from "./chartIrReader.js";
import { validateChartDataUpdate } from "./chartDataUpdate.js";

/** Pure source reconciliation. Host interaction state and GPU candidates remain separate commit participants. */
export function applyChartDataUpdate(source: ChartIR, dataRevision: number, input: unknown) {
  const checked = validateChartDataUpdate(input);
  if (!checked.ok || !checked.message) throw new Error(checked.diagnostics[0]?.message ?? "Invalid chart update.");
  const message = checked.message;
  if (message.chartId !== source.id || message.expectedDataRevision !== dataRevision) throw new Error("Stale chart data source or revision.");
  const validSource = validateChartIR(source);
  if (!validSource.ok || !validSource.ir) throw new Error("Invalid active ChartIR.");
  const mappings = new Map<string, (row: number) => number | undefined>();
  const datasets = [...validSource.ir.datasets];
  for (const update of message.datasets) {
    const index = datasets.findIndex(dataset => dataset.id === update.datasetId);
    if (index < 0) throw new Error(`Unknown chart dataset: ${update.datasetId}`);
    const dataset = datasets[index]!;
    if (update.rows.some(row => row.length !== dataset.dimensions.length)) throw new Error("Chart row width does not match dimensions.");
    const removed = update.kind === "append-window" ? Math.max(0, dataset.rows.length + update.rows.length - update.maxRows) : 0;
    const rows = update.kind === "replace" ? update.rows : [...dataset.rows, ...update.rows].slice(removed);
    const identityChanged = removed > 0;
    if (identityChanged || JSON.stringify(rows) !== JSON.stringify(dataset.rows)) {
      mappings.set(dataset.id, update.kind === "replace" ? () => undefined
        : row => row >= removed && row < dataset.rows.length ? row - removed : undefined);
    }
    datasets[index] = { ...dataset, rows };
  }
  const series = new Map(source.series.map(series => [series.id, series.datasetId]));
  const actions: ChartAction[] = [];
  for (const action of source.actions) {
    if (action.type === "dataZoom" || action.dataIndex === null) { actions.push(action); continue; }
    const map = mappings.get(series.get(action.seriesId)!);
    if (!map) { actions.push(action); continue; }
    const dataIndex = map(action.dataIndex);
    if (dataIndex !== undefined) actions.push({ ...action, dataIndex });
  }
  const candidate = validateChartIR({ ...validSource.ir, datasets, actions });
  if (!candidate.ok || !candidate.ir) throw new Error(candidate.diagnostics[0]?.message ?? "Invalid chart data candidate.");
  return { ir: candidate.ir, dataRevision: message.dataRevision };
}
