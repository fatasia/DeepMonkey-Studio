import { describe, expect, it } from "vitest";
import { CHART_BUDGETS, CHART_IR_SCHEMA_VERSION, CHART_SPEC_SCHEMA_VERSION, compileChartSpec, validateChartJson } from "./chartIr.js";

const complete = () => ({
  schemaVersion: CHART_SPEC_SCHEMA_VERSION,
  id: "plant-overview",
  datasets: [{ id: "main", dimensions: ["x", "y", "value", "name"], rows: [["A", 1, 0.2, "Pump"], ["B", 2, 0.8, "Tank"]] }],
  axes: [{ id: "x", channel: "x", scale: "category" }, { id: "y", channel: "y", scale: "linear", min: 0, max: 10 }],
  series: [
    { id: "line", label: "Line", type: "line", datasetId: "main", x: "x", y: "y", xAxisId: "x", yAxisId: "y" },
    { id: "bar", label: "Bar", type: "bar", datasetId: "main", x: "x", y: "y", xAxisId: "x", yAxisId: "y" },
    { id: "scatter", label: "Scatter", type: "scatter", datasetId: "main", x: "x", y: "y", xAxisId: "x", yAxisId: "y" },
    { id: "pie", label: "Pie", type: "pie", datasetId: "main", name: "name", value: "value" },
    { id: "heat", label: "Heat", type: "heatmap", datasetId: "main", x: "x", y: "y", value: "value", xAxisId: "x", yAxisId: "y" },
    { id: "gauge", label: "Gauge", type: "gauge", datasetId: "main", name: "name", value: "value", min: 0, max: 1 },
  ],
  dataZoom: [{ id: "zoom", axisId: "x", start: 10, end: 90, mode: "inside" }],
  actions: [
    { type: "highlight", seriesId: "bar", dataIndex: 1 },
    { type: "dataZoom", axisId: "x", start: 20, end: 80 },
  ],
});

describe("ChartSpec v1 compiler", () => {
  it("normalizes all first-wave series and interaction defaults", () => {
    const result = compileChartSpec(complete());
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toMatchObject({
      schemaVersion: CHART_IR_SCHEMA_VERSION,
      sourceSpecVersion: CHART_SPEC_SCHEMA_VERSION,
      legend: { visible: true, position: "top" },
      tooltip: { enabled: true, trigger: "item" },
    });
    expect(result.ir?.series.map((series) => series.type)).toEqual(["line", "bar", "scatter", "pie", "heatmap", "gauge"]);
    expect(result.ir?.dataZoom[0]).toEqual({ id: "zoom", axisId: "x", start: 10, end: 90, mode: "inside" });
  });

  it("rejects unknown fields, duplicate ids and missing dataset/dimension/axis references", () => {
    const input = complete() as Record<string, unknown>;
    input.legacyRenderer = "canvas";
    const series = input.series as Array<Record<string, unknown>>;
    series[1] = { ...series[1], id: "line", datasetId: "missing", xAxisId: "y", extra: true };
    const result = compileChartSpec(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["unknown-field", "duplicate-id", "missing-reference"]));
    expect(result.diagnostics.some((d) => d.path === "$.legacyRenderer")).toBe(true);
  });

  it("validates scales, extents, zoom windows and action targets", () => {
    const input = complete();
    input.axes[1] = { ...input.axes[1], scale: "linear", min: 5, max: 5 };
    input.dataZoom[0] = { ...input.dataZoom[0], start: 100, end: 10 };
    input.actions[0] = { type: "highlight", seriesId: "missing", dataIndex: -1 };
    const result = compileChartSpec(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter((d) => d.code === "invalid-value").length).toBeGreaterThanOrEqual(3);
  });

  it("enforces declared collection budgets before iterating entries", () => {
    const input = complete();
    input.series = Array.from({ length: CHART_BUDGETS.series + 1 }, (_, index) => ({ ...input.series[0], id: `s-${index}` }));
    const result = compileChartSpec(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "budget-exceeded", path: "$.series" }));
  });
});

describe("strict chart JSON", () => {
  it("rejects functions, NaN, sparse arrays, accessors and class instances", () => {
    const sparse = new Array(2); sparse[1] = 1;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    for (const value of [() => 1, Number.NaN, sparse, accessor, new Date()]) {
      expect(validateChartJson(value).length).toBeGreaterThan(0);
    }
    const decorated: unknown[] = []; Object.defineProperty(decorated, "extra", { enumerable: true, value: 1 });
    expect(validateChartJson(decorated)).toContainEqual(expect.objectContaining({ code: "invalid-json" }));
  });

  it("bounds recursive and oversized string inputs without throwing", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(validateChartJson(cyclic)).toContainEqual(expect.objectContaining({ code: "budget-exceeded" }));
    expect(validateChartJson("x".repeat(CHART_BUDGETS.stringCodeUnits + 1))).toContainEqual(expect.objectContaining({ code: "budget-exceeded" }));
  });
});
