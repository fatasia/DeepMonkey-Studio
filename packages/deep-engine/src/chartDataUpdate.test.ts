import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyChartDataUpdate } from "./chartDataApply.js";
import { parseChartDataUpdate, validateChartDataUpdate } from "./chartDataUpdate.js";
import type { ChartIR } from "./chartIr.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/chart-data-update-v1.json", import.meta.url), "utf8"));
const message = () => structuredClone(fixture.steps[0].message);

describe("versioned chart data messages", () => {
  it("replays the shared Native message/source golden", () => {
    let current = { ir: fixture.source as ChartIR, dataRevision: 0 };
    for (const step of fixture.steps) {
      const checked = parseChartDataUpdate(JSON.stringify(step.message));
      expect(checked.ok).toBe(true);
      current = applyChartDataUpdate(current.ir, current.dataRevision, checked.message);
      expect(current).toEqual(step.expected);
    }
    expect(fixture.source.datasets[0].rows).toHaveLength(2);
  });
  it.each([
    { schemaVersion: 2 }, { chartId: "__proto__" }, { dataRevision: 2 }, { dataRevision: 9007199254740992 },
    { expectedDataRevision: -1 }, { unexpected: true }, { datasets: [] },
  ])("rejects invalid headers: %j", patch => expect(validateChartDataUpdate({ ...message(), ...patch }).ok).toBe(false));
  it.each([
    { kind: "unknown" }, { maxRows: 0 }, { maxRows: 1.5 }, { maxRows: 500001 }, { unknown: 1 },
    { rows: [[{ invalid: true }]] }, { rows: [["😀".repeat(2049)]] }, { rows: [new Array(65).fill(1)] },
  ])("rejects invalid row operations: %j", patch => {
    const value = message(); Object.assign(value.datasets[0], patch);
    expect(validateChartDataUpdate(value).ok).toBe(false);
  });
  it("rejects repeated datasets, non-JSON inputs and oversized byte messages", () => {
    const value = message(); value.datasets.push(structuredClone(value.datasets[0]));
    expect(validateChartDataUpdate(value).ok).toBe(false);
    expect(validateChartDataUpdate({ ...message(), function: () => 1 }).ok).toBe(false);
    expect(parseChartDataUpdate("x").ok).toBe(false);
    expect(parseChartDataUpdate(" ".repeat(16 * 1024 * 1024 + 1)).ok).toBe(false);
  });
  it("resolves ownership and dimensions at apply, retaining the active source on failure", () => {
    const before = JSON.stringify(fixture.source);
    expect(() => applyChartDataUpdate(fixture.source, 9, message())).toThrow("revision");
    const wrong = message(); wrong.chartId = "other";
    expect(() => applyChartDataUpdate(fixture.source, 0, wrong)).toThrow("source");
    const narrow = message(); narrow.datasets[0].rows = [[1]];
    expect(() => applyChartDataUpdate(fixture.source, 0, narrow)).toThrow("width");
    expect(JSON.stringify(fixture.source)).toBe(before);
  });
  it("accepts integral JSON number spellings and snapshots caller-owned data", () => {
    const value = message(); const result = parseChartDataUpdate(JSON.stringify(value).replace('"dataRevision":1', '"dataRevision":1.0'));
    expect(result.ok).toBe(true);
    value.datasets[0].rows[0][0] = "changed";
    expect(result.message!.datasets[0]!.rows[0]![0]).toBe("C");
  });
});
