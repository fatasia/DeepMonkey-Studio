import { describe, expect, it } from "vitest";
import { createReferenceEmitterSeeds, particleIdHash, particleNoise, simulateEmitterStatistics,
  simulateParticleSystemStatistics, stepReferenceParticle, type ReferenceParticle } from "./particleStats.js";

const FRAME = { deltaTime: 1 / 60, drag: 0.2, acceleration: [0, -9.81, 0] as const };

describe("particleStats determinism", () => {
  it("reproduces identical statistics bitwise for the same seed", () => {
    const config = { id: "ring", preset: "expanding-ring" as const, count: 48, lifetime: 1.5,
      innerRadius: 0.5, outerRadius: 3, seed: 0x5ea0 };
    const first = simulateEmitterStatistics(config, 120, FRAME);
    const second = simulateEmitterStatistics(config, 120, FRAME);
    expect(second).toEqual(first);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("yields different fingerprints for different seeds", () => {
    const a = simulateEmitterStatistics({ id: "flow", preset: "flow-line", count: 32, lifetime: 2,
      start: [0, 0, 0], end: [4, 0, 0], seed: 1 }, 90, FRAME);
    const b = simulateEmitterStatistics({ id: "flow", preset: "flow-line", count: 32, lifetime: 2,
      start: [0, 0, 0], end: [4, 0, 0], seed: 2 }, 90, FRAME);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.emittedCount).toBe(32);
  });

  it("derives stable default seeds from emitter ids via FNV-1a", () => {
    expect(particleIdHash("fire")).toBe(particleIdHash("fire"));
    expect(particleIdHash("fire")).not.toBe(particleIdHash("smoke"));
  });

  it("keeps noise within [0,1) and matches the GPU mix chain", () => {
    for (let index = 0; index < 64; index++) {
      const value = particleNoise(0x5ea0, index);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(particleNoise(7, 0)).toBe(particleNoise(7, 0));
  });
});

describe("particleStats emission distributions", () => {
  it("reports constant lifetime and uniform speed summaries for presets", () => {
    const stats = simulateEmitterStatistics({ id: "ring", preset: "expanding-ring", count: 64,
      lifetime: 1.5, innerRadius: 0, outerRadius: 3, seed: 9 }, 30, FRAME);
    expect(stats.emittedCount).toBe(64);
    expect(stats.lifetime.mean).toBeCloseTo(1.5, 12);
    expect(stats.lifetime.min).toBeCloseTo(1.5, 12);
    expect(stats.lifetime.p95).toBeCloseTo(1.5, 12);
    // expanding-ring:每个粒子速率大小一致 = (outer-inner)/lifetime。
    const expectedSpeed = 3 / 1.5;
    expect(stats.initialSpeed.min).toBeCloseTo(expectedSpeed, 9);
    expect(stats.initialSpeed.max).toBeCloseTo(expectedSpeed, 9);
    expect(stats.deaths).toBe(0);
    expect(stats.wraps).toBeGreaterThan(0);
    expect(stats.nonFinitePurged).toBe(0);
    expect(stats.firstFrameAlive).toBe(0);
    expect(stats.lastFrameAlive).toBe(29);
  });

  it("mixes lifetime distributions across emitters at system level", () => {
    const result = simulateParticleSystemStatistics([
      { id: "a", preset: "alarm-pulse", count: 8, lifetime: 1, position: [0, 0, 0], seed: 3 },
      { id: "b", preset: "alarm-pulse", count: 8, lifetime: 3, position: [0, 0, 0], seed: 4 },
    ], 10, FRAME);
    expect(result.emittedCount).toBe(16);
    expect(result.emitters).toHaveLength(2);
    expect(result.emitters[0]!.lifetime.p50).toBeCloseTo(1, 12);
    expect(result.emitters[1]!.lifetime.p50).toBeCloseTo(3, 12);
    expect(result.fingerprint).toBe(simulateParticleSystemStatistics([
      { id: "a", preset: "alarm-pulse", count: 8, lifetime: 1, position: [0, 0, 0], seed: 3 },
      { id: "b", preset: "alarm-pulse", count: 8, lifetime: 3, position: [0, 0, 0], seed: 4 },
    ], 10, FRAME).fingerprint);
  });

  it("generates seeds whose phases match the emitter formula", () => {
    const seeds = createReferenceEmitterSeeds({ id: "flow", preset: "flow-line", count: 4,
      lifetime: 2, start: [0, 0, 0], end: [1, 0, 0], seed: 11 }, 0);
    expect(seeds).toHaveLength(4);
    seeds.forEach((seed, index) => {
      const random = particleNoise(11, index);
      const phase = (index + random * 0.5) / 4;
      expect(seed.age).toBeCloseTo(phase * 2, 12);
      expect(seed.velocity).toEqual([0.5, 0, 0]);
    });
  });
});

describe("particleStats NaN hygiene", () => {
  it("steps non-loop particles to death at end of lifetime", () => {
    const particle: ReferenceParticle = { id: 1, emitterId: "burst", position: [0, 0, 0],
      velocity: [1, 0, 0], age: 0.9, lifetime: 1, loop: false };
    const alive = stepReferenceParticle(particle, { deltaTime: 0.05 });
    expect(alive.particle?.age).toBeCloseTo(0.95, 12);
    const dead = stepReferenceParticle({ ...particle, age: 0.99 }, { deltaTime: 0.05 });
    expect(dead.particle).toBeUndefined();
    expect(dead.nonFinite).toBe(false);
  });

  it("wraps looping particles by exact cycle subtraction", () => {
    const particle: ReferenceParticle = { id: 2, emitterId: "loop", position: [0, 0, 0],
      velocity: [1, 0, 0], age: 0.9, lifetime: 1, loop: true };
    // dt 上限 0.25 与 GPU 帧打包口径一致。
    const outcome = stepReferenceParticle(particle, { deltaTime: 0.25, drag: 0 });
    expect(outcome.wrapped).toBe(true);
    expect(outcome.particle!.age).toBeCloseTo(0.15, 12);
    // GPU 公式:position -= velocity * lifetime * cycles → 0.25 - 1*1 = -0.75。
    expect(outcome.particle!.position[0]).toBeCloseTo(-0.75, 12);
  });

  it("purges non-finite states without propagating NaN", () => {
    const particle: ReferenceParticle = { id: 3, emitterId: "loop", position: [0, 0, 0],
      velocity: [1, 0, 0], age: Number.POSITIVE_INFINITY, lifetime: 1, loop: true };
    const outcome = stepReferenceParticle(particle, { deltaTime: 0.1 });
    expect(outcome.particle).toBeUndefined();
    expect(outcome.nonFinite).toBe(true);
  });

  it("applies drag damping exactly like the GPU kernel formula", () => {
    const particle: ReferenceParticle = { id: 4, emitterId: "d", position: [0, 0, 0],
      velocity: [10, 0, 0], age: 0, lifetime: 10, loop: false };
    const outcome = stepReferenceParticle(particle, { deltaTime: 0.25, drag: 2 });
    const damping = Math.exp(-2 * 0.25);
    expect(outcome.particle!.velocity[0]).toBeCloseTo(10 * damping, 12);
    expect(outcome.particle!.position[0]).toBeCloseTo(10 * damping * 0.25, 12);
  });
});
