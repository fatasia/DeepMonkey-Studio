import { describe, expect, it } from "vitest";
import {
  evaluateGpuTextureMipResidencyProbe,
  type GpuTextureMipResidencyProbeResult,
} from "./gpuTextureMipResidencyProbe.js";

const passing = (): Omit<GpuTextureMipResidencyProbeResult, "action" | "success" | "failure"> => ({
  rgbaCatalogLevelsExact: true,
  rgbaLevel1Sampled: true,
  rgbaLevel2Sampled: true,
  bcCatalogBlockedIllegalBase: true,
  bcStatus: "passed",
  bcTailMipSampled: true,
  gpuErrorScopesClean: true,
  deviceDiagnosticsClean: true,
  resourcesReleased: true,
  nonFallbackAdapter: true,
  rgbaPixels: { 1: [0, 255, 0, 255], 2: [0, 0, 255, 255] },
  bcPixels: [[0, 255, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255]],
  gpuErrors: [],
});

describe("real GPU texture mip residency probe evaluation", () => {
  it("requires ordinary suffix samples, catalog safety, GPU hygiene and native adapter", () => {
    expect(evaluateGpuTextureMipResidencyProbe(passing())).toBe(true);
    for (const key of ["rgbaCatalogLevelsExact", "rgbaLevel1Sampled", "rgbaLevel2Sampled",
      "bcCatalogBlockedIllegalBase", "gpuErrorScopesClean", "deviceDiagnosticsClean",
      "resourcesReleased", "nonFallbackAdapter"] as const) {
      expect(evaluateGpuTextureMipResidencyProbe({ ...passing(), [key]: false })).toBe(false);
    }
  });

  it("accepts an explicit unsupported-BC skip but rejects supported BC failures", () => {
    expect(evaluateGpuTextureMipResidencyProbe({ ...passing(), bcStatus: "skipped",
      bcTailMipSampled: false })).toBe(true);
    expect(evaluateGpuTextureMipResidencyProbe({ ...passing(), bcStatus: "failed",
      bcTailMipSampled: false })).toBe(false);
  });
});
