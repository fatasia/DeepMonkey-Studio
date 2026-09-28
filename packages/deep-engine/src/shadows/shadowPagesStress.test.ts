import { describe, expect, it } from "vitest";
import { ShadowPageTable, buildShadowPageRequests,
  pageId, type ShadowResidencyPlan } from "./shadowPages.js";

/** T04 stress ladder: 64/256/1024 shadowed lights over a deterministic 96-frame timeline. */

const FRAMES = 96, EVENT_START = 40, EVENT_END = 60, CAMERA_CUT = 80;
const BUDGET_BYTES = 64 * 1024 * 1024;
const TIERS = [64, 256, 1024] as const;
const SEED = 0x5ea0;
/** 128px pages keep the 64-light tier fully resident (with mip refinement) under 64 MiB,
 * while 256/1024 lights exercise chain rationing and eviction. */
const STRESS_TILE = Object.freeze({ tileEdgeTexels: 128, depthBytesPerTexel: 4 });

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimulatedLight {
  readonly key: string;
  readonly kind: "point" | "spot";
  readonly x: number; readonly y: number; readonly z: number;
  readonly intensity: number;
  readonly moving: boolean;
  readonly phase: number;
}

function buildLights(count: number, rng: () => number): SimulatedLight[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `l${index}`,
    kind: rng() < 0.8 ? "point" as const : "spot" as const,
    x: (rng() * 2 - 1) * 24, y: (rng() * 2 - 1) * 14, z: -2 - rng() * 38,
    intensity: 0.5 + rng() * 7.5, moving: rng() < 0.1, phase: rng() * Math.PI * 2,
  }));
}

interface TierStats {
  readonly lightCount: number;
  readonly totalRequests: number;
  readonly totalAdmitted: number;
  readonly totalEvicted: number;
  readonly totalDeferred: number;
  readonly peakResidentPages: number;
  readonly peakResidentBytes: number;
  readonly frozenFrames: number;
}

function assertInvariants(plan: ShadowResidencyPlan): void {
  expect(plan.stats.residentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
  expect(plan.stats.residentBytes).toBe(plan.resident.reduce((sum, page) => sum + page.costBytes, 0));
  const resident = new Set(plan.resident.map(page => page.id));
  for (const page of plan.resident) {
    for (let level = 0; level < page.mip; level++) {
      expect(resident.has(pageId(page.lightKey, page.face, level))).toBe(true);
    }
  }
  const deferred = new Set(plan.deferred.map(page => page.id));
  for (const page of plan.deferred) expect(resident.has(page.id)).toBe(false);
  expect(plan.admitted.length + plan.resident.length + plan.evicted.length)
    .toBeGreaterThanOrEqual(plan.stats.requestCount - deferred.size);
}

function simulate(lightCount: number): TierStats {
  const rng = mulberry32(SEED + lightCount);
  const lights = buildLights(lightCount, rng);
  const table = new ShadowPageTable(STRESS_TILE, { maxBytes: BUDGET_BYTES });
  let totalRequests = 0, totalAdmitted = 0, totalEvicted = 0, totalDeferred = 0;
  let peakResidentPages = 0, peakResidentBytes = 0, frozenFrames = 0;

  for (let frame = 0; frame < FRAMES; frame++) {
    const camera: readonly [number, number] = frame >= CAMERA_CUT ? [30, 0] : [0, 0];
    const event = frame >= EVENT_START && frame < EVENT_END;
    // Moving lights stop casting during the event window so the sweep path is exercised.
    const requests = buildShadowPageRequests(lights.flatMap(light => {
      if (light.moving && event) return [];
      const x = light.moving ? light.x + 0.5 * Math.sin(light.phase + frame * 0.2) : light.x;
      const dx = x - camera[0], dy = light.y - camera[1];
      const distanceSquared = dx * dx + dy * dy + light.z * light.z;
      const importance = light.intensity * 8 / (8 + distanceSquared);
      const mipLevels = importance > 1.2 ? 3 : importance > 0.5 ? 2 : 1;
      return [{ key: light.key, kind: light.kind, importance, mipLevels }];
    }), STRESS_TILE);
    const plan = table.plan(requests, frame);
    assertInvariants(plan);
    totalRequests += plan.stats.requestCount;
    totalAdmitted += plan.stats.admittedCount;
    totalEvicted += plan.stats.evictedCount;
    totalDeferred += plan.stats.deferredCount;
    peakResidentPages = Math.max(peakResidentPages, plan.stats.residentCount);
    peakResidentBytes = Math.max(peakResidentBytes, plan.stats.residentBytes);
    if (!event && frame !== CAMERA_CUT && plan.stats.admittedCount === 0 && plan.stats.evictedCount === 0) frozenFrames++;
  }
  return { lightCount, totalRequests, totalAdmitted, totalEvicted, totalDeferred,
    peakResidentPages, peakResidentBytes, frozenFrames };
}

describe("virtual shadow paging stress ladder (64/256/1024 lights, 96 frames, 64 MiB budget)", () => {
  const results = TIERS.map(simulate);

  it("reports the deterministic ladder statistics", { timeout: 120_000 }, () => {
    const header = "lights | requests | admitted | evicted | deferred | peakPages | peakMiB | frozenFrames";
    console.info(`[T04 shadow-pages ladder] ${header}`);
    for (const stats of results) {
      console.info(`[T04 shadow-pages ladder] ${stats.lightCount} | ${stats.totalRequests} | ${stats.totalAdmitted}`
        + ` | ${stats.totalEvicted} | ${stats.totalDeferred} | ${stats.peakResidentPages}`
        + ` | ${(stats.peakResidentBytes / (1024 * 1024)).toFixed(1)} | ${stats.frozenFrames}`);
    }
    expect(results.map(stats => stats.lightCount)).toEqual([64, 256, 1024]);
  });

  it("keeps every frame inside the hard byte budget with frozen-frame stability", { timeout: 120_000 }, () => {
    for (const stats of results) {
      expect(stats.peakResidentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
      // Guaranteed frozen: frames 1-39, 61-79 and 81-95 (frame 0 admits the warm set,
      // frame 60 may re-admit demoted event pages, frame 80 is the camera cut).
      expect(stats.frozenFrames).toBeGreaterThanOrEqual(73);
      expect(stats.frozenFrames).toBeLessThanOrEqual(FRAMES - (EVENT_END - EVENT_START) - 1);
    }
  });

  it("scales request volume with the light count and grows deferrals under the fixed budget", { timeout: 60_000 }, () => {
    expect(results[1]!.totalRequests).toBeGreaterThan(results[0]!.totalRequests);
    expect(results[2]!.totalRequests).toBeGreaterThan(results[1]!.totalRequests);
    expect(results[2]!.totalDeferred).toBeGreaterThan(results[1]!.totalDeferred);
    expect(results[1]!.totalDeferred).toBeGreaterThanOrEqual(results[0]!.totalDeferred);
  });

  it("exercises the eviction and re-admission paths and refines mips when budget allows", { timeout: 60_000 }, () => {
    for (const stats of results) {
      // Every tier has moving lights toggling off during the event and a camera cut at frame 80.
      expect(stats.totalEvicted).toBeGreaterThan(0);
      expect(stats.totalAdmitted).toBeGreaterThan(0);
    }
    // 64 lights fit their whole mip0 working set under the budget, so refinement succeeds.
    expect(results[0]!.peakResidentBytes).toBeLessThan(BUDGET_BYTES);
    expect(results[0]!.totalDeferred).toBe(0);
  });

  it("is deterministic under a fixed seed", { timeout: 120_000 }, () => {
    const replay = simulate(1024);
    expect(replay).toEqual(results[2]);
  });
});
