import { describe, expect, it } from "vitest";
import { evaluateGpuResidencyProbe, type GpuResidencyProbeResult } from "./gpuResidencyProbe.js";

const passing = (): Omit<GpuResidencyProbeResult, "action" | "success"> => ({
  initialUploadReadback: true,
  failedReplacementRetained: true,
  atomicReplacementPublished: true,
  plannedBytesMatched: true,
  cancellationReleased: true,
  disposeReleased: true,
  deviceLossObserved: true,
  staleCandidateReleased: true,
  adapterRuntime: true,
  initialValue: 1,
  retainedValue: 1,
  replacementValue: 2,
  releasedBuffers: 3,
});

describe("real GPU residency probe evaluation", () => {
  it("requires every transaction and lifecycle observation", () => {
    expect(evaluateGpuResidencyProbe(passing())).toBe(true);
    for (const key of [
      "initialUploadReadback", "failedReplacementRetained", "atomicReplacementPublished", "plannedBytesMatched",
      "cancellationReleased", "disposeReleased", "deviceLossObserved", "staleCandidateReleased", "adapterRuntime",
    ] as const) {
      expect(evaluateGpuResidencyProbe({ ...passing(), [key]: false })).toBe(false);
    }
  });
});
