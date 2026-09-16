import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildChartRuntimePackage, parseDeepRuntimePackage, runtimePackageSha256, serializeDeepRuntimePackage } from "./index.js";

const chartIr = (): unknown => JSON.parse(readFileSync(new URL("../../fixtures/chart-ir-v1.json", import.meta.url), "utf8"));
const simFixture = (): unknown => JSON.parse(readFileSync(new URL("../../fixtures/chart-sim-v1.json", import.meta.url), "utf8"));
const dynamicGolden = (): Record<string, unknown> => JSON.parse(readFileSync(new URL("../../fixtures/chart-runtime-v1.json", import.meta.url), "utf8"));
const staticGolden = (): Record<string, unknown> => JSON.parse(readFileSync(new URL("../../fixtures/chart-runtime-static-v1.json", import.meta.url), "utf8"));

const build = (sim = false): ReturnType<typeof buildChartRuntimePackage> => buildChartRuntimePackage({
  packageId: "chart.main", packageVersion: "1.0.0",
  chart: { id: "chart.main.ir", revision: 1, value: chartIr() },
  ...(sim ? { chartSim: { id: "chart.main.sim", revision: 1, value: simFixture() } } : {}),
});

describe("standalone chart runtime package", () => {
  it("packages frozen ChartIR and replay fixture as versioned v4 payloads", () => {
    for (const [sim, golden] of [[true, dynamicGolden()], [false, staticGolden()] as const]) {
      const result = build(sim);
      expect(result).toEqual(golden);
      expect(result.schemaVersion).toBe(4);
      expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(result)).valid).toBe(true);
      expect(result.payloads[result.entrypoints.renderPacket]).toMatchObject({geometries: [], materials: [], instances: [], textures: []});
      expect(result.payloads[result.entrypoints.chart!]).toMatchObject({schema: "deep-engine.chart-runtime", schemaVersion: 1, id: "chart.main.ir", revision: 1});
      expect((result.payloads[result.entrypoints.chart!] as {chart: {id: string}}).chart.id).toBe("chart-v1-golden");
      if (sim) {
        expect(result.payloads[result.entrypoints.chartSim!]).toMatchObject({schema: "deep-engine.chart-sim-runtime", id: "chart.main.sim"});
      } else {
        expect(result.entrypoints.chartSim).toBeNull();
        expect("chartSim" in result.entrypoints).toBe(true);
      }
    }
  });
  it("keeps identity stable across revisions and isolates inputs", () => {
    const before = build(true);
    const chartIrValue = chartIr() as {id: string};
    const after = buildChartRuntimePackage({packageId: "chart.main", packageVersion: "1.0.0",
      chart: {id: "chart.main.ir", revision: 2, value: chartIrValue}});
    expect(after.entrypoints.renderPacket).toBe(before.entrypoints.renderPacket);
    expect(after.packageHash).not.toEqual(before.packageHash);
    const original = serializeDeepRuntimePackage(before);
    (chartIrValue as {id: string}).id = "mutated";
    expect(serializeDeepRuntimePackage(before)).toBe(original);
    expect(build(true)).toEqual(before);
  });
  it("enforces the v4 entrypoint contract", () => {
    const golden = dynamicGolden();
    const invalid = (mutate: (value: Record<string, unknown>) => void): boolean => {
      const value = structuredClone(golden);
      mutate(value);
      return !parseDeepRuntimePackage(JSON.stringify(value)).valid;
    };
    // chart 入口缺失/为空、chartSim 孤立、键被删除、版本降级均拒绝。
    expect(invalid(v => { (v.entrypoints as {chart: unknown}).chart = null; })).toBe(true);
    expect(invalid(v => { delete (v.entrypoints as {chart?: string}).chart; })).toBe(true);
    expect(invalid(v => { delete (v.entrypoints as {chartSim?: unknown}).chartSim; })).toBe(true);
    expect(invalid(v => { (v.entrypoints as {chartSim: unknown}).chartSim = null; })).toBe(true);
    expect(invalid(v => { v.schemaVersion = 3; })).toBe(true);
    expect(invalid(v => { v.schemaVersion = 2; })).toBe(true);
    // 静态包(无 sim)是合法 v4;chart 与 deep2d 入口互斥,组合必须拒绝。
    expect(parseDeepRuntimePackage(JSON.stringify(staticGolden())).valid).toBe(true);
    expect(invalid(v => {
      const dashboard = JSON.parse(readFileSync(new URL("../../fixtures/dashboard-runtime-v1.json", import.meta.url), "utf8"));
      const deep2dId = dashboard.entrypoints.deep2d as string;
      (v.entrypoints as {deep2d: string | null}).deep2d = deep2dId;
      const resources = v.resources as {id: string; contentHash: unknown; [key: string]: unknown}[];
      const entry = dashboard.resources.find((r: {id: string}) => r.id === deep2dId);
      resources.push(entry);
      resources.sort((a, b) => a.id < b.id ? -1 : 1);
      (v.payloads as Record<string, unknown>)[deep2dId] = dashboard.payloads[deep2dId];
      const {packageHash: _ignored, ...core} = v;
      v.packageHash = {algorithm: "sha256", value: runtimePackageSha256(core)};
    })).toBe(true);
  });
});
