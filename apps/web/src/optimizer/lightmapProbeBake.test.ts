import { Document } from "@gltf-transform/core";
import type { ProbeAabb } from "@bim-studio/deep-engine";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { describe, expect, it } from "vitest";
import { bakePreparedProbeRegion, prepareProbeBake, probeRegionStateHash, type ProbeBakeOptions } from "./lightmapProbeBaker";
import { IncrementalProbeBaker, type IncrementalProbeBakeResult } from "./lightmapProbeIncremental";
import { PROBE_BAKE_MAX_DIRTY_BOUNDS, convergeDirtyBounds, dirtyBoundsFromLightDelta, expandProbeAabb,
  lightInfluenceAabb, planProbeGrid, regionsAffectedByBounds } from "./lightmapProbeRegions";
import type { BakeLightState } from "./modelOptimizer";
import { giFixture } from "../../scripts/gi-bake-fixture";

const lamp = (position: [number, number, number], overrides: Partial<BakeLightState> = {}): BakeLightState => ({
  id: "lamp", name: "点光", type: "point", enabled: true, color: "#ffffff", intensity: 3,
  direction: [0, 1, 0], position, range: 0.8, ...overrides,
});
const sun = (overrides: Partial<BakeLightState> = {}): BakeLightState => ({
  id: "sun", name: "主光", type: "directional", enabled: true, color: "#ffffff", intensity: 1.2,
  direction: [0.4, 0.8, 0.3], position: [0, 0, 0], range: 100, ...overrides,
});
const options = (lights: BakeLightState[], quality: ProbeBakeOptions["quality"] = "performance"): ProbeBakeOptions =>
  ({ quality, lights, ambient: 0.08, ambientColor: "#1a1a22" });

/** giFixture 的固定包围盒(floor 4x4、墙高 3),显式给出避免测试依赖 prepare 的内部计算。 */
const fixtureBounds: ProbeAabb = { min: [-2, 0, -2], max: [2, 3, 2] };

function byteHash(records: Float32Array): string {
  return sha256Bytes(new Uint8Array(records.buffer, records.byteOffset, records.byteLength));
}

function stateByRegion(result: IncrementalProbeBakeResult): Map<string, string> {
  return new Map(result.regions.map(region => [region.key, region.stateHash]));
}

function hashByRegion(result: IncrementalProbeBakeResult): Map<string, string> {
  return new Map(result.regions.map(region => [region.key, byteHash(region.records)]));
}

function regionKeyContaining(quality: ProbeBakeOptions["quality"], position: [number, number, number]): string {
  const plan = planProbeGrid(fixtureBounds, quality);
  const region = plan.regions.find(item => item.min.every((value, axis) => value <= position[axis]!)
    && item.max.every((value, axis) => value >= position[axis]!));
  if (!region) throw new Error(`没有区域包含点 ${position.join(",")}`);
  return region.key;
}

describe("lightmapProbeRegions", () => {
  it("partitions every probe into exactly one region and keeps probes inside region bounds", () => {
    const plan = planProbeGrid(fixtureBounds, "balanced");
    const seen = new Set<number>();
    for (const region of plan.regions) {
      expect(region.probes.length).toBeGreaterThan(0);
      for (const probe of region.probes) {
        expect(seen.has(probe.linearIndex)).toBe(false);
        seen.add(probe.linearIndex);
        for (let axis = 0; axis < 3; axis += 1) {
          expect(probe.position[axis]!).toBeGreaterThanOrEqual(region.min[axis]!);
          expect(probe.position[axis]!).toBeLessThanOrEqual(region.max[axis]!);
        }
      }
    }
    expect(seen.size).toBe(plan.layout.probeCount);
  });

  it("degenerates thin axes to a single probe layer", () => {
    const plan = planProbeGrid({ min: [0, 0, 0], max: [4, 0.01, 4] }, "balanced");
    expect(plan.layout.gridCount[1]).toBe(1);
    expect(plan.layout.gridCount[0]).toBeGreaterThan(1);
  });

  it("derives point light influence as clamped range box and directional as whole scene", () => {
    const scene: ProbeAabb = { min: [0, 0, 0], max: [10, 10, 10] };
    expect(lightInfluenceAabb(lamp([13, 5, 5], { range: 2 }), scene)).toBeNull();
    const inside = lightInfluenceAabb(lamp([8, 5, 5], { range: 3 }), scene)!;
    expect([...inside.min]).toEqual([5, 2, 2]);
    expect([...inside.max]).toEqual([10, 8, 8]);
    expect(lightInfluenceAabb(sun(), scene)).toEqual(scene);
  });

  it("derives dirty bounds from light deltas and converges beyond the GI dirty limit", () => {
    const scene: ProbeAabb = { min: [0, 0, 0], max: [10, 10, 10] };
    expect(dirtyBoundsFromLightDelta([lamp([1, 1, 1])], [lamp([1, 1, 1])], scene)).toHaveLength(0);
    const moved = dirtyBoundsFromLightDelta([lamp([1, 1, 1])], [lamp([3, 1, 1])], scene);
    expect(moved).toHaveLength(2);
    // 移除点灯 + 新增方向灯 = 两条脏域
    expect(dirtyBoundsFromLightDelta([lamp([1, 1, 1])], [sun()], scene)).toHaveLength(2);
    // 双方都处于禁用态的灯不派生脏域
    expect(dirtyBoundsFromLightDelta(
      [lamp([1, 1, 1], { enabled: false, color: "#ffffff" })],
      [lamp([1, 1, 1], { enabled: false, color: "#00ff00" })], scene,
    )).toHaveLength(0);
    const many = Array.from({ length: PROBE_BAKE_MAX_DIRTY_BOUNDS + 1 },
      (): ProbeAabb => ({ min: [0, 0, 0], max: [1, 1, 1] }));
    expect(convergeDirtyBounds(many, scene)).toEqual([scene]);
    expect(convergeDirtyBounds(many.slice(0, PROBE_BAKE_MAX_DIRTY_BOUNDS), scene)).toHaveLength(PROBE_BAKE_MAX_DIRTY_BOUNDS);
    const expanded = expandProbeAabb(moved[0]!, 2);
    expect([...expanded.min]).toEqual([moved[0]!.min[0]! - 2, moved[0]!.min[1]! - 2, moved[0]!.min[2]! - 2]);
  });

  it("throws on non-finite light state (fail closed)", () => {
    const scene: ProbeAabb = { min: [0, 0, 0], max: [10, 10, 10] };
    expect(() => lightInfluenceAabb(lamp([Number.NaN, 1, 1]), scene)).toThrow(RangeError);
  });
});

describe("probe baking kernel", () => {
  it("throws on scenes without bakeable triangles", async () => {
    const document = new Document();
    await expect(prepareProbeBake(document, options([sun()]))).rejects.toThrow("模型没有可用于探针烘焙");
  });

  it("bakes higher direct irradiance with lights on than lights off", async () => {
    const lampPosition: [number, number, number] = [1.5, 1.2, 1.5];
    const prepared = await prepareProbeBake(giFixture(), options([lamp(lampPosition)]));
    try {
      const key = regionKeyContaining("performance", lampPosition);
      const region = prepared.plan.regions.find(item => item.key === key)!;
      const lit = bakePreparedProbeRegion(prepared, region, [lamp(lampPosition)]);
      const dark = bakePreparedProbeRegion(prepared, region, []);
      const directSum = (records: Float32Array) => {
        let sum = 0;
        for (let base = 0; base < records.length; base += 8) sum += records[base]! + records[base + 1]! + records[base + 2]!;
        return sum;
      };
      expect(directSum(lit.records)).toBeGreaterThan(directSum(dark.records));
      expect(lit.records[7]).toBe(1);
    } finally {
      prepared.dispose();
    }
  });

  it("produces identical region hashes and bytes across independent preparations", async () => {
    const lights = [lamp([1.5, 1.2, 1.5]), sun()];
    const first = await prepareProbeBake(giFixture(), options(lights));
    const second = await prepareProbeBake(giFixture(), options(lights));
    try {
      expect(second.plan.layout.layoutKey).toBe(first.plan.layout.layoutKey);
      for (const region of first.plan.regions) {
        const left = bakePreparedProbeRegion(first, region, lights);
        const right = bakePreparedProbeRegion(second, second.plan.regions.find(item => item.key === region.key)!, lights);
        expect(right.stateHash).toBe(left.stateHash);
        expect(byteHash(right.records)).toBe(byteHash(left.records));
      }
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("changes the state hash when lights change but not for a disabled light's color", async () => {
    const prepared = await prepareProbeBake(giFixture(), options([lamp([1.8, 1, 1.8], { range: 6 })]));
    try {
      const region = prepared.plan.regions[0]!;
      const active = probeRegionStateHash(prepared, region, [lamp([1.8, 1, 1.8], { range: 6 })]);
      const moved = probeRegionStateHash(prepared, region, [lamp([0.4, 0.6, 0.4], { range: 6 })]);
      const recolored = probeRegionStateHash(prepared, region, [lamp([1.8, 1, 1.8], { range: 6, color: "#ff8800" })]);
      const disabledWhite = probeRegionStateHash(prepared, region, [lamp([1.8, 1, 1.8], { range: 6, enabled: false })]);
      const disabledRecolored = probeRegionStateHash(prepared, region, [lamp([1.8, 1, 1.8], { range: 6, enabled: false, color: "#ff8800" })]);
      expect(moved.hash).not.toBe(active.hash);
      expect(recolored.hash).not.toBe(active.hash);
      // 禁用灯不参与哈希:改色前后一致,且与激活态不同(等效无灯)
      expect(disabledRecolored.hash).toBe(disabledWhite.hash);
      expect(disabledRecolored.hash).not.toBe(active.hash);
      expect(probeRegionStateHash(prepared, region, [lamp([1.8, 1, 1.8], { range: 6 })]).hash).toBe(active.hash);
    } finally {
      prepared.dispose();
    }
  });
});

describe("IncrementalProbeBaker", () => {
  const lightsA = [lamp([1.8, 1, 1.8]), sun()];
  const lightsB = [lamp([-1.8, 1, -1.8]), sun()];

  it("reuses unchanged regions byte-identically and rebakes only affected ones", async () => {
    const baker = new IncrementalProbeBaker();
    const step1 = await baker.bake(giFixture(), options(lightsA));
    expect(step1.regionsRebaked).toBe(step1.regionCount);
    const step2 = await baker.bake(giFixture(), options(lightsB));
    expect(step2.regionsRebaked).toBe(2);
    expect(step2.regionsReused).toBe(step2.regionCount - 2);
    const step1States = stateByRegion(step1);
    const step1Bytes = hashByRegion(step1);
    for (const region of step2.regions) {
      if (region.decision === "reused") {
        expect(region.stateHash).toBe(step1States.get(region.key));
        expect(byteHash(region.records)).toBe(step1Bytes.get(region.key));
      } else {
        expect(region.stateHash).not.toBe(step1States.get(region.key));
      }
    }
    const step3 = await baker.bake(giFixture(), options(lightsA));
    expect(step3.regionsRebaked).toBe(2);
    for (const region of step3.regions) {
      expect(region.stateHash).toBe(step1States.get(region.key));
      expect(byteHash(region.records)).toBe(step1Bytes.get(region.key));
    }
  }, 30_000);

  it("matches a fresh full bake byte for byte after an incremental round trip", async () => {
    const incremental = new IncrementalProbeBaker();
    const fresh = new IncrementalProbeBaker();
    const full = await fresh.bake(giFixture(), options(lightsA));
    await incremental.bake(giFixture(), options(lightsA));
    await incremental.bake(giFixture(), options(lightsB));
    const restored = await incremental.bake(giFixture(), options(lightsA));
    expect(restored.regionsRebaked).toBeGreaterThan(0);
    const fullBytes = hashByRegion(full);
    const fullStates = stateByRegion(full);
    for (const region of restored.regions) {
      expect(region.stateHash).toBe(fullStates.get(region.key));
      expect(byteHash(region.records)).toBe(fullBytes.get(region.key));
    }
  }, 30_000);

  it("expands dirty bounds for indirect propagation so bounce-reached regions rebake", async () => {
    const baker = new IncrementalProbeBaker();
    await baker.bake(giFixture(), options(lightsA, "balanced"));
    const step = await baker.bake(giFixture(), options(lightsB, "balanced"));
    const raw = dirtyBoundsFromLightDelta(lightsA, lightsB, fixtureBounds);
    const expanded = convergeDirtyBounds(raw.map(bounds => expandProbeAabb(bounds, 1.5 * 0.8)), fixtureBounds);
    const expected = regionsAffectedByBounds(planProbeGrid(fixtureBounds, "balanced"), expanded).length;
    expect(step.regionsRebaked).toBe(expected);
    expect(expected).toBeGreaterThan(regionsAffectedByBounds(planProbeGrid(fixtureBounds, "balanced"), raw).length);
  }, 60_000);

  it("forces a rebake for external dirty bounds even when the state hash matches", async () => {
    const baker = new IncrementalProbeBaker();
    const lights = [lamp([1.8, 1, 1.8])];
    await baker.bake(giFixture(), options(lights));
    const target = planProbeGrid(fixtureBounds, "performance").regions[0]!;
    const inset = {
      min: target.min.map(value => value + 1e-4) as [number, number, number],
      max: target.max.map(value => value - 1e-4) as [number, number, number],
    };
    const step = await baker.bake(giFixture(), options(lights), [inset]);
    const forced = step.regions.find(region => region.key === target.key)!;
    expect(forced.decision).toBe("rebaked");
    expect(forced.reason).toBe("dirty-bounds");
    expect(step.regionsRebaked).toBe(1);
    expect(step.regionsReused).toBe(step.regionCount - 1);
  }, 30_000);

  it("keeps everything cached when only a disabled light changes", async () => {
    const baker = new IncrementalProbeBaker();
    await baker.bake(giFixture(), options([lamp([1.8, 1, 1.8], { enabled: false, color: "#ffffff" })]));
    const step = await baker.bake(giFixture(), options([lamp([1.8, 1, 1.8], { enabled: false, color: "#00ff00" })]));
    expect(step.regionsRebaked).toBe(0);
    expect(step.regionsReused).toBe(step.regionCount);
  }, 30_000);

  it("invalidates the whole cache when the probe layout changes", async () => {
    const baker = new IncrementalProbeBaker();
    const first = await baker.bake(giFixture(), options([sun()], "performance"));
    const second = await baker.bake(giFixture(), options([sun()], "balanced"));
    expect(second.layoutKey).not.toBe(first.layoutKey);
    expect(second.regionsReused).toBe(0);
    expect(second.regionsRebaked).toBe(second.regionCount);
  }, 30_000);
});
