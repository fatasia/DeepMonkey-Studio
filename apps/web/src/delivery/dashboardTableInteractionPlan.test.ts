import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { dashboardReportView } from "../components/dashboardReportView";
import { dashboardTableInteractionPlan } from "./dashboardTableInteractionPlan";
const widget: DashboardDataWidgetConfig = { type: "table", title: "机组运行表", key: "units", unit: "", report: { mode: "detail", pageSize: 2 } };
const metric = { value: 0, samples: [], rows: [{ name: "甲", power: 20 }, { name: "乙", power: 3 }, { name: "丙", power: 10 }] };
describe("same-source Native table interaction plan", () => {
  it("freezes all column orders, keeps numeric sorting and exports all sorted rows, not only the current page", async () => {
    const plan = await dashboardTableInteractionPlan(widget, metric);
    expect(plan).toHaveLength(5);
    const ascending = plan.find(order => order.sort?.column === "power" && order.sort.direction === "asc")!;
    expect(ascending.rows.map(row => row.power)).toEqual([3, 10, 20]);
    expect(ascending.pages).toEqual([{ page: 0, sort: ascending.sort }, { page: 1, sort: ascending.sort }]);
    expect(dashboardReportView(widget, metric, { page: 1, sort: ascending.sort }).visibleRows).toEqual([{ name: "甲", power: 20 }]);
    expect(new TextDecoder().decode(ascending.exports.csv)).toContain("乙,3\r\n丙,10\r\n甲,20");
    const xml = await (await JSZip.loadAsync(ascending.exports.xlsx)).file("xl/worksheets/sheet1.xml")!.async("string");
    expect(xml.indexOf("乙")).toBeLessThan(xml.indexOf("丙"));
    expect(xml.indexOf("丙")).toBeLessThan(xml.indexOf("甲"));
  });
  it("clamps the page after filtering and keeps the active sort", () => {
    const view = dashboardReportView(widget, { ...metric, rows: metric.rows.slice(0, 1) }, { page: 4, sort: { column: "power", direction: "desc" } });
    expect(view.page).toBe(0); expect(view.visibleRows).toEqual(metric.rows.slice(0, 1));
  });
  it("keeps an empty view without inventing rows, and cancels before producing exports", async () => {
    const plan = await dashboardTableInteractionPlan(widget, { ...metric, rows: [] });
    expect(plan).toHaveLength(1); expect(plan[0]!.rows).toEqual([]); expect(plan[0]!.pages).toEqual([{ page: 0, sort: undefined }]);
    const controller = new AbortController(); controller.abort();
    await expect(dashboardTableInteractionPlan(widget, metric, controller.signal)).rejects.toThrow();
  });
});
