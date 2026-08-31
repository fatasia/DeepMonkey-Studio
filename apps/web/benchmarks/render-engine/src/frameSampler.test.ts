import { describe, expect, it } from "vitest";
import { FrameSampler, ValueSampler } from "./frameSampler";

describe("render benchmark frame sampler", () => {
  it("reports average and nearest-rank frame percentiles", () => {
    const sampler = new FrameSampler();
    [0, 10, 30, 60, 100].forEach((time) => sampler.record(time));
    expect(sampler.snapshot()).toEqual({
      samples: 4,
      averageMs: 25,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      maximumMs: 40
    });
  });
});

describe("render benchmark value sampler", () => {
  it("ignores invalid GPU readings and uses the same percentile contract", () => {
    const sampler = new ValueSampler();
    [Number.NaN, -1, 1, 2, 3, 4].forEach((value) => sampler.record(value));
    expect(sampler.snapshot()).toMatchObject({ samples: 4, averageMs: 2.5, p50Ms: 2, p95Ms: 4 });
  });
});
