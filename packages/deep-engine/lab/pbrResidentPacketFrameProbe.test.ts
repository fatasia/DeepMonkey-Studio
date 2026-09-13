import { describe, expect, it } from "vitest";
import {
  evaluatePbrResidentPacketFrameProbe,
  type PbrResidentPacketFrameProbeResult,
} from "./pbrResidentPacketFrameProbe.js";

const passing = (): Omit<PbrResidentPacketFrameProbeResult, "action" | "success" | "failure"> => ({
  firstStagePreservedOldFrame: true,
  firstFramePublishedResidentPacket: true,
  replacementStagePreservedOldFrameAndLease: true,
  replacementFramePublishedAndRetiredOldLease: true,
  runtimeUploadsExactlyOnce: true,
  resourcesReleased: true,
  gpuErrorScopesClean: true,
  deviceDiagnosticsClean: true,
  nonFallbackAdapter: true,
  pixels: { legacy: [255, 0, 0, 255], firstStage: [255, 0, 0, 255],
    firstResident: [0, 255, 0, 255], replacementStage: [0, 255, 0, 255],
    replacement: [0, 0, 255, 255] },
  uploads: { first: { geometry: 1, texture: 1 }, replacement: { geometry: 1, texture: 1 } },
  resources: { baseline: 48, replacementStage: 60, replacementFrame: 54, afterCleanup: 48 },
  gpuErrors: [],
});

describe("PBR resident packet frame-boundary probe evaluation", () => {
  it("requires both frame-boundary swaps, lease retirement, exact uploads and GPU hygiene", () => {
    expect(evaluatePbrResidentPacketFrameProbe(passing())).toBe(true);
    for (const key of ["firstStagePreservedOldFrame", "firstFramePublishedResidentPacket",
      "replacementStagePreservedOldFrameAndLease", "replacementFramePublishedAndRetiredOldLease",
      "runtimeUploadsExactlyOnce", "resourcesReleased", "gpuErrorScopesClean",
      "deviceDiagnosticsClean", "nonFallbackAdapter"] as const) {
      expect(evaluatePbrResidentPacketFrameProbe({ ...passing(), [key]: false })).toBe(false);
    }
  });
});
