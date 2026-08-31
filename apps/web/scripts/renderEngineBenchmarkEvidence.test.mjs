import { describe, expect, it } from "vitest";
import { assessFirstClassWebGpuEvidence } from "./renderEngineBenchmarkEvidence.mjs";

const limits = {
  maxTextureDimension2D: 8192,
  maxBindGroups: 4,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256,
};

function makeCase(engine) {
  return {
    engine,
    workload: "static",
    objectCount: 120,
    run: 1,
    environment: { webGpuLimits: limits },
    heapSamples: [10, 11, 10],
    observations: { supported: true, count: 0, totalMs: 0, maximumMs: 0 },
  };
}

function makeVisualComparisons() {
  return [{
    reference: "three-webgl",
    candidate: "three-webgpu",
    ssim: 0.98,
    meanAbsoluteError: 0.01,
    changedPixelRatio: 0.02,
    severePixelRatio: 0,
  }];
}

describe("WebGPU 一级对比证据", () => {
  it("accepts complete adapter, heap, long-task and visual evidence", () => {
    const failures = assessFirstClassWebGpuEvidence([makeCase("three-webgpu")], makeVisualComparisons(), 2);
    expect(failures).toEqual([]);
  });

  it("rejects missing limits, rebuild heap samples, long tasks and visual comparison", () => {
    const incomplete = makeCase("three-webgpu");
    incomplete.environment = {};
    incomplete.heapSamples = [10];
    incomplete.observations = { supported: false };
    const failures = assessFirstClassWebGpuEvidence([incomplete], [], 2);

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("limits 证据不完整"),
        expect.stringContaining("重建堆样本"),
        expect.stringContaining("Long Tasks API"),
        expect.stringContaining("three-webgl/three-webgpu"),
      ]),
    );
  });

  it("rejects a severe WebGPU visual regression", () => {
    const comparisons = makeVisualComparisons();
    comparisons[0].ssim = 0.4;
    const failures = assessFirstClassWebGpuEvidence([makeCase("three-webgpu")], comparisons, 2);
    expect(failures).toContain("three-webgl/three-webgpu: 画面结构相似度仅 0.400");
  });
});
