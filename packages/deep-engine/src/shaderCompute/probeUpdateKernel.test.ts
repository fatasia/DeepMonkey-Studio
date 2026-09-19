import { describe, expect, it } from "vitest";
import { PROBE_FILTER_TAP_ORDER, PROBE_IRRADIANCE_FILTER_NAME, buildProbeIrradianceFilterKernel,
  probeClipmapLayerIndex } from "./index.js";
import type { ProbeUpdate } from "../lighting/probeClipmapPlan.js";

const update = (level: number, z: number): ProbeUpdate => ({
  level, localCell: [1, 2, z], cell: [1, 2, z], linearIndex: (z * 4 + 2) * 4 + 1,
  position: [1, 2, z], reason: "dirty",
});

describe("GI probe update kernel design stub", () => {
  it("computes probe layer indices consistent with webgpuProbeCaptureWgsl.probeLayer", () => {
    expect(probeClipmapLayerIndex(update(0, 3), 8)).toBe(3);
    expect(probeClipmapLayerIndex(update(2, 5), 8)).toBe(21);
    expect(() => probeClipmapLayerIndex(update(0, 8), 8)).toThrow("within [0, gridZ)");
    expect(() => probeClipmapLayerIndex(update(-1, 0), 8)).toThrow("nonnegative");
  });

  it("declares the fixed 3x3 gather order and stays an explicit v1 stub", () => {
    expect(PROBE_IRRADIANCE_FILTER_NAME).toBe("probe_irradiance_filter");
    expect(PROBE_FILTER_TAP_ORDER).toHaveLength(9);
    expect(PROBE_FILTER_TAP_ORDER[0]).toEqual([-1, -1]);
    expect(PROBE_FILTER_TAP_ORDER[8]).toEqual([1, 1]);
    expect(() => buildProbeIrradianceFilterKernel()).toThrow("not implemented in this slice");
  });
});
