import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import JSZip from "jszip";
import { buildDashboardPageExportEntries, downloadDashboardPageData } from "./dashboardPageExport";

afterEach(() => vi.restoreAllMocks());

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

describe("dashboard ZIP cancellation", () => {
  const page = { name: "report", nodes: [{ id: "table", kind: "data-widget", widget: { type: "table", key: "rows", title: "Rows", unit: "" } }] } as DashboardPageDocument;
  it("does not start an already cancelled export", async () => {
    const controller = new AbortController(), generate = vi.spyOn(JSZip.prototype, "generateAsync");
    controller.abort();
    await expect(downloadDashboardPageData(page, {}, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not download a ZIP that finishes after page exit", async () => {
    const controller = new AbortController(), create = vi.spyOn(URL, "createObjectURL");
    vi.spyOn(JSZip.prototype, "generateAsync").mockImplementation(async () => { controller.abort(); return new Blob(["zip"]); });
    await expect(downloadDashboardPageData(page, {}, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(create).not.toHaveBeenCalled();
  });
});
