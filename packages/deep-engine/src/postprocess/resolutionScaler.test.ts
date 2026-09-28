import { describe, expect, it } from "vitest";
import { DEFAULT_RESOLUTION_SCALE_POLICY, DynamicResolutionScaler, internalResolutionReport } from "./resolutionScaler.js";

const policy = { ...DEFAULT_RESOLUTION_SCALE_POLICY, targetFrameMs: 10, hysteresisMs: 2, upHoldFrames: 3,
  quantize: 0.05, downStep: 0.1, upStep: 0.05 };

describe("dynamic resolution scaler (T07)", () => {
  it("holds the scale inside the hysteresis band", () => {
    const scaler = new DynamicResolutionScaler(policy);
    expect(scaler.scale).toBe(1);
    const decision = scaler.observe(11.5);
    expect(decision).toMatchObject({ frame: 0, frameMs: 11.5, previousScale: 1, scale: 1, action: "hold", reason: "within-band" });
    expect(scaler.observe(8.5)).toMatchObject({ action: "hold", reason: "within-band" });
  });

  it("steps down immediately above the band and stops at the floor", () => {
    const scaler = new DynamicResolutionScaler(policy);
    expect(scaler.observe(12.1)).toMatchObject({ action: "decrease", reason: "above-high-band", scale: 0.9 });
    expect(scaler.observe(12.1).frame).toBe(1);
    const floored = new DynamicResolutionScaler({ ...policy, minScale: 0.96 });
    const decision = floored.observe(12.1);
    expect(decision).toMatchObject({ action: "decrease", reason: "at-floor", scale: 0.96 });
  });

  it("requires consecutive below-band frames before stepping up", () => {
    const scaler = new DynamicResolutionScaler(policy, 0.5);
    expect(scaler.observe(5)).toMatchObject({ action: "hold", reason: "up-hold-warmup", belowBandRun: 1 });
    expect(scaler.observe(5)).toMatchObject({ action: "hold", reason: "up-hold-warmup", belowBandRun: 2 });
    expect(scaler.observe(5)).toMatchObject({ action: "increase", reason: "below-low-band", scale: 0.55, belowBandRun: 0 });
    // Ceiling: repeated up-steps clamp at maxScale.
    for (let frame = 0; frame < 40; frame++) scaler.observe(5);
    expect(scaler.scale).toBe(policy.maxScale);
    expect(scaler.observe(5)).toMatchObject({ action: "hold", reason: "at-ceiling" });
  });

  it("mixed frame times reset the warm-up run and keep the scale stable", () => {
    const scaler = new DynamicResolutionScaler(policy, 0.5);
    scaler.observe(5); scaler.observe(5);
    expect(scaler.observe(11.5)).toMatchObject({ action: "hold", reason: "within-band", belowBandRun: 0 });
    expect(scaler.scale).toBe(0.5);
  });

  it("snaps every scale onto the nearest policy ladder step", () => {
    const scaler = new DynamicResolutionScaler({ ...policy, quantize: 1 / 16, minScale: 0.25 });
    const decision = scaler.observe(40);
    expect(decision.scale).toBeCloseTo(0.875, 12);
    const starter = new DynamicResolutionScaler({ ...policy, quantize: 1 / 16 }, 0.93);
    expect(starter.scale).toBeCloseTo(0.9375, 12);
  });

  it("rejects invalid policies, frame times, and initial scales", () => {
    expect(() => new DynamicResolutionScaler({ ...policy, minScale: 1.5 })).toThrow();
    expect(() => new DynamicResolutionScaler(policy, 2)).toThrow();
    const scaler = new DynamicResolutionScaler(policy);
    expect(() => scaler.observe(0)).toThrow();
    expect(() => scaler.observe(Number.NaN)).toThrow();
  });

  it("reports pixel savings with an honest unmeasured quality slot for the 67% mode", () => {
    const report = internalResolutionReport(0.67, 1920, 1080);
    expect(report.internalWidth).toBe(1286);
    expect(report.internalHeight).toBe(724);
    expect(report.pixelRatio).toBeCloseTo((1286 * 724) / (1920 * 1080), 12);
    expect(report.pixelSavingRatio).toBeCloseTo(1 - report.pixelRatio, 12);
    expect(report.pixelSavingRatio).toBeGreaterThan(0.55);
    expect(report.quality).toMatchObject({ measured: false });
    expect(report.quality.note).toContain("GPU sequence harness");
    const quarter = internalResolutionReport(0.5, 100, 100);
    expect(quarter).toMatchObject({ internalWidth: 50, internalHeight: 50, pixelRatio: 0.25, pixelSavingRatio: 0.75 });
    expect(() => internalResolutionReport(0, 1920, 1080)).toThrow();
    expect(() => internalResolutionReport(1.2, 1920, 1080)).toThrow();
    expect(() => internalResolutionReport(0.67, 0, 1080)).toThrow();
  });

  it("carries measured quality numbers from the GPU harness into the report slot", () => {
    const report = internalResolutionReport(0.67, 512, 288, { ssim: 0.961, edgeRetention: 0.82, gpuCostRatio: 0.49,
      note: "t07 harness: fence+character SSIM vs native; cost ratio at 512x288" });
    expect(report).toMatchObject({ internalWidth: 343, internalHeight: 193,
      quality: { measured: true, ssim: 0.961, edgeRetention: 0.82, gpuCostRatio: 0.49 } });
    expect(report.quality.note).toContain("harness");
  });
});
