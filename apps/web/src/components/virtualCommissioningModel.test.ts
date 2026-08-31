import { describe, expect, it } from "vitest";
import { buildVirtualDebugGoldenSuite, buildVirtualDebugScenario, parseSignalValue, virtualDebugFrameAt } from "./virtualCommissioningModel";

describe("virtual commissioning workbench model", () => {
  it("builds a deterministic acceptance scenario", () => {
    const scenario = buildVirtualDebugScenario({
      scenarioId: "line-1",
      durationMs: 1_000,
      tickMs: 50,
      faultEnabled: true,
      faultAtMs: 500,
      resetEnabled: true,
      resetAtMs: 800,
      speedSetpoint: 1_200,
      acceptanceAtMs: 800,
      acceptanceSignal: "alarm",
      acceptanceValue: false,
      bindings: []
    });
    expect(scenario.commands).toEqual(expect.arrayContaining([{ atMs: 800, type: "reset" }]));
    expect(scenario.assertions?.at(-1)).toMatchObject({ atMs: 800, signal: "alarm", value: false });
  });

  it("rejects times that cannot produce a deterministic frame", () => {
    expect(() => buildVirtualDebugScenario({
      scenarioId: "line-1", durationMs: 1_000, tickMs: 50, faultEnabled: true, faultAtMs: 525,
      resetEnabled: false, resetAtMs: 800, speedSetpoint: 1_200, acceptanceAtMs: 800,
      acceptanceSignal: "alarm", acceptanceValue: false, bindings: []
    })).toThrow("采样周期对齐");
  });

  it("parses typed signal values and selects the nearest trace frame", () => {
    expect(parseSignalValue("false")).toBe(false);
    expect(parseSignalValue("12.5")).toBe(12.5);
    expect(virtualDebugFrameAt({ status: "passed", scenarioId: "s", tickMs: 50, durationMs: 100, bindings: [], failures: [], evidenceFingerprint: "x", trace: [
      { atMs: 0, state: "idle", signals: {}, events: [] },
      { atMs: 50, state: "running", signals: {}, events: [] }
    ] }, 75)?.atMs).toBe(50);
  });

  it("builds a compact golden matrix with an explicit negative test", () => {
    const suite = buildVirtualDebugGoldenSuite({
      suiteId: "line-1-golden-suite",
      durationMs: 1_000,
      tickMs: 50,
      speedSetpoint: 1_200,
      bindings: [],
    });
    expect(suite.cases).toHaveLength(4);
    expect(suite.cases.map((item) => item.expectedStatus)).toEqual(["passed", "passed", "passed", "failed"]);
    expect(suite.cases[2]?.scenario.commands).toContainEqual({ atMs: 700, type: "reset" });
  });

  it("rejects a golden matrix that cannot place fault and reset frames", () => {
    expect(() => buildVirtualDebugGoldenSuite({
      suiteId: "short",
      durationMs: 100,
      tickMs: 50,
      speedSetpoint: 1,
      bindings: [],
    })).toThrow("至少需要 4 个采样周期");
  });
});
