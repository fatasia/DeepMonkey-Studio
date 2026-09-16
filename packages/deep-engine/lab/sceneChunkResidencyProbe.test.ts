import { describe, expect, it } from "vitest";
import { evaluateSceneChunkResidencyProbe,
  type SceneChunkResidencyProbeResult } from "./sceneChunkResidencyProbe.js";

const telemetry = (frame: number, uploads: number) => ({
  disposed: false, residencyRevision: frame, registeredResourceCount: 5,
  residentResourceCount: 5, residentBytes: 500, retiredBytes: 0, allocatedBytes: 500,
  geometry: { residentResourceCount: 3, residentBytes: 420 },
  texture: { residentResourceCount: 2, residentBytes: 80 },
  resources: [], lastAppliedFrame: { frame, generation: frame, residencyRevision: frame,
    requestedResourceCount: 5, uploadedResourceCount: uploads, uploadedBytes: uploads * 100,
    evictedResourceCount: 0, failedUploadCount: 0, qualityReducedResourceCount: 0,
    uploadBudgetUtilization: 0.1 }, budgets: { maxResidentBytes: 1000,
    maxUploadBytesPerFrame: 1000, maxResources: 10, retainFrames: 0,
    residentByteUtilization: 0.5, allocatedByteUtilization: 0.5, registeredResourceUtilization: 0.5 },
});

const passing = (): Omit<SceneChunkResidencyProbeResult, "action" | "success" | "failure"> => ({
  sameFrameLatestWon: true,
  mergedSharedUploadOnce: true,
  visibleChunksDrew: true,
  sameFrameChunkCounts: [2, 3],
  prefetchHadNoProjection: true,
  prefetchPromotionReusedUploads: true,
  exitedChunkLeaseRetired: true,
  resourcesReturnedToBaseline: true,
  projectionsReleased: true,
  gpuErrorScopesClean: true,
  deviceDiagnosticsClean: true,
  nonFallbackAdapter: true,
  pixels: { west: [255, 10, 10, 255], east: [10, 255, 10, 255], ahead: [10, 10, 255, 255] },
  telemetry: { first: telemetry(31_001, 5), promoted: telemetry(31_002, 0),
    exited: telemetry(31_003, 0), sameFrame: telemetry(31_004, 0), final: telemetry(31_005, 0) },
  resources: { baseline: 60, first: 68, promoted: 71, exited: 68, afterCleanup: 60 },
  retiredBytes: { exited: 512, afterRelease: 0, afterCleanup: 0 },
  submittedFrames: { firstDelta: 1, final: 6 },
  supersededCode: "superseded", gpuErrors: [],
});

describe("scene chunk residency probe evaluation", () => {
  it("requires merged upload, real draws, prefetch reuse, retirement, cleanup, and GPU hygiene", () => {
    expect(evaluateSceneChunkResidencyProbe(passing())).toBe(true);
    for (const key of ["sameFrameLatestWon", "mergedSharedUploadOnce", "visibleChunksDrew",
      "prefetchHadNoProjection", "prefetchPromotionReusedUploads", "exitedChunkLeaseRetired",
      "resourcesReturnedToBaseline", "projectionsReleased", "gpuErrorScopesClean",
      "deviceDiagnosticsClean", "nonFallbackAdapter"] as const) {
      expect(evaluateSceneChunkResidencyProbe({ ...passing(), [key]: false })).toBe(false);
    }
    expect(evaluateSceneChunkResidencyProbe({ ...passing(),
      submittedFrames: { firstDelta: 3, final: 7 } })).toBe(false);
    expect(evaluateSceneChunkResidencyProbe({ ...passing(), sameFrameChunkCounts: [1, 1, 1] })).toBe(false);
  });
});
