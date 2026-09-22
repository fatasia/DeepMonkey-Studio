import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { buildDashboardSampleMetric } from "@bim-studio/data-runtime";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { applyDashboardFilters } from "../components/dashboardFilterRows";
import { dashboardSampleFilterWidgets } from "../components/dashboardSampleMetrics";
import { validateFrozenDashboardMetric } from "./dashboardDataValidation";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

/** Data-only derivation. Layouts must be captured again for each resulting metric. */
export function dashboardFilterDataVariants(input: DashboardRasterCompileInput) {
  const widgets = input.document.application.pages.flatMap(page => page.nodes)
    .filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget" && node.visible !== false);
  const filters = widgets.filter(node => node.widget.type === "filter" && node.widget.filterMode !== "text");
  if (filters.length !== 1) return [];
  const filter = filters[0]!.widget, options = filter.options ?? [];
  if ((filter.filterMode ?? "select") !== "select" || filter.parentFilterKey || filter.semanticBinding
    || !options.length || options.length > 256 || new Set(options).size !== options.length) return [];
  const targets = widgets.filter(node => ["value", "table"].includes(node.widget.type)
    && dashboardSampleFilterWidgets(node.widget, widgets.map(item => item.widget)).includes(filter));
  return options.map(value => ({ value, data: Object.fromEntries(targets.map(node => {
    const data = input.data?.[node.id];
    if (!data?.metric.rows || data.source.kind !== "sample") throw new Error(`Filter target ${node.id} requires frozen sample rows`);
    validateFrozenDashboardMetric(data);
    const rows = applyDashboardFilters(structuredClone(data.metric.rows) as Array<Record<string, unknown>>, { [filter.key]: value }, [filter]);
    const metric = JSON.parse(JSON.stringify(buildDashboardSampleMetric(node.widget,
      rows as NonNullable<typeof node.widget.sampleData>["rows"])));
    return [node.id, { source: { ...data.source, contentSha256: runtimeContentSha256(metric) }, metric }];
  })) }));
}
