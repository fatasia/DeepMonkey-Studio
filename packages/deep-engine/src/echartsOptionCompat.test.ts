import { describe, expect, it } from "vitest";
import { compileEChartsOption } from "./echartsOptionCompat.js";

describe("ECharts option compatibility compiler", () => {
  it("converts the six first-wave direct-data series without ECharts runtime", () => {
    const result = compileEChartsOption({
      id: "all-series",
      xAxis: { type: "category" }, yAxis: { type: "value" },
      series: [
        { id: "line", type: "line", data: [2, 4, 8] },
        { id: "bar", type: "bar", data: [["A", 3], ["B", 5]] },
        { id: "scatter", type: "scatter", data: [[1, 2], [3, 4]] },
        { id: "pie", type: "pie", data: [{ name: "OK", value: 7 }] },
        { id: "heat", type: "heatmap", data: [["A", 1, 0.5]] },
        { id: "gauge", type: "gauge", min: 0, max: 10, data: [{ name: "Load", value: 6 }] },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.series.map((series) => series.type)).toEqual(["line", "bar", "scatter", "pie", "heatmap", "gauge"]);
    expect(result.ir?.datasets).toHaveLength(6);
    expect(result.ir?.series[0]?.label).toBe("line");
  });

  it("maps dataset encode, axes, legend, tooltip, zoom and dispatch actions", () => {
    const result = compileEChartsOption({
      dataset: { id: "measurements", dimensions: ["time", "pressure"], source: [[0, 1.2], [1, 1.4]] },
      xAxis: { id: "time-axis", type: "time", min: 0, max: 10 },
      yAxis: { id: "pressure-axis", type: "value" },
      series: { id: "pressure", type: "line", datasetIndex: 0, encode: { x: "time", y: 1 } },
      legend: { show: false, left: "right" }, tooltip: { show: true, trigger: "axis" },
      dataZoom: { id: "time-window", type: "inside", xAxisIndex: 0, start: 20, end: 80 },
    }, [
      { type: "highlight", seriesId: "pressure", dataIndex: 1 },
      { type: "dataZoom", xAxisIndex: 0, start: 30, end: 70 },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toMatchObject({
      legend: { visible: false, position: "right" }, tooltip: { enabled: true, trigger: "axis" },
      dataZoom: [{ id: "time-window", axisId: "time-axis", start: 20, end: 80, mode: "inside" }],
      actions: [{ type: "highlight", seriesId: "pressure", dataIndex: 1 }, { type: "dataZoom", axisId: "time-axis", start: 30, end: 70 }],
    });
  });

  it("reports unknown fields and formatters instead of silently dropping them", () => {
    const result = compileEChartsOption({
      animation: true,
      xAxis: {}, yAxis: {},
      tooltip: { formatter: "{b}: {c}" },
      series: [{ type: "bar", data: [1], itemStyle: { color: "red" } }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported", path: "$.animation" }),
      expect.objectContaining({ code: "unsupported", path: "$.tooltip.formatter" }),
      expect.objectContaining({ code: "unsupported", path: "$.series[0].itemStyle" }),
    ]));
  });

  it("rejects JavaScript formatters before executing or reading them", () => {
    let executed = false;
    const result = compileEChartsOption({
      xAxis: {}, yAxis: {}, series: [{ type: "line", data: [1] }],
      tooltip: { formatter: () => { executed = true; return "unsafe"; } },
    });
    expect(result.ok).toBe(false); expect(executed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported", path: "$.tooltip.formatter" }));
  });

  it("rejects ambiguous dataset mixing and invalid dispatch targets", () => {
    const result = compileEChartsOption({
      dataset: { dimensions: ["x", "y"], source: [[0, 1]] }, xAxis: {}, yAxis: {},
      series: [{ type: "line", data: [1], datasetIndex: 0, encode: { x: "x", y: "y" } }],
    }, [{ type: "highlight", seriesIndex: 99, dataIndex: 0 }]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("cannot mix"))).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes("target is invalid"))).toBe(true);
  });

  it("rejects invalid axis indices and gauge bounds instead of applying defaults", () => {
    const result = compileEChartsOption({
      xAxis: {}, yAxis: {},
      series: [{ type: "line", xAxisIndex: "0", data: [1] }, { type: "gauge", min: "0", data: [{ name: "Load", value: 1 }] }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported", path: "$.series[0].xAxisIndex" }),
      expect.objectContaining({ code: "unsupported", path: "$.series[1].min" }),
    ]));
  });

  it("rejects unsupported series and sparse option arrays defensively", () => {
    const sparse = new Array(2); sparse[1] = { type: "line", data: [1] };
    expect(compileEChartsOption({ series: [{ type: "candlestick", data: [] }] }).diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported", path: "$.series[0]" }));
    expect(compileEChartsOption({ series: sparse }).ok).toBe(false);
  });
});
