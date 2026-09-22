import { describe, expect, it } from "vitest";
import { compareBenchmarkWindows, type BenchmarkWindowPair } from "./benchmarkWindowComparison.js";
import type { SampleWindow } from "./benchmarkSampleSchema.js";

function window(runId: string, sample: number): SampleWindow {
  return { schema: "deep-engine.benchmark-sample-window", schemaVersion: 1, runId,
    clockId: "performance-now", windowStartMs: 1, windowEndMs: 20,
    channels: [{ channel: "cpu-submit", clockId: "performance-now", availability: "measured",
      sampleCount: 3, samplesMs: [sample, sample, sample], windowStartMs: 1, windowEndMs: 20 }] };
}
function pairs(): BenchmarkWindowPair[] {
  return Array.from({ length: 5 }, (_, index) => ({ round: index + 1,
    candidate: window(`c${index}`, index + 1), reference: window(`r${index}`, index + 3) }));
}
describe("paired raw-window comparison", () => {
  it("preserves matched-round differences and deterministic intervals", () => {
    const report = compareBenchmarkWindows(pairs());
    expect(report.find(item => item.channel === "cpu-submit")).toMatchObject({
      status: "measured", pairedRounds: 5, candidateP95MedianMs: 3, referenceP95MedianMs: 5,
      deltaMeanMs: -2, delta95IntervalMs: [-2, -2],
    });
    expect(compareBenchmarkWindows(pairs())).toEqual(report);
    expect(report.find(item => item.channel === "input-latency")).toMatchObject({ status: "unverified", deltaMeanMs: null });
  });
  it("does not drop incomplete pairs to obtain a favorable result", () => {
    const input = pairs(); input[2] = { ...input[2]!, reference: { ...window("r2", 3), channels: [] } };
    expect(compareBenchmarkWindows(input).find(item => item.channel === "cpu-submit"))
      .toMatchObject({ status: "unverified", pairedRounds: 4, delta95IntervalMs: null });
  });
  it.each(["count", "clock", "round", "duplicate", "short"])("rejects %s corruption", corruption => {
    const input = pairs();
    if (corruption === "short") input.pop();
    else if (corruption === "round") input[0] = { ...input[0]!, round: 2 };
    else if (corruption === "duplicate") input[0] = { ...input[0]!, reference: window("c0", 4) };
    else input[0] = { ...input[0]!, reference: { ...window("r0", 3), channels: [{
      ...window("r0", 3).channels[0]!, ...(corruption === "clock" ? { clockId: "gpu-timestamp" as const } : { sampleCount: 99 }),
    }] } };
    expect(compareBenchmarkWindows(input).find(item => item.channel === "cpu-submit")?.status).toBe("unverified");
  });
});
