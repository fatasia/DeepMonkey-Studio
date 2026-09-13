import { describe, expect, it } from "vitest";
import { evaluateGpuMixedResidencyProbe, type GpuMixedResidencyProbeResult } from "./gpuMixedResidencyProbe.js";

const passing = (): Omit<GpuMixedResidencyProbeResult, "action" | "success" | "failure"> => ({
  samePublicIdResident: true,
  realGpuDrawReadback: true,
  leasesSurvivedDispose: true,
  releaseCleanedResources: true,
  gpuErrorScopesClean: true,
  deviceDiagnosticsClean: true,
  nonFallbackAdapter: true,
  pixel: [32, 128, 224, 255],
  gpuErrors: [],
  resourcesBefore: 2,
  resourcesHeldAfterDispose: 5,
  resourcesAfterRelease: 2,
});

describe("real GPU mixed residency probe evaluation", () => {
  it("requires identity isolation, GPU use, deferred release and clean diagnostics", () => {
    expect(evaluateGpuMixedResidencyProbe(passing())).toBe(true);
    for (const key of ["samePublicIdResident", "realGpuDrawReadback", "leasesSurvivedDispose",
      "releaseCleanedResources", "gpuErrorScopesClean", "deviceDiagnosticsClean", "nonFallbackAdapter"] as const) {
      expect(evaluateGpuMixedResidencyProbe({ ...passing(), [key]: false })).toBe(false);
    }
  });
});
