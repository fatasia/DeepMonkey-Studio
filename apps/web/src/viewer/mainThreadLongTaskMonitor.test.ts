import { describe, expect, it } from "vitest";
import { MainThreadLongTaskMonitor } from "./mainThreadLongTaskMonitor";

describe("MainThreadLongTaskMonitor", () => {
  it("reports count, blocking time and maximum in the rolling window", () => {
    const monitor = new MainThreadLongTaskMonitor(true, 1_000);
    monitor.record(100, 70);
    monitor.record(700, 130);
    monitor.record(900, Number.NaN);
    expect(monitor.snapshot(1_000)).toEqual({
      supported: true,
      count: 2,
      totalDurationMs: 200,
      blockingTimeMs: 100,
      maximumDurationMs: 130,
      windowMs: 1_000,
    });
  });

  it("evicts tasks outside the observation window", () => {
    const monitor = new MainThreadLongTaskMonitor(true, 1_000);
    monitor.record(0, 60);
    monitor.record(1_200, 55);
    expect(monitor.snapshot(1_300).count).toBe(1);
  });
});
