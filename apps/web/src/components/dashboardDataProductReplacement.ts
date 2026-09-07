import type { DashboardDataWidgetConfig, DataDatasetField } from "@bim-studio/contracts";

/**
 * Rebinds a widget while preserving semantic field roles whenever the target
 * product exposes matching keys. Missing roles are remapped by field type so
 * an inserted template can switch from mock data to a real dataset in one go.
 */
export function replaceDashboardWidgetDataProduct(
  widget: DashboardDataWidgetConfig,
  productKey: string,
  fields: readonly DataDatasetField[]
): DashboardDataWidgetConfig {
  const next = structuredClone(widget);
  delete next.datasetId;
  delete next.pipelineId;
  delete next.directBinding;
  delete next.sampleData;
  delete next.semanticBinding;
  if (!productKey) return next;
  const separator = productKey.indexOf(":");
  const kind = productKey.slice(0, separator);
  const productId = productKey.slice(separator + 1);
  if (!productId || (kind !== "dataset" && kind !== "pipeline")) return next;
  if (kind === "dataset") next.datasetId = productId;
  else next.pipelineId = productId;

  const keys = new Set(fields.map((field) => field.key));
  const numeric = fields.find((field) => field.type === "number") ?? fields[0];
  const dimension = fields.find((field) => field.type === "string" || field.type === "datetime") ?? fields[0];
  const secondDimension = fields.find((field) => field.key !== dimension?.key && (field.type === "string" || field.type === "datetime"));
  const keepOr = (key: string | undefined, fallback: DataDatasetField | undefined) => key && keys.has(key) ? key : fallback?.key;
  const measureKey = keepOr(next.analysis?.measureField ?? next.field, numeric);
  const dimensionKey = keepOr(next.analysis?.dimensionField, dimension);
  const seriesKey = keepOr(next.analysis?.seriesField, secondDimension);

  if (measureKey) {
    next.field = measureKey;
    next.key = `${productId}.${measureKey}`;
    const field = fields.find((candidate) => candidate.key === measureKey);
    if (!next.unit && field?.unit) next.unit = field.unit;
  }
  if (next.analysis) next.analysis = {
    ...next.analysis,
    ...(dimensionKey ? { dimensionField: dimensionKey } : {}),
    ...(measureKey ? { measureField: measureKey } : {}),
    ...(seriesKey ? { seriesField: seriesKey } : {})
  };
  if (next.report) {
    const valueFields = (next.report.valueFields ?? []).map((key) => keepOr(key, numeric)).filter((key): key is string => Boolean(key));
    const rowKey = keepOr(next.report.rowField, dimension) ?? dimensionKey;
    const columnKey = keepOr(next.report.columnField, secondDimension);
    const valueKey = keepOr(next.report.valueField, numeric) ?? measureKey;
    next.report = {
      ...next.report,
      ...(rowKey ? { rowField: rowKey } : {}),
      ...(columnKey ? { columnField: columnKey } : {}),
      ...(valueKey ? { valueField: valueKey } : {}),
      ...(valueFields.length ? { valueFields: [...new Set(valueFields)] } : measureKey ? { valueFields: [measureKey] } : {})
    };
  }
  if (next.map) next.map = {
    ...next.map,
    ...(dimensionKey ? { regionField: keepOr(next.map.regionField, dimension) ?? dimensionKey } : {}),
    ...(measureKey ? { valueField: keepOr(next.map.valueField, numeric) ?? measureKey } : {})
  };
  return next;
}
