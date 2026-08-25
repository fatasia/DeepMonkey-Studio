import { describe, expect, it } from "vitest";
import { SceneBehaviorScheduler, normalizeSceneBehaviorRuntimeSettings } from "./behaviorScheduler.js";

describe("SceneBehaviorScheduler", () => {
  it("emits update and deterministic fixed-step ticks", () => {
    const scheduler = new SceneBehaviorScheduler({ fixedStepMs: 20, maxFixedStepsPerFrame: 4 });

    expect(scheduler.advance(10).map((tick) => [tick.lifecycle, tick.deltaMs])).toEqual([["onUpdate", 10]]);
    expect(scheduler.advance(15).map((tick) => [tick.lifecycle, tick.deltaMs])).toEqual([
      ["onUpdate", 15],
      ["onFixedUpdate", 20]
    ]);
    expect(scheduler.diagnostics()).toMatchObject({ elapsedMs: 25, fixedElapsedMs: 20, frame: 2, sequence: 3, pendingFixedMs: 5, droppedFixedSteps: 0 });
    expect(scheduler.advance(15).map((tick) => [tick.lifecycle, tick.elapsedMs])).toEqual([
      ["onUpdate", 40],
      ["onFixedUpdate", 40]
    ]);
  });

  it("caps catch-up work and reports dropped fixed steps", () => {
    const scheduler = new SceneBehaviorScheduler({ fixedStepMs: 10, maxFixedStepsPerFrame: 3 });
    const ticks = scheduler.advance(100);

    expect(ticks.filter((tick) => tick.lifecycle === "onFixedUpdate")).toHaveLength(3);
    expect(scheduler.diagnostics()).toMatchObject({ fixedElapsedMs: 100, droppedFixedSteps: 7, pendingFixedMs: 0 });
  });

  it("supports pause, time scale, reset, and terminal disposal", () => {
    const scheduler = new SceneBehaviorScheduler({ fixedStepMs: 10, timeScale: 2 });
    scheduler.pause();
    expect(scheduler.advance(20)).toEqual([]);
    scheduler.resume();
    expect(scheduler.advance(5).map((tick) => tick.deltaMs)).toEqual([10, 10]);
    scheduler.configure({ timeScale: 0.5, updateEnabled: false });
    expect(scheduler.advance(20).map((tick) => tick.lifecycle)).toEqual(["onFixedUpdate"]);
    scheduler.reset();
    expect(scheduler.diagnostics()).toMatchObject({ elapsedMs: 0, fixedElapsedMs: 0, frame: 0, sequence: 0, droppedFixedSteps: 0 });
    scheduler.dispose();
    scheduler.resume();
    expect(scheduler.advance(20)).toEqual([]);
    expect(scheduler.diagnostics().state).toBe("disposed");
  });

  it("normalizes hostile timing settings and clamps frame spikes", () => {
    expect(normalizeSceneBehaviorRuntimeSettings({ fixedStepMs: Number.NaN, maxFixedStepsPerFrame: 0, timeScale: Infinity })).toEqual({
      fixedStepMs: 1000 / 60,
      maxFixedStepsPerFrame: 1,
      timeScale: 1,
      updateEnabled: true
    });
    const scheduler = new SceneBehaviorScheduler({ fixedStepMs: 100, maxFixedStepsPerFrame: 10 });
    scheduler.advance(10_000);
    expect(scheduler.diagnostics()).toMatchObject({ elapsedMs: 250, droppedFixedSteps: 0, pendingFixedMs: 50 });
  });
});
