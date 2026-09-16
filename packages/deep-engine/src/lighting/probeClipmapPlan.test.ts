import { describe, expect, it } from "vitest";
import {
  DEEP_GI_DEFAULT_ESTIMATED_BYTES,
  DEEP_GI_DEFAULT_PROBE_COUNT,
  planIrradianceProbeClipmap,
  probeClipmapOptionsForQuality,
  type ProbeClipmapHistory,
  type ProbeClipmapRequest,
} from "./probeClipmapPlan.js";

const fullScene = { min: [-1_000, -1_000, -1_000], max: [1_000, 1_000, 1_000] } as const;
const request = (change: Partial<ProbeClipmapRequest> = {}): ProbeClipmapRequest => ({
  cameraPosition: [0, 0, 0], sceneBounds: fullScene, ...change,
});
const settled = (source: ReturnType<typeof planIrradianceProbeClipmap>): ProbeClipmapHistory => ({
  profileKey: source.history.profileKey, origins: source.history.origins, pending: [],
});
const addresses = (source: ReturnType<typeof planIrradianceProbeClipmap>) =>
  source.updates.map(value => [value.reason, value.level, ...value.cell]);

describe("Deep GI Lite irradiance-probe clipmap planning", () => {
  it("maps production quality presets to bounded plans", () => {
    const make = (quality: "performance" | "balanced" | "quality") => planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0], sceneBounds: null, options: probeClipmapOptionsForQuality(quality) });
    expect(make("performance").profile.updateBudget).toBe(32);
    expect(make("balanced").profile.updateBudget).toBe(64);
    expect(make("quality").profile.updateBudget).toBe(128);
    expect(make("quality").profile.levelCount).toBeGreaterThan(make("balanced").profile.levelCount);
    expect(() => probeClipmapOptionsForQuality("invalid" as never)).toThrow("Invalid Deep GI quality");
  });
  it("publishes an exact bounded default profile and deterministic initial budget", () => {
    const first = planIrradianceProbeClipmap(request()), second = planIrradianceProbeClipmap(request());
    expect(first.profile).toMatchObject({ levelCount: 3, gridSize: [16, 8, 16],
      baseSpacing: 2, spacingScale: 2, updateBudget: 64,
      probeCount: DEEP_GI_DEFAULT_PROBE_COUNT, probeStorageBytes: 589_824,
      updateListBytes: 1_024, levelMetadataBytes: 192,
      estimatedBytes: DEEP_GI_DEFAULT_ESTIMATED_BYTES, degraded: false, degradationReasons: [] });
    expect(first.levels.map(level => ({ spacing: level.spacing, origin: level.origin, max: level.max }))).toEqual([
      { spacing: 2, origin: [-16, -8, -16], max: [14, 6, 14] },
      { spacing: 4, origin: [-32, -16, -32], max: [28, 12, 28] },
      { spacing: 8, origin: [-64, -32, -64], max: [56, 24, 56] },
    ]);
    expect(first.updates).toHaveLength(64); expect(first.deferred).toHaveLength(6_080);
    expect(first.updates.every(update => update.reason === "initial" && update.level === 0)).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("carries deferred work without duplicates and keeps the fixed frame budget", () => {
    const first = planIrradianceProbeClipmap(request());
    const next = planIrradianceProbeClipmap(request({ previous: first.history }));
    expect(next.updates).toHaveLength(64); expect(next.deferred).toHaveLength(6_016);
    expect(next.updates.every(update => update.reason === "pending")).toBe(true);
    const consumed = new Set(first.updates.map(update => `${update.level}:${update.cell.join(":")}`));
    expect(next.updates.every(update => !consumed.has(`${update.level}:${update.cell.join(":")}`))).toBe(true);
  });

  it("snaps origins and emits only a newly exposed slab after crossing a fine cell", () => {
    const initial = planIrradianceProbeClipmap(request()), previous = settled(initial);
    const subCell = planIrradianceProbeClipmap(request({ cameraPosition: [0.9, 0.9, 0.9], previous }));
    expect(subCell.levels.map(level => level.originCell)).toEqual(initial.levels.map(level => level.originCell));
    expect(subCell.updates).toHaveLength(0); expect(subCell.deferred).toHaveLength(0);

    const crossed = planIrradianceProbeClipmap(request({ cameraPosition: [1.01, 0, 0], previous }));
    expect(crossed.levels[0]!.originCell).toEqual([-7, -4, -8]);
    expect(crossed.updates).toHaveLength(64); expect(crossed.deferred).toHaveLength(64);
    expect([...crossed.updates, ...crossed.deferred].every(update =>
      update.reason === "scroll" && update.level === 0 && update.cell[0] === 8)).toBe(true);
  });

  it("maps dirty AABBs to every level, deduplicates overlap and ranks fine probes first", () => {
    const initial = planIrradianceProbeClipmap(request()), previous = settled(initial);
    const point = { min: [0, 0, 0], max: [0, 0, 0] } as const;
    const plan = planIrradianceProbeClipmap(request({ previous, dirtyBounds: [point, point],
      options: { updateBudget: 2 } }));
    expect(addresses(plan)).toEqual([["dirty", 0, 0, 0, 0], ["dirty", 1, 0, 0, 0]]);
    expect(plan.deferred.map(value => [value.reason, value.level, ...value.cell]))
      .toEqual([["dirty", 2, 0, 0, 0]]);
    expect(plan.updates.map(value => value.linearIndex)).toEqual([1_096, 1_096]);
  });

  it("uses stable distance and cell ordering independent of dirty input order", () => {
    const first = planIrradianceProbeClipmap(request()), previous = settled(first);
    const left = { min: [-2, 0, 0], max: [-2, 0, 0] } as const;
    const right = { min: [2, 0, 0], max: [2, 0, 0] } as const;
    const a = planIrradianceProbeClipmap(request({ previous, dirtyBounds: [right, left] }));
    const b = planIrradianceProbeClipmap(request({ previous, dirtyBounds: [left, right] }));
    expect(addresses(a)).toEqual(addresses(b));
    expect(addresses(a).slice(0, 2)).toEqual([
      ["dirty", 0, -1, 0, 0], ["dirty", 0, 1, 0, 0],
    ]);
  });

  it("degrades level count deterministically against device and memory ceilings", () => {
    const full = planIrradianceProbeClipmap(request({ options: { levelCount: 4 } }));
    expect(full.profile).toMatchObject({ levelCount: 4, probeCount: 8_192,
      estimatedBytes: 787_712, degraded: false });
    const deviceLimited = planIrradianceProbeClipmap(request({ options: { levelCount: 3 }, capacity: {
      maxBufferSize: 400_000, maxStorageBufferBindingSize: 400_000,
    } }));
    expect(deviceLimited.profile).toMatchObject({ levelCount: 2, probeCount: 4_096,
      estimatedBytes: 394_368, degraded: true, degradationReasons: ["level-count:3->2"] });
    const memoryLimited = planIrradianceProbeClipmap(request({ options: {
      levelCount: 4, memoryBudgetBytes: 600_000,
    } }));
    expect(memoryLimited.profile).toMatchObject({ levelCount: 3,
      estimatedBytes: DEEP_GI_DEFAULT_ESTIMATED_BYTES,
      degraded: true, degradationReasons: ["level-count:4->3"] });
  });

  it("handles a known-empty scene without scheduling meaningless work", () => {
    const plan = planIrradianceProbeClipmap(request({ sceneBounds: null,
      dirtyBounds: [{ min: [0, 0, 0], max: [1, 1, 1] }] }));
    expect(plan.sceneEmpty).toBe(true); expect(plan.updates).toEqual([]); expect(plan.deferred).toEqual([]);
    expect(plan.profile.probeCount).toBe(DEEP_GI_DEFAULT_PROBE_COUNT);
  });

  it("fails closed on invalid worlds, excessive work and insufficient capacity", () => {
    expect(() => planIrradianceProbeClipmap(request({ cameraPosition: [Number.NaN, 0, 0] }))).toThrow("cameraPosition[0]");
    expect(() => planIrradianceProbeClipmap(request({ cameraPosition: [1_000_000_001, 0, 0] }))).toThrow("cameraPosition[0]");
    expect(() => planIrradianceProbeClipmap(request({ cameraPosition: [1_000_000_000, 0, 0],
      options: { baseSpacing: 0.01 } }))).toThrow("packed int32 range");
    expect(() => planIrradianceProbeClipmap(request({ sceneBounds: {
      min: [1, 0, 0], max: [0, 1, 1],
    } }))).toThrow("min must not exceed max");
    expect(() => planIrradianceProbeClipmap(request({ options: { gridSize: [64, 64, 64] } })))
      .toThrow("at least two probe clipmap levels");
    expect(() => planIrradianceProbeClipmap(request({ options: { levelCount: 1 } }))).toThrow("options.levelCount");
    expect(() => planIrradianceProbeClipmap(request({ options: { levelCount: 5 } }))).toThrow("options.levelCount");
    expect(() => planIrradianceProbeClipmap(request({ capacity: {
      maxBufferSize: 393_215, maxStorageBufferBindingSize: 393_215,
    } }))).toThrow("at least two probe clipmap levels");
    const tooMany = Array.from({ length: 65 }, () => ({ min: [0, 0, 0], max: [0, 0, 0] } as const));
    expect(() => planIrradianceProbeClipmap(request({ dirtyBounds: tooMany }))).toThrow("limit 64 exceeded");
  });
});
