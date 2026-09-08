import { describe, expect, it } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { dashboardPageUsesSampleData, dashboardPrintLayout } from "./dashboardPrintLayout";
import { readFileSync } from "node:fs";

describe("dashboard paper layout", () => {
  it("overrides inline branding color scheme only on printed dashboard paper", () => {
    const printCss = readFileSync(new URL("./DashboardPrint.css", import.meta.url), "utf8");
    expect(printCss).toMatch(/@media print\s*\{\s*html:has\(\.dashboard-runtime-preview\), body:has\(\.dashboard-runtime-preview\)\s*\{\s*color-scheme:\s*light\s*!important/);
    expect(printCss).toContain(".dashboard-runtime-artboard .dashboard-report-table > header > span");
  });
  it.each([[1920, 1080], [1080, 1920], [6000, 400], [400, 6000], [10, 10]])("fits %s × %s without stretching or clipping", (width, height) => {
    const layout = dashboardPrintLayout(width, height);
    const landscape = width >= height;
    expect(layout.orientation).toBe(landscape ? "landscape" : "portrait");
    expect(width * layout.scale).toBeLessThanOrEqual((landscape ? 281 : 194) * 96 / 25.4 + 1e-8);
    expect(height * layout.scale).toBeLessThanOrEqual((landscape ? 174 : 261) * 96 / 25.4 + 1e-8);
    expect(layout.style).toMatchObject({ "--dashboard-print-content-inset": "8mm", "--dashboard-print-content-height": landscape ? "174mm" : "261mm" });
    expect(layout.scale).toBeGreaterThan(0);
  });
  it("keeps malformed legacy dimensions finite", () => {
    expect(dashboardPrintLayout(Number.NaN, 0)).toEqual(dashboardPrintLayout(1920, 1080));
  });
  it("prints a sample notice only for visible sample widgets, including mixed and empty sample data", () => {
    const sample = { kind: "data-widget", widget: { sampleData: { rows: [] } } };
    const actual = { kind: "data-widget", widget: { dataBinding: { sourceId: "live" } } };
    const page = (nodes: unknown[]) => ({ nodes } as DashboardPageDocument);
    expect(dashboardPageUsesSampleData(page([sample, actual]))).toBe(true);
    expect(dashboardPageUsesSampleData(page([actual]))).toBe(false);
    expect(dashboardPageUsesSampleData(page([{ ...sample, visible: false }, actual]))).toBe(false);
    expect(dashboardPageUsesSampleData(page([]))).toBe(false);
  });
});
