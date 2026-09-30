import { describe, expect, it } from "vitest";
import { classifyIdentityInvalidation, estimateAccumulationBytes, evaluateConvergence,
  mergeBatchObservation, validatePathTraceConfig, type BrightnessAccumulator,
  type PathTraceSceneIdentity } from "./pathTraceSessionTypes.js";

const identity = (overrides: Partial<PathTraceSceneIdentity> = {}): PathTraceSceneIdentity =>
  ({ sceneRevision: 1, materialHash: "m1", cameraHash: "c1", ...overrides });
const config = validatePathTraceConfig({ width: 8, height: 4, maxSamples: 256,
  maxAccumulationBytes: 64 * 1024 * 1024 });
const accumulator = (sampleCount: number, sum: number, sumSq: number): BrightnessAccumulator =>
  ({ sampleCount, sum, sumSq });

describe("I-C16 session config validation", () => {
  it("fills defaults and derives accumulation bytes as two full planes", () => {
    expect(config).toMatchObject({ width: 8, height: 4, minSamples: 64, varianceThreshold: 0.01,
      channelsPerSample: 3, bytesPerChannel: 4 });
    expect(estimateAccumulationBytes(config)).toBe(8 * 4 * 3 * 4 * 2);
  });
  it("rejects malformed configs fail-closed", () => {
    expect(() => validatePathTraceConfig(undefined as never)).toThrow(TypeError);
    expect(() => validatePathTraceConfig([] as never)).toThrow(TypeError);
    expect(() => validatePathTraceConfig({ height: 4, maxSamples: 8, maxAccumulationBytes: 1 }))
      .toThrow(TypeError);
    expect(() => validatePathTraceConfig({ width: 0, height: 4, maxSamples: 8, maxAccumulationBytes: 1 }))
      .toThrow(RangeError);
    expect(() => validatePathTraceConfig({ width: 8, height: 4, maxSamples: 8.5, maxAccumulationBytes: 1 }))
      .toThrow(RangeError);
    expect(() => validatePathTraceConfig({ width: 8, height: 4, maxSamples: 8, maxAccumulationBytes: -1 }))
      .toThrow(RangeError);
    expect(() => validatePathTraceConfig({ width: 8, height: 4, maxSamples: 8, maxAccumulationBytes: 16,
      minSamples: 9 })).toThrow(/minSamples/);
    expect(() => validatePathTraceConfig({ width: 8, height: 4, maxSamples: 8, maxAccumulationBytes: 16,
      sampleSeed: 0x1_0000_0000 })).toThrow(/sampleSeed/);
    expect(validatePathTraceConfig({ width: 8, height: 4, maxSamples: 256, maxAccumulationBytes: 16,
      sampleSeed: 0xFFFFFFFF }).sampleSeed).toBe(0xFFFFFFFF);
  });
});

describe("I-C16 identity invalidation matrix", () => {
  it("classifies initial / unchanged / identity like the I-C19 pattern", () => {
    expect(classifyIdentityInvalidation(undefined, identity())).toBe("initial");
    expect(classifyIdentityInvalidation(identity(), identity())).toBe("unchanged");
    expect(classifyIdentityInvalidation(identity(), identity({ sceneRevision: 2 }))).toBe("identity");
    expect(classifyIdentityInvalidation(identity(), identity({ materialHash: "m2" }))).toBe("identity");
    // 相机与材质同权重：任一变化都要求重置累积，无"仅相机便宜"特权。
    expect(classifyIdentityInvalidation(identity(), identity({ cameraHash: "c2" }))).toBe("identity");
  });
  it("rejects malformed identities", () => {
    expect(() => classifyIdentityInvalidation(undefined,
      identity({ sceneRevision: -1 }))).toThrow(TypeError);
    expect(() => classifyIdentityInvalidation(undefined,
      identity({ materialHash: "" }))).toThrow(TypeError);
    expect(() => classifyIdentityInvalidation({} as PathTraceSceneIdentity, identity()))
      .toThrow(TypeError);
  });
});

describe("I-C16 convergence gates (samples AND variance)", () => {
  it("holds until both gates pass: samples alone and variance alone are not convergence", () => {
    // 零方差流（常量亮度 2）：se = 0 过方差门，n < minSamples 时样本门挡住。
    const constant = evaluateConvergence(accumulator(63, 63 * 2, 63 * 4), config);
    expect(constant.converged).toBe(false);
    expect(evaluateConvergence(accumulator(64, 64 * 2, 64 * 4), config).converged).toBe(true);
    // 大方差流在样本门满足后仍被方差门挡住。
    const noisy = evaluateConvergence(accumulator(128, 128 * 2, 128 * (4 + 1)), config);
    expect(noisy.variance).toBe(1);
    expect(noisy.standardError).toBeCloseTo(Math.sqrt(1 / 128), 12);
    expect(noisy.converged).toBe(false);
  });
  it("variance gate boundary is inclusive at the threshold", () => {
    // mean=2, variance=0.01, n=64 → se = sqrt(0.01/64) = 0.0125 → relative = 0.00625 ≤ 0.01。
    const pass = evaluateConvergence(accumulator(64, 64 * 2, 64 * (4 + 0.01)), config);
    expect(pass.relativeStandardError).toBeCloseTo(0.00625, 12);
    expect(pass.converged).toBe(true);
    // mean=1, variance=0.64, n=64 → relative = sqrt(0.64/64) = 0.1 > 0.01。
    const fail = evaluateConvergence(accumulator(64, 64, 64 * (1 + 0.64)), config);
    expect(fail.relativeStandardError).toBeCloseTo(0.1, 12);
    expect(fail.converged).toBe(false);
  });
  it("brightness floor keeps a near-black image decidable instead of dividing by zero", () => {
    const dark = validatePathTraceConfig({ width: 8, height: 4, maxSamples: 256,
      maxAccumulationBytes: 64 * 1024 * 1024, brightnessFloor: 1e-6 });
    // mean = 1e-7 < floor：relative = se/floor 而不是除以更小的真值。
    const state = accumulator(64, 64 * 1e-7, 64 * 1e-14);
    const evaluation = evaluateConvergence(state, dark);
    expect(evaluation.converged).toBe(true); // se = 0 → relative = 0 ≤ threshold。
    expect(evaluateConvergence(accumulator(0, 0, 0), config).converged).toBe(false);
  });
});

describe("I-C16 batch merge bookkeeping", () => {
  it("merges sum/sumSq increments and rejects the batch beyond the sample budget", () => {
    const merged = mergeBatchObservation(accumulator(10, 20, 40), { samples: 6, brightnessSum: 12,
      brightnessSumSq: 26 }, 256);
    expect(merged).toEqual({ sampleCount: 16, sum: 32, sumSq: 66 });
    // 预算拒绝负例：超限整批不入账；恰好达到上限（≤）允许。
    expect(mergeBatchObservation(accumulator(255, 0, 0), { samples: 2, brightnessSum: 0,
      brightnessSumSq: 0 }, 256)).toBeUndefined();
    expect(mergeBatchObservation(accumulator(254, 0, 0), { samples: 2, brightnessSum: 0,
      brightnessSumSq: 0 }, 256)).toEqual({ sampleCount: 256, sum: 0, sumSq: 0 });
  });
  it("rejects malformed observations", () => {
    expect(() => mergeBatchObservation(accumulator(0, 0, 0), undefined as never, 256))
      .toThrow(TypeError);
    expect(() => mergeBatchObservation(accumulator(0, 0, 0), { samples: 0, brightnessSum: 1,
      brightnessSumSq: 1 }, 256)).toThrow(RangeError);
    expect(() => mergeBatchObservation(accumulator(0, 0, 0), { samples: 4, brightnessSum: -1,
      brightnessSumSq: 1 }, 256)).toThrow(/brightnessSum\b/);
    expect(() => mergeBatchObservation(accumulator(0, 0, 0), { samples: 4, brightnessSum: Number.NaN,
      brightnessSumSq: 1 }, 256)).toThrow(RangeError);
  });
});
