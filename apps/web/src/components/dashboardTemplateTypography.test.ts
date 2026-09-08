import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig, DashboardPageDocument } from "@bim-studio/contracts";
import { createDashboardTemplateNodes } from "./DashboardTemplateCatalog";
import { dashboardAuthoredTypography } from "./dashboardTemplateTypography";
import { dashboardPiePercentLabel, dashboardReadableChartOptions } from "./dashboardReadableChartOptions";

const palette = { accent: "gold", text: "white", muted: "gray", line: "gray", surface: "black", series: ["blue", "green"] };
const widget = (patch: Partial<DashboardDataWidgetConfig>) => ({ type: "bar", title: "各产线产量", key: "output", unit: "件", ...patch } as DashboardDataWidgetConfig);

describe("authored template typography", () => {
  it("only applies explicit font settings without changing legacy values", () => {
    expect(dashboardAuthoredTypography(widget({}))).toBeUndefined();
    expect(dashboardAuthoredTypography(widget({ fontSize: Number.NaN }))).toBeUndefined();
    const authored = widget({ fontSize: 18 });
    expect(dashboardAuthoredTypography(authored)).toEqual({ "--dashboard-authored-font": "18px" });
    expect(authored.fontSize).toBe(18);
    const css = readFileSync(new URL("./DashboardTemplateTypography.css", import.meta.url), "utf8");
    expect(css).not.toContain("!important");
    expect(css).toContain(".dashboard-native-widget.authored-typography");
    const runtimeCss = readFileSync(new URL("../styles/dashboardWorkspacePolish.css", import.meta.url), "utf8");
    const backButton = runtimeCss.match(/\.dashboard-runtime-back\s*\{([^}]+)\}/)![1]!;
    expect(backButton).toContain("color: var(--text-strong)");
    expect(backButton).toContain("background: var(--surface-1)");
  });
  it("creates readable design-scale labels and enough vertical room in new templates", () => {
    const page = { width: 1920, height: 1080, nodes: [] } as unknown as DashboardPageDocument;
    const nodes = createDashboardTemplateNodes("zh-CN", page, "production", 0);
    expect(nodes[0]!.widget.fontSize).toBe(32);
    expect(nodes.slice(1).every(node => node.widget.fontSize === 24)).toBe(true);
    expect(nodes[1]!.frame.height).toBeGreaterThanOrEqual(80);
    expect(nodes[2]!.frame.height).toBeGreaterThanOrEqual(120);
    expect(nodes[7]!.widget.chart?.showLegend).toBe(true);
    expect(nodes[2]!.widget.sampleData!.rows[0]!["产量"]).toBe(1080);
  });
  it("keeps old chart path while honoring font, pie legend, labels and real categories", () => {
    expect(dashboardReadableChartOptions(widget({}), [], [], palette, false)).toBeUndefined();
    const input = [{ name: "产量", values: [1080, 920, 600] }];
    const option = dashboardReadableChartOptions(widget({ type: "pie", fontSize: 24, chart: { showLegend: true, showDataLabels: true } }), ["A", "B", "C"], input, palette, false)!;
    expect(option.legend).toMatchObject({ show: true, type: "scroll", textStyle: { fontSize: 24 } });
    expect(option.series).toMatchObject([{ data: [{ name: "A", value: 1080 }, { name: "B", value: 920 }, { name: "C", value: 600 }], label: { show: true, fontSize: 24 } }]);
    expect(input[0]!.values).toEqual([1080, 920, 600]);
  });
  it("retains secondary axis and stacking configuration without fabricating series", () => {
    const option = dashboardReadableChartOptions(widget({ type: "combo", fontSize: 24, chart: { stacked: true, secondaryAxisSeries: ["OEE"], showLegend: true } }), ["A"], [{ name: "产量", values: [100] }, { name: "OEE", values: [90] }], palette, true)!;
    expect(option.animation).toBe(false);
    expect(option.series).toMatchObject([{ type: "bar", yAxisIndex: 0, stack: "total" }, { type: "line", yAxisIndex: 1 }]);
  });
  it("reserves outside label room for portrait charts without hiding labels or categories", () => {
    const pie = widget({ type: "pie", fontSize: 24, chart: { showLegend: true, showDataLabels: true } });
    const option = dashboardReadableChartOptions(pie, ["A", "B", "C"], [{ name: "产量", values: [1080, 920, 600] }], { ...palette, width: 340 }, false)!;
    expect(option.series).toMatchObject([{ radius: ["26%", "42%"], label: { show: true }, data: [{ value: 1080 }, { value: 920 }, { value: 600 }] }]);
    expect(option.legend).toMatchObject({ show: true });
    expect(dashboardPiePercentLabel({ percent: 41.538461 })).toBe("41.5%");
    expect(dashboardPiePercentLabel({ percent: 100 })).toBe("100%");
    expect(dashboardPiePercentLabel({ percent: Number.NaN })).toBe("—");
  });
});
