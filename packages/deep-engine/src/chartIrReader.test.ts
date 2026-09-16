import { describe, expect, it } from "vitest";
import { compileChartSpec } from "./chartIr.js";
import { parseChartIR, validateChartIR } from "./chartIrReader.js";
import { readFileSync } from "node:fs";

function fixture() {
  const result = compileChartSpec({ schemaVersion: 1, id: "temperatures",
    datasets: [{ id: "data", dimensions: ["time", "value"], rows: [[0, 20], [1, 25]] }],
    axes: [{ id: "x", channel: "x", scale: "linear" }, { id: "y", channel: "y", scale: "linear" }],
    series: [{ id: "line", label: "温度", type: "line", datasetId: "data", x: "time", y: "value", xAxisId: "x", yAxisId: "y" }],
    legend: { visible: false, position: "right" }, tooltip: { enabled: true, trigger: "axis" },
    dataZoom: [{ id: "window", axisId: "x", start: 10, end: 90, mode: "slider" }],
    actions: [{ type: "select", seriesId: "line", dataIndex: 1 }] });
  if (!result.ir) throw new Error("fixture failed to compile");
  return JSON.parse(JSON.stringify(result.ir));
}

describe("ChartIR v1 runtime reader", () => {
  it("rejects the shared Native negative corpus from valid baselines", () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
    for (const item of read("chart-ir-v1-invalid")) {
      const source = read("chart-ir-v1");
      if (item.seriesOnly !== undefined) { source.series = [source.series[item.seriesOnly]]; source.actions = []; }
      if (item.logY) source.axes[1].scale = "log";
      expect(validateChartIR(source).ok, `${item.name} baseline`).toBe(true);
      const keys = item.pointer.slice(1).split("/");
      const parent = keys.slice(0, -1).reduce((value: any, key: string) => value[key], source);
      parent[keys.at(-1)!] = item.value;
      expect(validateChartIR(source).ok, item.name).toBe(false);
    }
  });
  it("matches the shared six-series Native wire golden", () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
    const golden = read("chart-ir-v1");
    expect(compileChartSpec(read("chart-spec-v1")).ir).toEqual(golden);
    expect(validateChartIR(golden)).toEqual({ ok: true, diagnostics: [], ir: golden });
  });
  it("preserves the complete compiled structure through JSON", () => {
    const source = fixture();
    expect(parseChartIR(JSON.stringify(source))).toEqual({ ok: true, diagnostics: [], ir: source });
  });
  it("takes ownership of dataset, series and interaction snapshots", () => {
    const source = fixture(), result = validateChartIR(source), expected = fixture();
    source.datasets[0].rows[0][1] = 100;
    source.series[0].label = "changed";
    source.dataZoom[0].start = 30;
    source.actions[0].dataIndex = 0;
    expect(result.ir).toEqual(expected);
  });
  it.each(["schemaVersion", "sourceSpecVersion", "id", "datasets", "axes", "series", "legend", "tooltip", "dataZoom", "actions"])("requires compiled root field %s", field => {
    const source = fixture(); delete source[field];
    expect(validateChartIR(source).ok).toBe(false);
  });
  it("rejects version drift, unknown fields and author-side omitted defaults", () => {
    const mutations = [
      (v: ReturnType<typeof fixture>) => { v.sourceSpecVersion = 2; },
      (v: ReturnType<typeof fixture>) => { v.schemaVersion = 2; },
      (v: ReturnType<typeof fixture>) => { v.extra = true; },
      (v: ReturnType<typeof fixture>) => { delete v.axes[0].min; },
      (v: ReturnType<typeof fixture>) => { delete v.legend.visible; },
      (v: ReturnType<typeof fixture>) => { delete v.tooltip.trigger; },
    ];
    for (const mutate of mutations) { const source = fixture(); mutate(source); expect(validateChartIR(source).ok).toBe(false); }
  });
  it.each(["datasets", "axes", "series", "dataZoom", "actions"])("rejects null compiled collection %s", field => {
    const source = fixture(); source[field] = null;
    expect(validateChartIR(source).ok).toBe(false);
  });
  it("reuses reference, numeric scale and interaction validation", () => {
    const source = fixture(); source.actions[0].dataIndex = 2;
    expect(validateChartIR(source).ok).toBe(false);
    source.actions = []; source.series[0].xAxisId = "missing";
    expect(validateChartIR(source).ok).toBe(false);
    source.series[0].xAxisId = "x"; source.datasets[0].rows[0][0] = "not numeric";
    expect(validateChartIR(source).ok).toBe(false);
  });
  it("rejects malformed JSON and non-JSON objects before snapshotting", () => {
    expect(parseChartIR("{").ok).toBe(false);
    const source = fixture(); source.datasets[0].rows[0][1] = NaN;
    expect(validateChartIR(source).ok).toBe(false);
    let reads = 0;
    Object.defineProperty(source, "id", { get() { reads++; return "hidden"; }, enumerable: true });
    expect(validateChartIR(source).ok).toBe(false);
    expect(reads).toBe(0);
  });
});
