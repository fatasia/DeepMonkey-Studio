import { describe, expect, it } from "vitest";
import {
  RUNTIME_DECODE_STAGES,
  RuntimeDecodeTelemetryWindow,
  RuntimeDecodeTrace,
  type RuntimeDecodeOutcome,
  type RuntimeDecodeTelemetrySample,
} from "./runtimeDecodeTelemetry.js";

const sample = (duration: number, outcome: RuntimeDecodeOutcome = "success"): RuntimeDecodeTelemetrySample => ({
  invocation: "gltf", outcome, decodedBytes: duration * 10,
  stagesMs: { parse: duration, deformation: duration, texturedImageDecode: duration,
    projection: duration, total: duration },
  ...(outcome === "success" ? {} : { error: { name: "Error", message: outcome } }),
});

describe("runtime decode telemetry", () => {
  it("preserves cold-first and reports deterministic warm P50/P95/P99 in fixed storage", () => {
    const window = new RuntimeDecodeTelemetryWindow(4);
    window.record(sample(100));
    window.record(sample(4)); window.record(sample(1)); window.record(sample(3)); window.record(sample(2));
    const snapshot = window.snapshot();
    expect(snapshot).toMatchObject({ capacity: 4, totalSamples: 5, retainedSamples: 4,
      coldFirst: { decodedBytes: 1000 }, outcomes: { success: 5, aborted: 0, failure: 0 },
      warm: { successfulSamples: 3, decodedBytes: { p50: 20, p95: 30, p99: 30 } } });
    for (const stage of RUNTIME_DECODE_STAGES) {
      expect(snapshot.warm.stagesMs[stage]).toEqual({ p50: 2, p95: 3, p99: 3 });
    }
  });

  it("counts all outcomes but excludes failed and aborted attempts from warm latency", () => {
    const window = new RuntimeDecodeTelemetryWindow(5);
    window.record(sample(9, "failure")); window.record(sample(8, "aborted")); window.record(sample(2));
    expect(window.snapshot()).toMatchObject({ totalSamples: 3,
      outcomes: { success: 1, aborted: 1, failure: 1 }, warm: { successfulSamples: 1,
        stagesMs: { total: { p50: 2, p95: 2, p99: 2 } } } });
  });

  it("rejects a decreasing injected clock before publishing misleading evidence", () => {
    const values = [2, 3, 1], records: RuntimeDecodeTelemetrySample[] = [];
    const trace = new RuntimeDecodeTrace({ clock: { now: () => values.shift()! },
      recorder: { record: value => records.push(value) } }, "gltf");
    expect(() => trace.measure("parse", () => undefined)).toThrow("monotonic");
    expect(records).toEqual([]);
  });
});
