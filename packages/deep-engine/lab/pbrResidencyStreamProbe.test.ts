import { describe, expect, it } from "vitest";
import {
  evaluatePbrResidencyStreamProbe,
  type PbrResidencyStreamProbeResult,
} from "./pbrResidencyStreamProbe.js";

const telemetry = (frame: number, textureLevel: number, uploads: number) => ({
  disposed: false, residencyRevision: frame, registeredResourceCount: 2,
  residentResourceCount: 2, residentBytes: 128, retiredBytes: 0,
  allocatedBytes: 128, geometry: { residentResourceCount: 1, residentBytes: 100 },
  texture: { residentResourceCount: 1, residentBytes: 28 },
  resources: [
    { id: "stream-geometry", kind: "geometry" as const, revision: 1, level: 0,
      byteLength: 100, lastUsedFrame: frame },
    { id: "stream-emissive", kind: "texture" as const, revision: 1, level: textureLevel,
      byteLength: 28, lastUsedFrame: frame },
  ],
  lastAppliedFrame: { frame, generation: frame, residencyRevision: frame,
    requestedResourceCount: 2, uploadedResourceCount: uploads, uploadedBytes: 28,
    evictedResourceCount: 0, failedUploadCount: 0, qualityReducedResourceCount: 0,
    uploadBudgetUtilization: 0.1 },
  budgets: { maxResidentBytes: 1024, maxUploadBytesPerFrame: 1024,
    maxResources: 8, retainFrames: 1, residentByteUtilization: 0.125,
    allocatedByteUtilization: 0.125, registeredResourceUtilization: 0.25 },
});

const passing = (): Omit<PbrResidencyStreamProbeResult, "action" | "success" | "failure"> => ({
  firstStagePreservedLegacyFrame: true,
  firstFramePublishedAtBoundary: true,
  sameFrameLatestWon: true,
  replacementStagePreservedFrameAndLease: true,
  replacementFramePublishedAndRetiredLease: true,
  uploadsExactlyOnce: true,
  projectionsReleased: true,
  resourcesReturnedToBaseline: true,
  gpuErrorScopesClean: true,
  deviceDiagnosticsClean: true,
  nonFallbackAdapter: true,
  pixels: { legacy: [255, 20, 20, 255], firstStage: [255, 20, 20, 255],
    first: [20, 255, 20, 255], replacementStage: [20, 255, 20, 255],
    replacement: [20, 20, 255, 255] },
  telemetry: { first: telemetry(21_001, 1, 2), replacement: telemetry(21_002, 2, 1) },
  resources: { baseline: 60, firstStage: 68, firstFrame: 68,
    replacementStage: 70, replacementFrame: 68, afterCleanup: 60 },
  retiredBytes: { replacementStage: 20, replacementFrame: 0, afterCleanup: 0 },
  stagedProjectionCount: 2, supersededCode: "superseded", gpuErrors: [],
});

describe("PBR residency stream probe evaluation", () => {
  it("requires boundaries, same-frame latest-wins, upload identity, cleanup, and GPU hygiene", () => {
    expect(evaluatePbrResidencyStreamProbe(passing())).toBe(true);
    for (const key of ["firstStagePreservedLegacyFrame", "firstFramePublishedAtBoundary",
      "sameFrameLatestWon", "replacementStagePreservedFrameAndLease",
      "replacementFramePublishedAndRetiredLease", "uploadsExactlyOnce", "projectionsReleased",
      "resourcesReturnedToBaseline", "gpuErrorScopesClean", "deviceDiagnosticsClean",
      "nonFallbackAdapter"] as const) {
      expect(evaluatePbrResidencyStreamProbe({ ...passing(), [key]: false })).toBe(false);
    }
  });
});
