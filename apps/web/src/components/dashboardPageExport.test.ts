import { describe, expect, it } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { buildDashboardPageExportEntries } from "./dashboardPageExport";

describe("buildDashboardPageExportEntries", () => {
  it("exports every report widget with unique safe file names and current report shape", () => {
    const page = {
      id: "page-1", name: "经营/总览", width: 1920, height: 1080, viewportFit: "contain", appearance: {}, guides: [],
      nodes: [
        { id: "table-1", name: "区域/报表", kind: "data-widget", frame: { x: 0, y: 0, width: 400, height: 300 }, zIndex: 1, widget: { title: "区域报表", key: "sales", type: "table", unit: "", report: { mode: "grouped", rowField: "region", valueFields: ["sales", "cost"], aggregation: "sum" } } },
        { id: "table-2", name: "区域/报表", kind: "data-widget", frame: { x: 0, y: 320, width: 400, height: 300 }, zIndex: 2, widget: { title: "区域报表", key: "sales", type: "scroll-table", unit: "", report: { mode: "detail" } } }
      ]
    } as unknown as DashboardPageDocument;
    const metrics = { sales: { value: 10, samples: [], rows: [{ region: "华东", sales: 10, cost: 4 }] } };

    const entries = buildDashboardPageExportEntries(page, metrics);

    expect(entries.map((entry) => entry.fileName)).toEqual(["区域-报表.csv", "区域-报表-2.csv"]);
    expect(entries[0]!.csv).toContain("region,sales,cost");
    expect(entries[1]!.csv).toContain("华东,10,4");
  });
});
