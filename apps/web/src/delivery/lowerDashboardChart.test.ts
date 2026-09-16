import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { buildDashboardCompositionRuntimePackage, runtimeContentSha256, validateDeepRuntimePackage, type RuntimeJson } from "@bim-studio/deep-engine/runtime-package";
import { lowerDashboardChart, type DashboardChartFrozenData } from "./lowerDashboardChart";

const widget: DashboardDataWidgetConfig = { title: "产量", key: "production", type: "bar", unit: "件",
  analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" } };
function snapshot(metric: DashboardChartFrozenData["metric"] = { samples: [],
  rows: [{ region: "华东", value: 3 }, { region: "华南", value: 8 }, { region: "华东", value: 4 }] }): DashboardChartFrozenData {
  return { source: { kind: "dataset", id: "production", revision: 1, contentSha256: runtimeContentSha256(metric) }, metric };
}
const lower = (patch: Partial<DashboardDataWidgetConfig> = {}, data = snapshot()) =>
  lowerDashboardChart({ nodeId: "author-chart", revision: 2, widget: { ...widget, ...patch }, data });

describe("frozen author chart lowering", () => {
  it("reuses grouping, formula and ordering without changing source rows", () => {
    const data = snapshot();
    const before = structuredClone(data);
    const result = lower({ analysis: { ...widget.analysis!, measureField: "double", sort: "value-desc",
      calculatedFields: [{ key: "double", label: "两倍", formula: "value * 2" }] } }, data);
    expect(result.status).toBe("degraded");
    expect(result.chart?.value.datasets[0]?.rows).toEqual([["华南", 16], ["华东", 14]]);
    expect(data).toEqual(before);
    expect(result.diagnostics.map(item => item.path)).toContain("presentation");
  });
  it("keeps stable chart identity while data evidence changes", () => {
    const a = lower(), b = lower({}, snapshot({ samples: [], rows: [{ region: "X", value: 90 }] }));
    expect(a.chart?.id).toBe(b.chart?.id);
    expect(a.sourceSha256).not.toBe(b.sourceSha256);
    expect(lower()).toEqual(a);
  });
  it("keeps scatter on the actual Web sample-index path instead of grouped values", () => {
    const result = lower({ type: "scatter" }, snapshot({ samples: [{ time: 99, value: 7 }, { time: 200, value: 9 }],
      rows: [{ region: "ignored", value: 800 }] }));
    expect(result.chart?.value.datasets[0]?.rows).toEqual([[0, 7], [1, 9]]);
    expect(result.chart?.value.axes[0]?.scale).toBe("linear");
    expect(result.chart?.value.legend.visible).toBe(false);
  });
  it("matches small pie data and the explicit-font legend path", () => {
    expect(lower({ type: "pie" }).chart?.value.legend.visible).toBe(false);
    const pie = lower({ type: "pie", fontSize: 18 });
    expect(pie.chart?.value.legend).toEqual({ visible: true, position: "bottom" });
    expect(pie.chart?.value.datasets[0]?.rows).toEqual([["华东", 7], ["华南", 8]]);
    const large = lower({ type: "pie", analysis: { aggregation: "none" } },
      snapshot({ samples: Array.from({ length: 21 }, (_, time) => ({ time, value: time })) }));
    expect(large.status).toBe("blocked");
    expect(large.diagnostics[0]?.message).toContain("20");
  });
  it.each(["area", "combo", "radar", "gauge"] as const)("does not silently convert %s", type => {
    expect(lower({ type }).status).toBe("blocked");
  });
  it.each([{ stacked: true }, { showDataLabels: true }, { secondaryAxisSeries: ["产量"] }])("rejects unsupported authored chart configuration %j", chart => {
    expect(lower({ chart }).chart).toBeUndefined();
  });
  it("reports unknown chart properties and unresolved semantic or drill bindings", () => {
    expect(lower({ chart: { future: true } as never }).diagnostics[0]?.path).toBe("widget.chart.future");
    expect(lower({ semanticBinding: { modelId: "m", revision: 1 } }).status).toBe("blocked");
    expect(lower({ analysis: { ...widget.analysis!, drillFields: ["region"] } }).status).toBe("blocked");
  });
  it("rejects missing, tampered, nonfinite and empty sources without fabricated values", () => {
    expect(lowerDashboardChart({ nodeId: "x", revision: 1, widget }).status).toBe("blocked");
    const data = snapshot();
    expect(lower({}, { ...data, source: { ...data.source, contentSha256: "0".repeat(64) } }).status).toBe("blocked");
    expect(lower({}, { ...data, metric: { samples: [{ time: 0, value: Infinity }] } }).status).toBe("blocked");
    expect(lower({}, snapshot({ samples: [], rows: [] })).status).toBe("blocked");
  });
  it("preserves multiple grouped series and the shared zero fill for absent groups", () => {
    const result = lower({ type: "line", analysis: { ...widget.analysis!, seriesField: "machine" } }, snapshot({ samples: [],
      rows: [{ region: "A", machine: "甲", value: 4 }, { region: "B", machine: "乙", value: 9 }] }));
    expect(result.chart?.value.series.map(item => [item.type, item.label])).toEqual([["line", "甲"], ["line", "乙"]]);
    expect(result.chart?.value.datasets.map(item => item.rows)).toEqual([[["A", 4], ["B", 0]], [["A", 0], ["B", 9]]]);
  });
  it("keeps ChartSpec budgets and blocks overflowing aggregated values", () => {
    const many = lower({ analysis: { ...widget.analysis!, seriesField: "machine" } }, snapshot({ samples: [],
      rows: Array.from({ length: 33 }, (_, index) => ({ region: "A", machine: String(index), value: 1 })) }));
    expect(many.status).toBe("blocked");
    const overflow = lower({}, snapshot({ samples: [], rows: [{ region: "A", value: 1e308 }, { region: "A", value: 1e308 }] }));
    expect(overflow.chart).toBeUndefined();
    expect(lower({ analysis: { ...widget.analysis!, unknown: 1 } as never }).status).toBe("blocked");
  });
  it("produces a C1 composition resource accepted by the existing package validator", () => {
    const result = lower();
    const nodeId = `node.${"a".repeat(64)}`, pageId = `page.${"b".repeat(64)}`;
    const value = buildDashboardCompositionRuntimePackage({ packageId: "author-chart-test", packageVersion: "1.0.0",
      dashboard: { schema: "deep-engine.dashboard-runtime", schemaVersion: 1, id: "dashboard.test", revision: 1,
        documentId: "application.test", documentRevision: 1, entryPageId: pageId,
        pages: [{ id: pageId, width: 640, height: 360, nodes: [{ id: nodeId, revision: 1,
          frame: [0, 0, 640, 360], clip: null, zOrder: 0, visible: true, hitId: nodeId,
          deep2d: null, chart: result.chart!.id, chartSim: null }] }] },
      deep2d: [], charts: [{ schema: "deep-engine.chart-runtime", schemaVersion: 1, id: result.chart!.id, revision: result.chart!.revision, chart: result.chart!.value as unknown as RuntimeJson }], chartSims: [] });
    expect(validateDeepRuntimePackage(value).valid).toBe(true);
  });
});
