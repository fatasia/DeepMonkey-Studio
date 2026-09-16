import { describe, expect, it, vi } from "vitest";
import { runSpatialAaCostProbe, summarizeSpatialAaCost } from "./spatialAaCostProbe.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
describe("spatial AA grouped GPU timing", () => {
  it("normalizes groups and uses nearest-rank quantiles without dropping zero samples", () => {
    expect(summarizeSpatialAaCost([32, 96, 64, 0, 128])).toMatchObject({ medianMs: 2, p95Ms: 4, zeroGroups: 1, passesPerGroup: 32 });
    for (const values of [[], [NaN], [-1], [Infinity]]) expect(() => summarizeSpatialAaCost(values)).toThrow("Invalid");
    expect(() => summarizeSpatialAaCost([1], 0)).toThrow("Invalid");
  });
  it("reports unsupported instead of substituting CPU wall time or allocating GPU resources", async () => {
    const own = vi.fn(), session = { state: "ready", resourceCount: 0, format: "bgra8unorm", device: { features: new Set() }, own } as unknown as DeviceSession;
    await expect(runSpatialAaCostProbe(session)).resolves.toMatchObject({ status: "unsupported", cases: [], resourceDelta: 0 });
    expect(own).not.toHaveBeenCalled();
  });
});
