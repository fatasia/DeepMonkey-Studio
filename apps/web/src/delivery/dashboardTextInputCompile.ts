import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import type { DashboardRuntimeV1 } from "@bim-studio/deep-engine/runtime-package";
import { dashboardSampleFilterWidgets } from "../components/dashboardSampleMetrics";
import { lowerDashboardChart } from "./lowerDashboardChart";
import { readDashboardPath } from "../components/dashboardFilterRows";
import { base64 } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

type Input = NonNullable<DashboardRuntimeV1["textInput"]>;
export function compileDashboardTextInput(source: DashboardRasterCompileInput, identities: ReadonlyMap<string, string>): { input?: Input; reason?: string } {
  const widgets = source.document.application.pages.flatMap(page => page.nodes).filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget" && node.visible !== false);
  const filters = widgets.filter(node => node.widget.type === "filter");
  if (filters.length !== 1 || filters[0]!.widget.filterMode !== "text") return { reason: "text-v1 requires one text filter" };
  const node = filters[0]!, widget = node.widget, field = widget.filterField?.trim() || widget.key;
  const fail = (reason: string) => ({ reason: `Text input ${node.id}: ${reason}` });
  if (!widget.key.trim() || widget.parentFilterKey || widget.semanticBinding || !["zh-CN", "en-US"].includes(source.locale)) return fail("unsupported binding or locale");
  const assets = source.nodeAssets[node.id], style = assets?.textStyle;
  if (!style || !assets?.fonts?.length || assets.fonts.length > 8) return fail("frozen font bytes and computed style are required");
  if (node.frame.width < 96 || node.frame.width > 2048 || node.frame.height < 66 || style.fontSize > 32 || style.lineHeight > 32) return fail("unsupported single-line layout");
  let totalBytes = 0;
  const fonts = assets.fonts.map(id => {
    const font = source.assets[id];
    if (!font || font.faceIndex === undefined) throw new Error("Input frozen font reference missing");
    totalBytes += font.bytes.length;
    return { sha256: font.sha256, faceIndex: font.faceIndex, dataBase64: base64(font.bytes) };
  });
  if (totalBytes > 32 * 1024 * 1024) return fail("frozen fonts exceed 32 MiB");
  const targets = widgets.filter(target => ["bar", "line", "scatter", "pie", "value", "table", "gauge", "status", "progress"].includes(target.widget.type) && dashboardSampleFilterWidgets(target.widget, widgets.map(item => item.widget)).includes(widget));
  if (!targets.length) return fail("no frozen chart target");
  const bindings: Input["bindings"][number][] = [];
  for (const target of targets) {
    const analysis = target.widget.analysis, data = source.data?.[target.id], nodeId = identities.get(target.id);
    if (!["bar", "line"].includes(target.widget.type) || analysis?.dimensionField !== field || analysis.seriesField || analysis.calculatedFields?.length || analysis.limit
      || data?.source.kind !== "sample" || !data.metric.rows?.length || !nodeId) return fail(`target ${target.id} requires sample bar/line using the filter field as its dimension, without series/calculated fields/limit`);
    if (data.metric.rows.some(row => typeof readDashboardPath(row, field) !== "string" || !String(readDashboardPath(row, field)).length)) return fail("dimension requires nonempty source strings");
    const lowered = lowerDashboardChart({ nodeId, revision: 1, widget: target.widget, data });
    if (!lowered.chart || lowered.chart.value.datasets.length !== 1) return fail(`target ${target.id} cannot preserve frozen chart semantics`);
    const dataset = lowered.chart.value.datasets[0]!;
    if (dataset.rows.some(row => typeof row[0] !== "string" || Array.from(row[0]).some(c => !/[\x00-\x7f]/u.test(c) && c.toLowerCase() !== c.toUpperCase()))) return fail("category casing requires ASCII or uncased scripts such as Chinese");
    bindings.push({ nodeId, datasetId: dataset.id, rows: dataset.rows });
  }
  return { input: { kind: "text-v1", nodeId: identities.get(node.id)!, key: widget.key, locale: source.locale as Input["locale"],
    match: widget.filterMatch ?? "contains", maxGraphemes: 256, fonts,
    style: { fontSize: widget.fontSize ?? style.fontSize, lineHeight: style.lineHeight, fontWeight: widget.fontWeight ?? style.fontWeight,
      fontStyle: style.fontStyle, color: style.color }, bindings } };
}
