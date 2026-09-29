import { describe, expect, it } from "vitest";
import { resolveVirtualTextureFootprints, resolveVirtualTextureSample,
  TextureThrashDetector } from "./virtualTextureDiagnostics.js";
import { buildVirtualTexturePageRequests, VirtualTexturePageTable,
  type VirtualTextureFootprint } from "./virtualTexturePageTable.js";
import { virtualTexturePageCostBytes } from "./virtualTexturePages.js";

const TILE = Object.freeze({ tileEdgeTexels: 4, bytesPerTexel: 4 });
const COST = virtualTexturePageCostBytes(TILE);

function footprint(overrides: Partial<VirtualTextureFootprint> = {}): VirtualTextureFootprint {
  return { textureId: "tex", tileX: 0, tileY: 0, maxMip: 2, weight: 1, ...overrides };
}

function committedTable(maxBytes = COST * 3, maxMip = 2): VirtualTexturePageTable {
  const table = new VirtualTexturePageTable(TILE, { maxBytes });
  const plan = table.plan(buildVirtualTexturePageRequests([footprint({ maxMip })], TILE), 0);
  table.commitAdmissions(plan.admitted.map(page => page.id));
  return table;
}

describe("virtual texture page-fault resolution", () => {
  it("samples the requested mip when resident and falls back to the finest committed mip otherwise", () => {
    const table = committedTable();
    expect(resolveVirtualTextureSample(table, "tex", 0, 0, 1))
      .toEqual({ status: "resident", resolvedMip: 1, fallbackLevels: 0 });
    expect(resolveVirtualTextureSample(table, "tex", 0, 0, 2))
      .toEqual({ status: "resident", resolvedMip: 2, fallbackLevels: 0 });
    expect(resolveVirtualTextureSample(table, "tex", 5, 5, 0))
      .toEqual({ status: "fallback-texture", resolvedMip: null, fallbackLevels: null });
  });

  it("never resolves to an in-flight (uncommitted) page", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 3 });
    table.plan(buildVirtualTexturePageRequests([footprint()], TILE), 0);
    // All pages are in-flight: sampling must use the whole-texture fallback, not the upload.
    expect(table.residentMipDepth("tex", 0, 0)).toBe(-1);
    expect(resolveVirtualTextureSample(table, "tex", 0, 0, 0).status).toBe("fallback-texture");
  });

  it("reports how many coarser levels a fault lands on", () => {
    const table = committedTable(COST, 0);
    const plan = table.plan(buildVirtualTexturePageRequests([footprint({ maxMip: 3 })], TILE), 1);
    expect(plan.stats.deferredCount).toBe(3);
    expect(resolveVirtualTextureSample(table, "tex", 0, 0, 3))
      .toEqual({ status: "page-fault", resolvedMip: 0, fallbackLevels: 3 });
    expect(() => resolveVirtualTextureSample(table, "tex", 0, 0, -1)).toThrow(/Requested mip/);
  });

  it("footprint 批量解析:命中/缺页/回退整纹理三类分布逐帧可用", () => {
    const table = committedTable();
    const resolution = resolveVirtualTextureFootprints(table, [
      footprint({ maxMip: 1 }), footprint({ maxMip: 2 }),
      footprint({ maxMip: 3 }),
      footprint({ tileX: 7, tileY: 7, maxMip: 0 }),
    ]);
    expect(resolution).toEqual({ hits: 2, pageFaults: 1, fallbackTextures: 1 });
  });
});

describe("texture thrash detector", () => {
  const quiet = new Array<string>(0);

  it("flags thrashing only after the grace period and holds a cooldown", () => {
    const detector = new TextureThrashDetector({ windowFrames: 8, maxSwapsPerFrame: 2,
      graceFrames: 2, cooldownFrames: 4 });
    detector.observe(0, ["a", "b", "c"], quiet);
    expect(detector.thrashing).toBe(false);
    detector.observe(1, ["d", "e", "f"], ["a", "b", "c"]);
    expect(detector.snapshot.thrashStreak).toBe(2);
    expect(detector.thrashing).toBe(true);
    expect(detector.snapshot.cooldownRemainingFrames).toBe(4);
    // Calm frames during cooldown do not clear the flag until it expires (frames < 1 + 4).
    for (let frame = 2; frame < 5; frame++) detector.observe(frame, quiet, quiet);
    expect(detector.thrashing).toBe(true);
    detector.observe(5, quiet, quiet);
    expect(detector.thrashing).toBe(false);
    // Frame gaps are rejected so windowed statistics stay exact.
    expect(() => detector.observe(7, quiet, quiet)).toThrow(/without gaps/);
  });

  it("counts ping-pong re-admissions inside the configured window", () => {
    const detector = new TextureThrashDetector({ pingPongWindowFrames: 4 });
    detector.observe(0, quiet, ["p", "q"]);
    detector.observe(1, ["p"], quiet);
    detector.observe(2, quiet, ["p"]);
    detector.observe(3, ["p"], quiet);
    expect(detector.snapshot.pingPongCount).toBe(2);
    for (let frame = 4; frame <= 9; frame++) detector.observe(frame, quiet, quiet);
    detector.observe(10, ["p"], quiet);
    // The frame-2 eviction is pruned once it leaves the ping-pong window.
    expect(detector.snapshot.pingPongCount).toBe(2);
  });

  it("tracks windowed churn and rejects frame gaps and malformed ids", () => {
    const detector = new TextureThrashDetector({ windowFrames: 2 });
    detector.observe(0, ["a", "b"], ["c"]);
    detector.observe(1, ["d"], quiet);
    detector.observe(2, quiet, quiet);
    // Window (frames 1..2) retains only frame 1's single swap.
    expect(detector.snapshot.windowSwaps).toBe(1);
    expect(detector.snapshot.swapsPerFrame).toBe(0.5);
    expect(() => detector.observe(4, quiet, quiet)).toThrow(/without gaps/);
    expect(() => detector.observe(3, ["a", ""], quiet)).toThrow(/non-empty/);
    expect(() => new TextureThrashDetector({ windowFrames: 0 })).toThrow(/windowFrames/);
    expect(() => new TextureThrashDetector({ graceFrames: 0 })).toThrow(/graceFrames/);
    expect(() => new TextureThrashDetector({ maxSwapsPerFrame: -1 })).toThrow(/maxSwapsPerFrame/);
  });
});
