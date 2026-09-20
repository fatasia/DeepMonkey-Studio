import { describe, expect, it } from "vitest";
import { percentile, summarizeLatencies } from "./latencyStats.js";

describe("latency stats contract", () => {
  it("computes exact nearest-rank percentiles on a known distribution", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 100)).toBe(10);
    expect(percentile(values, 50, "linear")).toBe(5.5);
    expect(percentile(values, 95, "linear")).toBeCloseTo(9.55, 6);
  });

  it("rejects empty input, non-finite samples, and out-of-range p fail-closed", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1, Number.NaN, 3], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => summarizeLatencies([], {})).toThrow(RangeError);
    expect(() => summarizeLatencies([1, -2, 3])).toThrow(RangeError);
  });

  it("summarizes long frames with a configurable threshold", () => {
    const summary = summarizeLatencies([10, 12, 14, 16, 120, 200], { longFrameThresholdMs: 100 });
    expect(summary.count).toBe(6);
    expect(summary.longFrameCount).toBe(2);
    expect(summary.longFrameRatio).toBeCloseTo(2 / 6, 6);
    expect(summary.p50Ms).toBeLessThanOrEqual(summary.p95Ms);
    expect(summary.p95Ms).toBeLessThanOrEqual(summary.p99Ms);
    expect(summary.p99Ms).toBeLessThanOrEqual(summary.maxMs);
    expect(summary.meanMs).toBeCloseTo(62, 6);
  });

  it("keeps monotone percentile ordering on a 1000-sample uniform sweep", () => {
    const values = Array.from({ length: 1000 }, (_, i) => 1 + i);
    const summary = summarizeLatencies(values, { longFrameThresholdMs: 2000 });
    // nearest-rank：ceil(N×p/100) 位。N=1000 → p50=第500个值500，p95=950，p99=990。
    expect(summary.p50Ms).toBe(500);
    expect(summary.p95Ms).toBe(950);
    expect(summary.p99Ms).toBe(990);
    expect(summary.longFrameCount).toBe(0);
  });
});
