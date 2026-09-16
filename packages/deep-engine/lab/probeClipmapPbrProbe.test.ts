import { describe, expect, it } from "vitest";
import { evaluateProbeClipmapPbrChecks, type ProbeClipmapPbrProbeChecks } from "./probeClipmapPbrProbe.js";

const passing = (): ProbeClipmapPbrProbeChecks => ({ committedBindingRendered: true,
  smallMoveUpdatedWithinBudget: true, cameraCutDirtyPrioritized: true,
  cancellationPreservedBinding: true, disposeClearedRendererBinding: true,
  resourcesReturnedToBaseline: true, gpuHealthy: true, fallbackModeReported: true });

describe("probe clipmap PBR controller Lab evaluation", () => {
  it("requires every publication, scheduling, cleanup, and truthfulness check", () => {
    expect(evaluateProbeClipmapPbrChecks(passing())).toBe(true);
    expect(evaluateProbeClipmapPbrChecks({ ...passing(), cancellationPreservedBinding: false })).toBe(false);
    expect(evaluateProbeClipmapPbrChecks({ ...passing(), fallbackModeReported: false })).toBe(false);
  });
});
