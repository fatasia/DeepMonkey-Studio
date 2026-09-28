import { describe, expect, it } from "vitest";
import { enforceParticleCapacity, particleBudgetLadder, planParticleBudget } from "./particleBudget.js";

const MIB = 1024 * 1024;

describe("particleBudget hard constraints", () => {
  it("resolves the 100k tier to the next power-of-two capacity without degradation", () => {
    const plan = planParticleBudget([{ id: "ladder-0", count: 50_000 }, { id: "ladder-1", count: 50_000 }]);
    expect(plan.requestedCount).toBe(100_000);
    expect(plan.capacity).toBe(131_072);
    expect(plan.stateBytes).toBe(131_072 * 64);
    expect(plan.totalBufferBytes).toBe(plan.stateBytes * 2 + 8 + 16 * 2 + 32);
    expect(plan.degraded).toBe(false);
    expect(plan.degradation.reasons).toEqual([]);
    expect(plan.degradation.rateDiscount).toBe(1);
  });

  it("resolves the 1M tier to the engine hard cap", () => {
    const [plan] = particleBudgetLadder([1_000_000]);
    expect(plan.capacity).toBe(1_048_576);
    expect(plan.stateBytes).toBe(64 * MIB);
    expect(plan.totalBufferBytes).toBeCloseTo(128 * MIB + 72, 0);
    expect(plan.degraded).toBe(false);
  });

  it("rejects invalid requests and options", () => {
    expect(() => planParticleBudget([])).toThrow(RangeError);
    expect(() => planParticleBudget([{ id: "a", count: 0 }])).toThrow(RangeError);
    expect(() => planParticleBudget([{ id: "a", count: 1 }, { id: "a", count: 1 }])).toThrow(TypeError);
    expect(() => planParticleBudget([{ id: "a", count: 1 }], { capacityLimit: 0 })).toThrow(RangeError);
    expect(() => planParticleBudget([{ id: "a", count: 1 }], { memoryLimitBytes: 64 })).toThrow(RangeError);
  });
});

describe("particleBudget degradation ladder", () => {
  it("compresses capacity first and records the quantified reason", () => {
    const plan = planParticleBudget([{ id: "big", count: 65_536 }], { capacityLimit: 8_192 });
    expect(plan.capacity).toBe(8_192);
    expect(plan.degraded).toBe(true);
    expect(plan.degradation.reasons).toContain("capacity:65536->8192");
    expect(plan.degradation.capacityDiscount).toBeCloseTo(8_192 / 65_536, 12);
  });

  it("discounts emission rate by steady-state demand and allocates by largest remainder", () => {
    const plan = planParticleBudget([
      { id: "fire", count: 40_000, rate: 40_000, lifetime: 2 },
      { id: "smoke", count: 40_000, rate: 40_000, lifetime: 2 },
    ], { capacityLimit: 50_000 });
    expect(plan.steadyStateCount).toBe(160_000);
    expect(plan.capacity).toBe(50_000);
    expect(plan.degradation.rateDiscount).toBeCloseTo(50_000 / 160_000, 9);
    expect(plan.degradation.reasons).toContain(`emission-rate:1.000->${(50_000 / 160_000).toFixed(3)}`);
    const allocated = plan.allocations.reduce((sum, item) => sum + item.allocated, 0);
    expect(allocated).toBe(50_000);
    expect(plan.allocations.every(item => item.allocated <= item.requested)).toBe(true);
    expect(plan.allocations[0]!.allocated).toBe(25_000);
  });

  it("honors a memory budget by shrinking the capacity tier", () => {
    const plan = planParticleBudget([
      { id: "fire-a", count: 50_000 }, { id: "fire-b", count: 50_000 },
    ], { memoryLimitBytes: 16 * MIB });
    expect(plan.capacity).toBeLessThan(131_072);
    expect(plan.totalBufferBytes).toBeLessThanOrEqual(16 * MIB);
    expect(plan.stateBytes).toBe(plan.capacity * 64);
    expect(plan.degradation.reasons[0]).toMatch(/^capacity:\d+->\d+$/);
  });
});

describe("enforceParticleCapacity (shortest-lifetime-first termination)", () => {
  const active = (pairs: readonly (readonly [number, number])[]) =>
    pairs.map(([id, remainingLifetime]) => ({ id, remainingLifetime }));

  it("keeps everything when under capacity", () => {
    const outcome = enforceParticleCapacity(active([[1, 5], [2, 1]]), 8);
    expect(outcome.kept).toHaveLength(2);
    expect(outcome.terminated).toHaveLength(0);
    expect(outcome.reason).toBe("");
  });

  it("terminates the shortest remaining lifetimes first", () => {
    const outcome = enforceParticleCapacity(active([[1, 5], [2, 0.1], [3, 3], [4, 0.2]]), 2);
    expect(outcome.kept.map(item => item.id)).toEqual([1, 3]);
    expect(outcome.terminated.map(item => item.id)).toEqual([2, 4]);
    expect(outcome.reason).toBe("terminate-shortest-lived:2");
  });

  it("breaks ties by ascending id deterministically", () => {
    // 三个寿命并列的粒子按 id 升序终结(4、7 出局),寿命最长的 2 保留。
    const outcome = enforceParticleCapacity(active([[9, 1], [4, 1], [7, 1], [2, 9]]), 2);
    expect(outcome.kept.map(item => item.id)).toEqual([2, 9]);
    expect(outcome.terminated.map(item => item.id)).toEqual([4, 7]);
  });

  it("rejects malformed capacity and particles", () => {
    expect(() => enforceParticleCapacity([], 0)).toThrow(RangeError);
    expect(() => enforceParticleCapacity(active([[1, Number.NaN]]), 4)).toThrow(RangeError);
    expect(() => enforceParticleCapacity([{ id: -1, remainingLifetime: 1 }], 4)).toThrow(TypeError);
  });
});

describe("particleBudgetLadder tier table", () => {
  it("produces the recorded 100k/1M evidence rows", () => {
    const ladder = particleBudgetLadder([100_000, 1_000_000]);
    expect(ladder).toHaveLength(2);
    expect(ladder[0]!.capacity).toBe(131_072);
    expect(ladder[0]!.totalBufferBytes).toBe(131_072 * 128 + 72);
    expect(ladder[1]!.capacity).toBe(1_048_576);
    expect(ladder[1]!.totalBufferBytes).toBe(1_048_576 * 128 + 72);
    ladder.forEach(plan => expect(plan.degraded).toBe(false));
  });
});
