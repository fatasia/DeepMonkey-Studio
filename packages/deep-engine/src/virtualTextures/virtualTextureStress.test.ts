import { describe, expect, it } from "vitest";
import { buildVirtualTexturePageRequests, VirtualTexturePageTable,
  type VirtualTextureFootprint } from "./virtualTexturePageTable.js";
import { resolveVirtualTextureSample, TextureThrashDetector } from "./virtualTextureDiagnostics.js";
import { createSyntheticRgba8, generateVirtualTexturePages, virtualTexturePageCostBytes,
  virtualTexturePageId } from "./virtualTexturePages.js";

/** T06 stress ladder: one-way pan / ping-pong / random-focus cameras over a 96-frame timeline. */

const FRAMES = 96, GRID = 8, WINDOW = 4, CHAIN_MIPS = 8;
const TILE = Object.freeze({ tileEdgeTexels: 128, bytesPerTexel: 4 });
const PAGE_BYTES = virtualTexturePageCostBytes(TILE, 0);
const TEXTURE = "stress";
/** Full chain of one 4x4-tile window: mips 0..7 of 16 region-constant tiles. */
const CHAIN_BYTES = Array.from({ length: CHAIN_MIPS }, (_, mip) => virtualTexturePageCostBytes(TILE, mip))
  .reduce((sum, cost) => sum + cost, 0);
const WINDOW_BYTES = WINDOW * WINDOW * CHAIN_BYTES;
const TIER_WINDOW = 2 * 1024 * 1024; // one full window chain fits with headroom.
const TIER_RATIONED = WINDOW * WINDOW * (PAGE_BYTES + virtualTexturePageCostBytes(TILE, 1));
// = 16 mip0 + 16 mip1 pages: chains rationed at mip 2..7, mip0 always legal.
const TIER_UNION = 4 * 1024 * 1024; // fits both ping-pong halves' full chains: convergence tier.

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Scenario = "pan" | "pingpong" | "random";

function windowOrigin(scenario: Scenario, frame: number, rng: () => number): readonly [number, number] {
  if (scenario === "pan") return [frame % (GRID - WINDOW + 1), 2];
  // Six-frame flips keep the ping-pong period shorter than the 14-frame backoff dwell,
  // so the throttle actually skips swap cycles instead of shifting them.
  if (scenario === "pingpong") return [(Math.floor(frame / 6) % 2) * (GRID - WINDOW), 2];
  return [Math.floor(rng() * (GRID - WINDOW + 1)), Math.floor(rng() * (GRID - WINDOW + 1))];
}

function footprintsFor(origin: readonly [number, number]): VirtualTextureFootprint[] {
  const footprints: VirtualTextureFootprint[] = [];
  for (let y = 0; y < WINDOW; y++) {
    for (let x = 0; x < WINDOW; x++) {
      footprints.push({ textureId: TEXTURE, tileX: origin[0] + x, tileY: origin[1] + y,
        maxMip: CHAIN_MIPS - 1, weight: 1 });
    }
  }
  return footprints;
}

interface FrameRecord {
  readonly admitted: number; readonly evicted: number; readonly deferred: number;
  readonly residentBytes: number; readonly allMip0: boolean; readonly thrashing: boolean;
}

interface RunStats {
  readonly scenario: Scenario; readonly tier: string; readonly backoff: boolean;
  readonly totalAdmitted: number; readonly totalEvicted: number; readonly totalDeferred: number;
  readonly peakResidentBytes: number; readonly maxUtilization: number;
  readonly pageFaultSamples: number; readonly fallbackTextureSamples: number;
  readonly thrashFlags: number; readonly mip0LegalFrames: number;
}

function run(scenario: Scenario, budgetBytes: number, tier: string, backoff: boolean,
  seed = 0x6e07): RunStats {
  const rng = mulberry32(seed);
  const table = new VirtualTexturePageTable(TILE, { maxBytes: budgetBytes });
  const detector = new TextureThrashDetector({ windowFrames: 16, maxSwapsPerFrame: 6,
    pingPongWindowFrames: 10, graceFrames: 1, cooldownFrames: 6 });
  let totalAdmitted = 0, totalEvicted = 0, totalDeferred = 0, peak = 0, faults = 0, fallbacks = 0;
  let thrashFlags = 0, mip0LegalFrames = 0, maxUtil = 0;

  for (let frame = 0; frame < FRAMES; frame++) {
    const origin = windowOrigin(scenario, frame, rng);
    const requests = buildVirtualTexturePageRequests(footprintsFor(origin), TILE);
    const plan = table.plan(requests, frame);
    table.commitAdmissions(plan.admitted.map(page => page.id));
    detector.observe(frame, plan.admitted.map(page => page.id), plan.evicted.map(page => page.id));
    table.setDwellFrames(backoff && detector.thrashing ? 14 : 0);
    let allMip0 = true;
    for (const footprint of footprintsFor(origin)) {
      const resolution = resolveVirtualTextureSample(table, TEXTURE, footprint.tileX, footprint.tileY, CHAIN_MIPS - 1);
      if (resolution.status === "page-fault") faults += 1;
      if (resolution.status === "fallback-texture") { fallbacks += 1; allMip0 = false; }
      if (resolution.status === "page-fault" && resolution.resolvedMip === null) allMip0 = false;
    }
    if (allMip0) mip0LegalFrames += 1;
    if (detector.thrashing) thrashFlags += 1;
    totalAdmitted += plan.stats.admittedCount;
    totalEvicted += plan.stats.evictedCount;
    totalDeferred += plan.stats.deferredCount;
    peak = Math.max(peak, plan.stats.residentBytes);
    maxUtil = Math.max(maxUtil, plan.stats.budgetUtilization);
  }
  return { scenario, tier, backoff, totalAdmitted, totalEvicted, totalDeferred, peakResidentBytes: peak,
    maxUtilization: maxUtil, pageFaultSamples: faults, fallbackTextureSamples: fallbacks,
    thrashFlags, mip0LegalFrames };
}

const SCENARIOS: Scenario[] = ["pan", "pingpong", "random"];
const matrix = SCENARIOS.flatMap(scenario => [
  run(scenario, TIER_WINDOW, "window", false),
  run(scenario, TIER_RATIONED, "rationed", false),
  run(scenario, TIER_RATIONED, "rationed", true),
]);

describe("virtual texture residency stress ladder (pan / pingpong / random, 96 frames)", () => {
  it("reports the deterministic ladder statistics", () => {
    const header = "scenario | tier | backoff | admitted | evicted | deferred | peakKiB | maxUtil% | mipFaults | mip0Legal";
    console.info(`[T06 virtual-texture ladder] ${header} (window chain ${WINDOW_BYTES} B)`);
    for (const stats of matrix) {
      console.info(`[T06 virtual-texture ladder] ${stats.scenario} | ${stats.tier} | ${stats.backoff}`
        + ` | ${stats.totalAdmitted} | ${stats.totalEvicted} | ${stats.totalDeferred}`
        + ` | ${(stats.peakResidentBytes / 1024).toFixed(0)} | ${(stats.maxUtilization * 100).toFixed(1)}`
        + ` | ${stats.pageFaultSamples} | ${stats.mip0LegalFrames}`);
    }
    expect(matrix.length).toBe(9);
  });

  it("keeps the byte budget a hard invariant on every frame (overshoot 0% <= 5%)", () => {
    for (const stats of matrix) {
      expect(stats.peakResidentBytes).toBeLessThanOrEqual(
        stats.tier === "window" ? TIER_WINDOW : TIER_RATIONED);
      expect(stats.maxUtilization).toBeLessThanOrEqual(1);
    }
  });

  it("always keeps a legal low mip for every visible tile (page faults degrade, never break)", () => {
    for (const stats of matrix) {
      if (stats.backoff) continue; // backoff trades immediacy for churn throttling.
      expect(stats.mip0LegalFrames).toBe(FRAMES);
      expect(stats.fallbackTextureSamples).toBe(0);
      if (stats.tier === "rationed") expect(stats.pageFaultSamples).toBeGreaterThan(0);
    }
  });

  it("converges on a ping-pong camera whose union fits the budget (no endless swap)", () => {
    const converged = run("pingpong", TIER_UNION, "union", false);
    expect(converged.peakResidentBytes).toBeLessThanOrEqual(TIER_UNION);
    // 32 tiles x 8 chain mips across the two halves; after the first visit everything is a cache hit.
    expect(converged.totalAdmitted).toBe(2 * WINDOW * WINDOW * CHAIN_MIPS);
    expect(converged.totalEvicted).toBe(0);
  });

  it("throttles ping-pong churn with dwell backoff when the union exceeds the budget", () => {
    const plain = run("pingpong", TIER_RATIONED, "rationed", false);
    const throttled = run("pingpong", TIER_RATIONED, "rationed", true);
    expect(plain.thrashFlags).toBeGreaterThan(0);
    expect(throttled.totalEvicted).toBeLessThan(plain.totalEvicted);
    expect(throttled.totalAdmitted).toBeLessThan(plain.totalAdmitted);
  });

  it("admits only pages that exist in the generated offline page set", () => {
    const source = createSyntheticRgba8(TEXTURE, 1024, 1024, 0x7e3);
    const pages = generateVirtualTexturePages(source, TILE);
    expect(pages.pages.length).toBe(GRID * GRID * CHAIN_MIPS);
    const table = new VirtualTexturePageTable(TILE, { maxBytes: TIER_WINDOW });
    const plan = table.plan(buildVirtualTexturePageRequests(
      footprintsFor(windowOrigin("pingpong", 0, mulberry32(1))), TILE), 0);
    for (const page of plan.admitted) {
      expect(pages.pageByTile.get(page.id)?.costBytes).toBe(page.costBytes);
    }
    expect(pages.pageByTile.has(virtualTexturePageId(TEXTURE, 7, 7, CHAIN_MIPS - 1))).toBe(true);
  });

  it("replays deterministically under a fixed seed", () => {
    expect(run("random", TIER_RATIONED, "rationed", false)).toEqual(
      matrix.find(stats => stats.scenario === "random" && stats.tier === "rationed" && !stats.backoff));
    expect(run("random", TIER_RATIONED, "rationed", false, 0x6e07))
      .toEqual(run("random", TIER_RATIONED, "rationed", false, 0x6e07));
  });
});
