import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChartSimulationSource } from "./chartSimulation.js";
import { applyChartDataUpdate } from "./chartDataApply.js";
import type { ChartIR } from "./chartIr.js";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const chart = () => read("chart-ir-v1.json") as ChartIR;
const fixture = () => read("chart-sim-v1.json");

describe("offline chart simulation", () => {
  it("replays the Native-shared messages and complete source golden", () => {
    const golden = read("chart-sim-replay-v1.json");
    let current = { ir: golden.source as ChartIR, dataRevision: 0 };
    const sim = new ChartSimulationSource(golden.fixture, current.ir);
    for (const step of golden.steps) {
      const frame = sim.prepare(step.elapsedMs, current.dataRevision)!;
      expect(frame.message).toEqual(step.message);
      expect(frame.capturedAtMs).toBe(step.capturedAtMs);
      current = applyChartDataUpdate(current.ir, current.dataRevision, frame.message);
      sim.commit(frame, current.dataRevision);
      expect(current).toEqual(step.expected);
    }
  });
  it("plays seeded fixed-clock rows and commits bounded windows", () => {
    let current = { ir: chart(), dataRevision: 0 };
    const sim = new ChartSimulationSource(fixture(), current.ir);
    for (const [tick, name] of ["D", "E", "C", "D"].entries()) {
      if (tick) expect(sim.prepare(tick * 100 - 1, current.dataRevision)).toBeUndefined();
      const frame = sim.prepare(tick * 100, current.dataRevision)!;
      expect(frame.capturedAtMs).toBe(1767225600000 + tick * 100);
      current = applyChartDataUpdate(current.ir, current.dataRevision, frame.message);
      sim.commit(frame, current.dataRevision);
      expect(current.ir.datasets[0]!.rows).toHaveLength(3);
      expect(current.ir.datasets[0]!.rows[2]![0]).toBe(name);
    }
  });
  it("retries identical frames on rejected GPU candidates", () => {
    const sim = new ChartSimulationSource(fixture(), chart());
    const first = sim.prepare(0, 0)!;
    expect(() => sim.commit(first, 0)).toThrow();
    expect(sim.prepare(10000, 0)).toEqual(first);
    expect(sim.nextDueMs).toBe(0);
  });
  it("rejects foreign, duplicate, forged and cancelled frames", () => {
    const sim = new ChartSimulationSource(fixture(), chart());
    const other = new ChartSimulationSource(fixture(), chart());
    const frame = sim.prepare(0, 0)!;
    expect(() => other.commit(frame, 1)).toThrow();
    expect(() => sim.commit(structuredClone(frame), 1)).toThrow();
    const duplicate = sim.prepare(0, 0)!;
    sim.commit(frame, 1);
    expect(() => sim.commit(duplicate, 1)).toThrow();
    const late = sim.prepare(100, 1)!;
    sim.cancel();
    expect(() => sim.commit(late, 2)).toThrow();
    expect(sim.prepare(Infinity, 1)).toBeUndefined();
  });
  it("snapshots fixture input and protects outgoing messages", () => {
    const input = fixture(); const sim = new ChartSimulationSource(input, chart());
    input.rows[1][0] = "mutated";
    const frame = sim.prepare(0, 0)!;
    expect(frame.message.datasets[0]!.rows[0]![0]).toBe("D");
    expect(Object.isFrozen(frame.message.datasets[0]!.rows[0])).toBe(true);
    expect(Object.isFrozen(frame.message)).toBe(true);
  });
  it.each([
    { schemaVersion: 2 }, { id: "__proto__" }, { chartId: "other" }, { datasetId: "other" },
    { intervalMs: 0 }, { intervalMs: 86400001 }, { seed: 0x100000000 }, { seed: 1.5 },
    { maxRows: 0 }, { dimensions: ["bad"] }, { rows: [] }, { unknown: true },
    { startTimeMs: Number.MAX_SAFE_INTEGER + 1 }, { rows: [[{ bad: true }]], maxRows: 1 },
  ])("rejects fixture contract errors: %j", patch => {
    expect(() => new ChartSimulationSource({ ...fixture(), ...patch }, chart())).toThrow();
  });
  it("rejects oversized, malformed and exhausted clock inputs", () => {
    expect(() => ChartSimulationSource.fromJson(" ".repeat(16 * 1024 * 1024 + 1), chart())).toThrow();
    expect(() => ChartSimulationSource.fromJson("bad", chart())).toThrow();
    const sim = new ChartSimulationSource({ ...fixture(), startTimeMs: Number.MAX_SAFE_INTEGER }, chart());
    expect(() => sim.prepare(-1, 0)).toThrow();
    expect(() => sim.prepare(0, Number.MAX_SAFE_INTEGER)).toThrow();
    sim.commit(sim.prepare(0, 0)!, 1);
    expect(() => sim.prepare(100, 1)).toThrow();
    expect(sim.nextDueMs).toBe(100);
  });
});
