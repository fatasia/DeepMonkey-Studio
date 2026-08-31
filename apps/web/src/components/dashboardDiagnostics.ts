import type { ApplicationDocument, DashboardDataWidgetNode, DashboardPageDocument } from "@bim-studio/contracts";

export type DashboardDiagnosticSeverity = "error" | "warning" | "info";

export interface DashboardDiagnostic {
  code: "empty-filter-key" | "duplicate-filter-key" | "missing-parent-filter" | "filter-cycle" | "orphan-linkage" | "invalid-drill-hierarchy" | "incomplete-drill-analysis";
  severity: DashboardDiagnosticSeverity;
  pageId: string;
  nodeId: string;
  zh: string;
  en: string;
}

export function diagnoseDashboardPage(application: ApplicationDocument, page: DashboardPageDocument): DashboardDiagnostic[] {
  const diagnostics: DashboardDiagnostic[] = [];
  const pageWidgets = page.nodes.filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget");
  const allFilters = application.pages.flatMap((candidate) =>
    candidate.nodes.filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget" && node.widget.type === "filter"),
  );
  const filterKeys = new Set(allFilters.map((node) => node.widget.key.trim()).filter(Boolean));
  const pageFilters = pageWidgets.filter((node) => node.widget.type === "filter");
  const pageFiltersByKey = new Map<string, DashboardDataWidgetNode[]>();

  for (const node of pageFilters) {
    const key = node.widget.key.trim();
    if (!key) {
      diagnostics.push(
        issue("empty-filter-key", "error", page.id, node.id, "筛选器没有绑定参数，运行时无法发布筛选值。", "The filter has no bound parameter and cannot publish a runtime value."),
      );
      continue;
    }
    pageFiltersByKey.set(key, [...(pageFiltersByKey.get(key) ?? []), node]);
    const parent = node.widget.parentFilterKey?.trim();
    if (parent && !filterKeys.has(parent))
      diagnostics.push(
        issue(
          "missing-parent-filter",
          "error",
          page.id,
          node.id,
          `上级参数“${parent}”不存在，级联筛选将一直禁用。`,
          `Parent parameter “${parent}” does not exist, so the cascade filter remains disabled.`,
        ),
      );
  }

  for (const [key, nodes] of pageFiltersByKey) {
    if (nodes.length < 2) continue;
    for (const node of nodes)
      diagnostics.push(
        issue(
          "duplicate-filter-key",
          "warning",
          page.id,
          node.id,
          `本页有 ${nodes.length} 个筛选器同时写入“${key}”，用户操作可能互相覆盖。`,
          `${nodes.length} filters on this page write “${key}”; user changes may overwrite each other.`,
        ),
      );
  }

  const parents = new Map(
    pageFilters.flatMap((node) => (node.widget.key.trim() && node.widget.parentFilterKey?.trim() ? [[node.widget.key.trim(), node.widget.parentFilterKey.trim()] as const] : [])),
  );
  for (const node of pageFilters) {
    const start = node.widget.key.trim();
    if (!start) continue;
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current) {
      if (visited.has(current)) {
        diagnostics.push(
          issue("filter-cycle", "error", page.id, node.id, `筛选参数“${start}”存在循环级联关系。`, `Filter parameter “${start}” has a circular cascade dependency.`),
        );
        break;
      }
      visited.add(current);
      current = parents.get(current);
    }
  }

  for (const node of pageWidgets) {
    const linkage = node.widget.linkageParameterKey?.trim();
    if (linkage && !filterKeys.has(linkage))
      diagnostics.push(
        issue(
          "orphan-linkage",
          "warning",
          page.id,
          node.id,
          `点击联动写入“${linkage}”，但应用中没有筛选器消费该参数。`,
          `Click linkage writes “${linkage}”, but no filter in the application consumes that parameter.`,
        ),
      );
    const drillFields = node.widget.analysis?.drillFields?.map((field) => field.trim()).filter(Boolean) ?? [];
    if (drillFields.length === 1 || new Set(drillFields).size !== drillFields.length)
      diagnostics.push(issue("invalid-drill-hierarchy", "warning", page.id, node.id, "钻取层级至少需要两个不重复字段。", "A drill hierarchy needs at least two unique fields."));
    if (drillFields.length > 1 && !node.widget.analysis?.measureField)
      diagnostics.push(
        issue(
          "incomplete-drill-analysis",
          "error",
          page.id,
          node.id,
          "已配置钻取层级，但缺少指标字段，无法生成下一级聚合。",
          "A drill hierarchy is configured without a measure field, so lower-level aggregation cannot run.",
        ),
      );
  }

  const rank = { error: 0, warning: 1, info: 2 } satisfies Record<DashboardDiagnosticSeverity, number>;
  return diagnostics.sort((left, right) => rank[left.severity] - rank[right.severity] || left.nodeId.localeCompare(right.nodeId) || left.code.localeCompare(right.code));
}

function issue(code: DashboardDiagnostic["code"], severity: DashboardDiagnosticSeverity, pageId: string, nodeId: string, zh: string, en: string): DashboardDiagnostic {
  return { code, severity, pageId, nodeId, zh, en };
}
