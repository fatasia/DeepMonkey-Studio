import { describe, expect, it } from "vitest";
import { PbrLodWork } from "./pbrLodWork.js";
describe("PBR per-view LOD work", () => {
  it("includes every refreshed view and deduplicates fallback reasons", () => {
    const work = new PbrLodWork({ authorFrustumPasses: 1, authorFrustumDispatches: 2, meshletPasses: 2, meshletDispatches: 4 });
    work.add({ authorFrustumPasses: 4, authorFrustumDispatches: 8, meshletPasses: 8, meshletDispatches: 16,
      meshletFallbackReasons: ["capacity"] });
    work.add({ authorFrustumPasses: 2, authorFrustumDispatches: 4, meshletPasses: 4, meshletDispatches: 8,
      meshletFallbackReasons: ["capacity", "source-budget"] });
    expect(work.snapshot()).toEqual({ authorFrustumPasses: 7, authorFrustumDispatches: 14,
      meshletPasses: 14, meshletDispatches: 28, meshletFallbackReasons: ["capacity", "source-budget"] });
  });
  it("cached views add no compute work and snapshots do not leak mutable state", () => {
    const work = new PbrLodWork({ meshletFallbackReasons: ["capacity"] }); work.add({ drawCalls: 0 });
    const first = work.snapshot(); (first.meshletFallbackReasons as string[]).push("external");
    expect(work.snapshot()).toEqual({ authorFrustumPasses: 0, authorFrustumDispatches: 0,
      meshletPasses: 0, meshletDispatches: 0, meshletFallbackReasons: ["capacity"] });
  });
});
