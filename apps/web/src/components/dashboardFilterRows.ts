import type { DashboardDataWidgetConfig, JsonValue } from "@bim-studio/contracts";

export function readDashboardPath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) =>
    current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined, row);
}

export function applyDashboardFilters(rows: Array<Record<string, unknown>>,
  filters: Readonly<Record<string, JsonValue>>, widgets: readonly DashboardDataWidgetConfig[]): Array<Record<string, unknown>> {
  const active = widgets.filter(widget => widget.type === "filter").flatMap(widget => {
    const value = filters[widget.key];
    if (widget.parentFilterKey && !activeDashboardFilterValue(filters[widget.parentFilterKey])) return [];
    if (!activeDashboardFilterValue(value)) return [];
    return [{ field: widget.filterField?.trim() || widget.key, value,
      match: widget.filterMatch ?? (widget.filterMode === "text" ? "contains" : "exact") }];
  });
  if (active.length === 0) return rows;
  return rows.filter(row => active.every(({ field, value, match }) => {
    const resolved = readDashboardPath(row, field);
    if (resolved === undefined) return false;
    const candidate = String(resolved ?? "");
    if (Array.isArray(value)) return value.some(item => candidate === String(item));
    return match === "contains" ? candidate.toLocaleLowerCase().includes(String(value).toLocaleLowerCase()) : candidate === String(value);
  }));
}

function activeDashboardFilterValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some(activeDashboardFilterValue);
  return !/^(全部|all)$/i.test(String(value));
}
