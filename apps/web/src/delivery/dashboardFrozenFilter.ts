import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { buildDashboardSampleMetric } from "@bim-studio/data-runtime";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { applyDashboardFilters } from "../components/dashboardFilterRows";
import { dashboardSampleFilterWidgets } from "../components/dashboardSampleMetrics";
import { validateFrozenDashboardMetric } from "./dashboardDataValidation";
import { lowerDashboardChart } from "./lowerDashboardChart";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

/** Frozen variants reuse the Web query semantics; the player only applies verified dataset updates. */
export function compileFrozenFilterVariants(input: DashboardRasterCompileInput,
  identities: ReadonlyMap<string, string>) {
  const widgets = input.document.application.pages.flatMap(page => page.nodes)
    .filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget" && node.visible !== false);
  const filters = widgets.filter(node => node.widget.type === "filter" && node.widget.filterMode !== "text");
  if (!filters.length) return { reason: "No filter control" } as const;
  if (filters.length !== 1) return { reason: "Multiple filters require a bounded combination profile" } as const;
  const node = filters[0]!, widget = node.widget, options = widget.options ?? [];
  if (options.some(value => /^全部.+/u.test(value)))
    return { reason: "筛选选项仅支持字符串值；请将表示不过滤的“全部区域”等标签改为“全部”或“all”，否则它按普通精确值匹配" } as const;
  if ((widget.filterMode ?? "select") !== "select" || widget.parentFilterKey || widget.semanticBinding
    || !widget.key.trim() || !options.length || options.length > 256 || new Set(options).size !== options.length
    || options.some(value => !value.trim() || value.length > 256))
    return { reason: "Unsupported select filter profile" } as const;
  const targets = widgets.filter(target => ["bar", "line", "scatter", "pie"].includes(target.widget.type)
    && dashboardSampleFilterWidgets(target.widget, widgets.map(item => item.widget)).includes(widget));
  if (!targets.length && !input.filterData?.some(option => Object.keys(option.data).length))
    return { reason: "Filter has no supported frozen data target" } as const;
  const states = [];
  for (const value of options) {
    const updates = [];
    for (const target of targets) {
      const data = input.data?.[target.id];
      if (!data?.metric.rows) return { reason: `Filter target ${target.id} has no frozen source rows` } as const;
      validateFrozenDashboardMetric(data);
      // Sample metrics have a shared rows→samples contract. Other source kinds need their own frozen derivation.
      if (data.source.kind !== "sample") return { reason: `Filter target ${target.id} requires a non-sample derivation profile` } as const;
      const rows = applyDashboardFilters(structuredClone(data.metric.rows) as Array<Record<string, unknown>>,
        { [widget.key]: value }, [widget]);
      const metric = JSON.parse(JSON.stringify(buildDashboardSampleMetric(target.widget,
        rows as NonNullable<typeof target.widget.sampleData>["rows"])));
      const runtimeId = identities.get(target.id);
      if (!runtimeId) throw new Error("Filter chart identity missing");
      const base = lowerDashboardChart({ nodeId: runtimeId, revision: 1, widget: target.widget, data });
      if (rows.length === 0 && base.chart) {
        updates.push({ nodeId: runtimeId, datasets: base.chart.value.datasets.map(dataset => ({ datasetId: dataset.id, rows: [] })) });
        continue;
      }
      const lowered = lowerDashboardChart({ nodeId: runtimeId, revision: 1, widget: target.widget,
        data: { source: { ...data.source, contentSha256: runtimeContentSha256(metric) }, metric } });
      if (!base.chart || !lowered.chart) return { reason: `Filter target ${target.id} has an unsupported or empty chart variant` } as const;
      const shape = (chart: typeof base.chart.value) => ({ ...chart,
        datasets: chart.datasets.map(dataset => ({ ...dataset, rows: [] })) });
      if (runtimeContentSha256(shape(base.chart.value)) !== runtimeContentSha256(shape(lowered.chart.value)))
        return { reason: `Filter target ${target.id} changes chart structure` } as const;
      updates.push({ nodeId: runtimeId, datasets: lowered.chart.value.datasets.map(dataset => ({
        datasetId: dataset.id, rows: dataset.rows })) });
    }
    states.push({ value, updates });
  }
  const nodeId = identities.get(node.id);
  if (!nodeId) throw new Error("Filter node identity missing");
  const filter = { nodeId, sourceNodeId: node.id, key: widget.key, options: states,
    presentation: { kind: "select-v1" as const, rowHeight: 32, visibleRows: 8 } };
  if (new TextEncoder().encode(JSON.stringify(filter)).length > 4 * 1024 * 1024)
    return { reason: "Frozen filter variants exceed the 4 MiB aggregate budget" } as const;
  return { filter } as const;
}
