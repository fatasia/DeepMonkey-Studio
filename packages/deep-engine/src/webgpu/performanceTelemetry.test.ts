import { describe, expect, it } from "vitest";
import { EnginePerformanceTelemetry } from "./performanceTelemetry.js";

describe("EnginePerformanceTelemetry", () => {
  it("merges late GPU samples and reports nearest-rank quantiles with coverage", () => {
    const telemetry = new EnginePerformanceTelemetry(16, true);
    for (let frame = 1; frame <= 20; frame++) {
      telemetry.record({ frame, timings: { "frame-encode": frame, "queue-submit": frame / 10 } });
      if (frame % 2 === 0) telemetry.recordStage(frame, "gpu-frame", frame * 2);
    }

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({ capacity: 16, retainedFrameCount: 16, firstFrame: 5, lastFrame: 20 });
    expect(snapshot.stages["frame-encode"]).toMatchObject({
      samples: 16, coverage: 1, minimumMs: 5, p50Ms: 12, p95Ms: 20, p99Ms: 20, maximumMs: 20,
    });
    expect(snapshot.stages["gpu-frame"]).toMatchObject({
      samples: 8, coverage: 0.5, minimumMs: 12, p50Ms: 24, p95Ms: 40, p99Ms: 40, maximumMs: 40,
    });
  });

  it("accepts identical retries but rejects conflicting, unknown and stale samples", () => {
    const telemetry = new EnginePerformanceTelemetry(16, true);
    telemetry.recordStage(1, "asset-parse", 2.5);
    telemetry.recordStage(1, "asset-parse", 2.5);
    expect(() => telemetry.recordStage(1, "asset-parse", 3)).toThrow("already recorded");
    expect(() => telemetry.record({ frame: 1,
      timings: { "cold-start": 1, "asset-parse": 3 } })).toThrow("already recorded");
    expect(telemetry.snapshot().stages["cold-start"]).toBeUndefined();
    expect(() => telemetry.record({ frame: 2, timings: { other: 1 } as never })).toThrow("Unknown");
    expect(() => telemetry.record({ frame: 2, timings: {} })).toThrow("at least one");
    for (let frame = 2; frame <= 17; frame++) telemetry.recordStage(frame, "frame-encode", 1);
    expect(() => telemetry.recordStage(1, "gpu-frame", 1)).toThrow("evicted");
  });

  it("validates budgets and values and resets the observation epoch", () => {
    expect(() => new EnginePerformanceTelemetry(15)).toThrow("capacity");
    const telemetry = new EnginePerformanceTelemetry(16, true);
    expect(() => telemetry.recordStage(-1, "gpu-frame", 1)).toThrow("frame");
    expect(() => telemetry.recordStage(1, "gpu-frame", Number.NaN)).toThrow("finite");
    telemetry.recordStage(3, "cold-start", 10);
    telemetry.reset();
    expect(telemetry.snapshot()).toMatchObject({ retainedFrameCount: 0, firstFrame: null, lastFrame: null });
    expect(() => telemetry.recordStage(3, "gpu-frame", 1)).toThrow("evicted");
    telemetry.recordStage(4, "cold-start", 8);
    expect(telemetry.snapshot().stages["cold-start"]?.meanMs).toBe(8);
  });

  it("does no validation or allocation while diagnostics are disabled", () => {
    const telemetry = new EnginePerformanceTelemetry(16);
    telemetry.recordStage(-1, "gpu-frame", Number.NaN);
    expect(telemetry.snapshot().retainedFrameCount).toBe(0);
    telemetry.enabled = true;
    telemetry.recordStage(1, "gpu-frame", 0.5);
    expect(telemetry.snapshot().retainedFrameCount).toBe(1);
  });
});
