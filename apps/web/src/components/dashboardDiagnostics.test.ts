import { describe, expect, it } from "vitest";
import type { ApplicationDocument, DashboardDataWidgetNode, DashboardPageDocument } from "@bim-studio/contracts";
import { diagnoseDashboardPage } from "./dashboardDiagnostics";

function node(id: string, widget: DashboardDataWidgetNode["widget"]): DashboardDataWidgetNode {
  return { id, name: id, kind: "data-widget", zIndex: 0, frame: { x: 0, y: 0, width: 200, height: 100 }, widget };
}

describe("dashboard linkage diagnostics", () => {
  it("detects missing parents, cycles, duplicate writers, orphan linkage, and invalid drill setup", () => {
    const page = {
      id: "page",
      name: "Dashboard",
      width: 1920,
      height: 1080,
      viewportFit: "contain",
      nodes: [
        node("region-a", { title: "地区", key: "region", type: "filter", unit: "", parentFilterKey: "city" }),
        node("region-b", { title: "地区副本", key: "region", type: "filter", unit: "" }),
        node("city", { title: "城市", key: "city", type: "filter", unit: "", parentFilterKey: "region" }),
        node("site", { title: "站点", key: "site", type: "filter", unit: "", parentFilterKey: "missing" }),
        node("chart", { title: "趋势", key: "trend", type: "bar", unit: "", linkageParameterKey: "unknown", analysis: { aggregation: "sum", drillFields: ["region", "region"] } }),
      ],
    } as DashboardPageDocument;
    const application = { pages: [page] } as ApplicationDocument;
    const diagnostics = diagnoseDashboardPage(application, page);
    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["duplicate-filter-key", "missing-parent-filter", "filter-cycle", "orphan-linkage", "invalid-drill-hierarchy"]),
    );
    expect(diagnostics.filter((item) => item.severity === "error").length).toBeGreaterThan(0);
  });

  it("accepts a valid cross-page parameter consumer and drill hierarchy", () => {
    const page = {
      id: "page",
      name: "Dashboard",
      width: 1920,
      height: 1080,
      viewportFit: "contain",
      nodes: [
        node("chart", {
          title: "趋势",
          key: "trend",
          type: "bar",
          unit: "",
          linkageParameterKey: "region",
          analysis: { aggregation: "sum", measureField: "value", drillFields: ["region", "city"] },
        }),
      ],
    } as DashboardPageDocument;
    const filterPage = { ...page, id: "filters", nodes: [node("region", { title: "地区", key: "region", type: "filter", unit: "" })] } as DashboardPageDocument;
    expect(diagnoseDashboardPage({ pages: [page, filterPage] } as ApplicationDocument, page)).toEqual([]);
  });
});
