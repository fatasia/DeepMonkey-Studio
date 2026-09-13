import { describe, expect, it } from "vitest";
import {
  evaluatePbrPartialLodResidencyProbe,
  type PbrPartialLodResidencyProbeResult,
} from "./pbrPartialLodResidencyProbe.js";

const surface = (x: number) => ({ width: 256, height: 128, redPixels: 200,
  redCentroidX: x, redCentroidY: 0.5, peakRgba: [255, 20, 10, 255] as const, checksum: `${x}` });
const passing = (): Omit<PbrPartialLodResidencyProbeResult, "action" | "success" | "failure"> => ({
  coarseOnlyActuallyDrew: true,
  coarseStagePreservedLegacyFrame: true,
  fineStagePreservedCoarseFrameAndLease: true,
  finePublishedAtFrameBoundary: true,
  farViewSelectedCoarse: true,
  uploadsExactlyOnce: true,
  leaseRetirementOrdered: true,
  streamedResourcesReleased: true,
  rendererCacheBounded: true,
  gpuErrorScopesClean: true,
  deviceDiagnosticsClean: true,
  nonFallbackAdapter: true,
  surfaces: { legacy: surface(0.5), coarseStage: surface(0.5), coarse: surface(0.4),
    fineStage: surface(0.4), fine: surface(0.6), far: surface(0.4) },
  uploads: { coarseGpuResources: 2, fineGpuResources: 2,
    firstResidents: ["geometry:coarse"], replacementResidents: ["geometry:coarse", "geometry:fine"] },
  resources: { baseline: 60, coarseFrame: 77, fineStage: 79, fineFrame: 79,
    farFrame: 79, afterCleanup: 60, retiredBeforeFineFrame: 640, retiredAfterFineFrame: 640,
    retiredAfterCleanup: 0, rendererCacheDelta: 0 },
  draws: { coarse: { drawCalls: 6, triangles: 11, lodSelectionBatches: 1, lodIndirectDraws: 1 },
    fine: { drawCalls: 10, triangles: 35, lodSelectionBatches: 1, lodIndirectDraws: 2 },
    far: { drawCalls: 4, triangles: 11, lodSelectionBatches: 1, lodIndirectDraws: 2 } },
  gpuErrors: [],
});

describe("PBR partial LOD residency probe evaluation", () => {
  it("requires draw identity, frame boundaries, exact uploads, leases and GPU hygiene", () => {
    expect(evaluatePbrPartialLodResidencyProbe(passing())).toBe(true);
    for (const key of ["coarseOnlyActuallyDrew", "coarseStagePreservedLegacyFrame",
      "fineStagePreservedCoarseFrameAndLease", "finePublishedAtFrameBoundary",
      "farViewSelectedCoarse", "uploadsExactlyOnce", "leaseRetirementOrdered",
      "streamedResourcesReleased", "rendererCacheBounded", "gpuErrorScopesClean", "deviceDiagnosticsClean",
      "nonFallbackAdapter"] as const) {
      expect(evaluatePbrPartialLodResidencyProbe({ ...passing(), [key]: false })).toBe(false);
    }
  });
});
