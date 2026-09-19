import { describe, expect, it } from "vitest";
import { channelMedianMs, createSampleWindow, validateSampleWindow, type SampleWindow } from "./benchmarkSampleSchema";

function window(): SampleWindow {
  return {
    schema: "deep-engine.benchmark-sample-window",
    schemaVersion: 1,
    runId: "run.factory-draw.001",
    clockId: "performance-now",
    windowStartMs: 1000,
    windowEndMs: 6000,
    channels: [
      { channel: "cpu-submit", clockId: "performance-now", samplesMs: [2, 4, 3], sampleCount: 3,
        windowStartMs: 1000, windowEndMs: 6000, availability: "measured" },
      { channel: "gpu-timestamp", clockId: "gpu-timestamp", samplesMs: [], sampleCount: 0,
        windowStartMs: 1000, windowEndMs: 6000, availability: "unavailable",
        unavailableReason: "timestamp-query not supported on this adapter" },
    ],
  };
}

describe("benchmark sample window contract", () => {
  it("rejects NaN, reversed and unavailable out-of-window bounds", () => {
    for (const windowEndMs of [NaN, 999, 9000]) {
      const source = window();
      const input = { ...source, channels: [{ ...source.channels[1]!, windowEndMs }] };
      expect(validateSampleWindow(input).length).toBeGreaterThan(0);
    }
  });
  it("accepts a window where CPU is measured and GPU timestamps are honestly unavailable", () => {
    expect(validateSampleWindow(window())).toEqual([]);
    expect(() => createSampleWindow(window())).not.toThrow();
    expect(channelMedianMs(window(), "cpu-submit")).toBe(3);
    // 不可用通道禁止伪零:中位数必须是 undefined 而不是 0
    expect(channelMedianMs(window(), "gpu-timestamp")).toBeUndefined();
  });

  it("rejects unavailable channels that fake zero samples and measured channels without data", () => {
    const faked = window();
    (faked.channels[1] as { samplesMs: number[] }).samplesMs = [0, 0, 0];
    (faked.channels[1] as { sampleCount: number }).sampleCount = 3;
    expect(validateSampleWindow(faked).map(issue => issue.message)).toContain("unavailable channel must not carry samples or a nonzero count");
    const emptyMeasured = window();
    (emptyMeasured.channels[0] as { samplesMs: number[] }).samplesMs = [];
    expect(validateSampleWindow(emptyMeasured).map(issue => issue.message))
      .toContain("measured channel has no samples; report unavailable instead");
  });

  it("binds sampleCount to raw samples and rejects non-finite values", () => {
    const mismatched = window();
    (mismatched.channels[0] as { sampleCount: number }).sampleCount = 9;
    expect(validateSampleWindow(mismatched).map(issue => issue.message).join()).toContain("does not match");
    const negative = window();
    (negative.channels[0] as { samplesMs: number[] }).samplesMs = [1, -2, 3];
    expect(validateSampleWindow(negative).map(issue => issue.message).join()).toContain("finite and non-negative");
  });

  it("keeps every channel inside the run window and rejects duplicate channels", () => {
    const escaped = window();
    (escaped.channels[0] as { windowEndMs: number }).windowEndMs = 9000;
    expect(validateSampleWindow(escaped).map(issue => issue.message).join()).toContain("exceeds the run window");
    const duplicated = window();
    (duplicated.channels as unknown[]).push({ ...duplicated.channels[0] });
    expect(validateSampleWindow(duplicated).map(issue => issue.message)).toContain("duplicate channel in one window");
  });
});
