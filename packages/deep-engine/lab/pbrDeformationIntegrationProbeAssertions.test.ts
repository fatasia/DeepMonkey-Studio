import { describe, expect, it } from "vitest";
import { integrationEffectsPassesComplete } from "./pbrDeformationIntegrationProbeAssertions.js";

describe("integration effects pass evidence", () => {
  it("accepts eight HiZ mips plus eight AO/TAA/OIT/spatial AA passes", () => {
    expect(integrationEffectsPassesComplete({ weightedOit: true, hiZMipLevels: 8, postProcessPasses: 16 })).toBe(true);
  });

  it.each([
    [8, "HiZ only"], [12, "AO omitted"], [15, "TAA or spatial AA omitted"], [14, "OIT passes omitted"],
    [17, "unexpected additional pass"], [16.5, "fractional count"], [NaN, "invalid count"],
  ] as const)("rejects %s passes (%s)", (postProcessPasses, _reason) => {
    expect(integrationEffectsPassesComplete({ weightedOit: true, hiZMipLevels: 8,
      postProcessPasses })).toBe(false);
  });

  it("rejects missing OIT despite a matching total", () => {
    expect(integrationEffectsPassesComplete({ weightedOit: false, hiZMipLevels: 8, postProcessPasses: 16 })).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid HiZ mip count %s", hiZMipLevels => {
    expect(integrationEffectsPassesComplete({ weightedOit: true, hiZMipLevels, postProcessPasses: hiZMipLevels + 8 })).toBe(false);
  });
});
