import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";

/** 批量查询必须先写父参数再写子参数，否则父级联清理会擦除同次查询的子值。 */
export function dashboardParameterOrder(widgets: readonly DashboardDataWidgetConfig[]) {
  const ordered: DashboardDataWidgetConfig[] = [];
  const visited = new Set<string>();
  const byKey = new Map(widgets.map((widget) => [widget.key, widget]));
  const visit = (widget: DashboardDataWidgetConfig) => {
    if (visited.has(widget.key)) return;
    visited.add(widget.key);
    const parent = widget.parentFilterKey ? byKey.get(widget.parentFilterKey) : undefined;
    if (parent) visit(parent);
    ordered.push(widget);
  };
  widgets.forEach(visit);
  return ordered;
}
