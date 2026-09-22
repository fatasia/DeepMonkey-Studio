import { array, fields, record, requireValue, string } from "./primitives.js";
import type { ChartIR } from "../chartIr.js";
import { validateChartIR } from "../chartIrReader.js";
import type { DashboardRuntimePageV1 } from "./dashboardCompositionTypes.js";

export function validateDashboardFilter(value: unknown, pages: readonly DashboardRuntimePageV1[], payloads: Readonly<Record<string, unknown>>, path: string, hasTableFamilies = false) {
  const filter = record(value, path);
  fields(filter, ["nodeId", "sourceNodeId", "key", "options"], ["presentation"], path);
  const select = filter.presentation === undefined ? undefined : record(filter.presentation, `${path}.presentation`);
  if (select) {
    fields(select, ["kind", "rowHeight", "visibleRows"], [], `${path}.presentation`);
    requireValue(select.kind === "select-v1" && select.rowHeight === 32 && select.visibleRows === 8, path, "Unsupported select presentation profile.");
  }
  const nodes = pages.flatMap(page => page.nodes), node = nodes.find(node => node.id === filter.nodeId);
  requireValue(node && node.visible && node.hitId === node.id && node.deep2d !== null && node.chart === null,
    path, "Filter requires its visible, hit-enabled static node.");
  for (const key of ["key", "sourceNodeId"]) {
    const text = string(filter[key], `${path}.${key}`);
    requireValue(text.length > 0 && text.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(text), path, "Invalid filter identity.");
  }
  const options = array(filter.options, `${path}.options`, select ? 256 : 16), values = new Set();
  requireValue(options.length > 0, path, "Filter requires options.");
  requireValue(node.frame[2] > (select ? 58 : 34) && node.frame[3] - 34 >= (select ? 32 : 18 * options.length), path, "Filter option layout is too small.");
  requireValue(new TextEncoder().encode(JSON.stringify(value)).length <= 4 * 1024 * 1024, path, "Filter variants exceed 4 MiB.");
  let targetShape: string | undefined;
  let visibilityShape: string | undefined;
  for (const optionValue of options) {
    const option = record(optionValue, path); fields(option, ["value", "updates"], ["visibility"], path);
    const label = string(option.value, path);
    requireValue(label.length > 0 && label.length <= 256 && !values.has(label), path, "Invalid or duplicate filter option."); values.add(label);
    const targets = new Set(), updates = array(option.updates, path, 32);
    const visibility = option.visibility === undefined ? [] : array(option.visibility, path, 128);
    requireValue(updates.length > 0 || visibility.length > 0 || hasTableFamilies, path, "Filter requires data updates.");
    const staticTargets = new Set<string>();
    for (const item of visibility) {
      const entry = record(item, path); fields(entry, ["nodeId", "visible"], [], path);
      const target = nodes.find(node => node.id === entry.nodeId);
      requireValue(target && target.id !== filter.nodeId && target.chart === null && target.chartSim === null
        && target.deep2d !== null && target.hitId === null && typeof entry.visible === "boolean"
        && !staticTargets.has(target.id), path, "Invalid filter static target.");
      staticTargets.add(target.id);
    }
    const staticShape = JSON.stringify([...staticTargets].sort());
    requireValue(visibilityShape === undefined || visibilityShape === staticShape, path, "Filter static target set changed.");
    visibilityShape = staticShape;
    for (const updateValue of updates) {
      const update = record(updateValue, path); fields(update, ["nodeId", "datasets"], [], path);
      const target = nodes.find(node => node.id === update.nodeId);
      requireValue(target?.chart && target.chartSim === null && !targets.has(target.id), path, "Invalid filter target."); targets.add(target.id);
      const source = (payloads[target.chart] as { chart: ChartIR }).chart;
      const datasets = array(update.datasets, path, 32);
      requireValue(datasets.length === source.datasets.length, path, "Filter must replace all datasets.");
      const next = structuredClone(source);
      datasets.forEach((dataValue, index) => {
        const data = record(dataValue, path); fields(data, ["datasetId", "rows"], [], path);
        requireValue(data.datasetId === source.datasets[index]!.id, path, "Filter dataset identity mismatch.");
        (next.datasets[index] as { rows: unknown }).rows = data.rows;
      });
      requireValue(validateChartIR(next).ok, path, "Invalid filter chart rows.");
    }
    const shape = JSON.stringify([...targets].sort());
    requireValue(targetShape === undefined || targetShape === shape, path, "Filter target set changed."); targetShape = shape;
  }
}
