import { describe, expect, it } from "vitest";
import { simulateParticleEvents } from "./particleEvents.js";

const FRAME = { deltaTime: 1 / 60, drag: 0, acceleration: [0, -9.81, 0] as const };

const FLOW = [{ id: "flow", preset: "flow-line" as const, count: 4, lifetime: 30,
  start: [0, 1, 0] as const, end: [1, 1, 0] as const, seed: 21 }];

const GROUND = [{ normal: [0, 1, 0] as const, offset: 0, restitution: 0.5 }];

/** 垂直下落 + 零重力:反弹速度恒定,可精确断言。 */
const FALL = [{ id: "fall", preset: "flow-line" as const, count: 1, lifetime: 2,
  start: [0, 1.5, 0] as const, end: [0, -0.5, 0] as const, seed: 7 }];
const STILL_AIR = { deltaTime: 0.1, drag: 0, acceleration: [0, 0, 0] as const };

describe("particleEvents spawn/death", () => {
  it("emits one spawn per particle for looping emitters", () => {
    const result = simulateParticleEvents(FLOW, 30, FRAME);
    expect(result.stats.emitted).toBe(4);
    expect(result.stats.spawns).toBe(4);
    expect(result.stats.deaths).toBe(0);
    expect(result.finalParticles).toHaveLength(4);
  });

  it("keeps long-lived non-loop particles alive inside the window", () => {
    const result = simulateParticleEvents(FLOW, 30, FRAME, { nonLoopParticles: true });
    expect(result.stats.spawns).toBe(4);
    // lifetime=30s 远超 0.5s 窗口:无死亡,全部保持活跃。
    expect(result.stats.deaths).toBe(0);
    expect(result.finalParticles).toHaveLength(4);
  });

  it("records short-lived non-loop particles dying within the window", () => {
    const short = [{ id: "spark", preset: "expanding-ring" as const, count: 8, lifetime: 0.3,
      center: [0, 2, 0] as const, innerRadius: 0.1, outerRadius: 0.5, seed: 5 }];
    const result = simulateParticleEvents(short, 30, FRAME, { nonLoopParticles: true });
    expect(result.stats.deaths).toBe(8);
    expect(result.finalParticles).toHaveLength(0);
  });
});

describe("particleEvents collisions", () => {
  it("detects the first ground crossing and records one event per particle", () => {
    const result = simulateParticleEvents(FLOW, 120, FRAME, { planes: GROUND });
    expect(result.stats.collisions).toBe(4);
    expect(result.finalParticles.every(particle =>
      particle.velocity.every(Number.isFinite))).toBe(true);
    expect(result.stats.degradationReasons).toEqual([]);
  });

  it("bounces with restitution and keeps post-bounce velocity upward", () => {
    // 非 loop 才会持续下落穿地(loop 粒子按 GPU 语义回绕,不会到达边界);
    // 流线终点越过地面,保证死亡前穿越。
    const result = simulateParticleEvents(FALL, 40, STILL_AIR, { planes: GROUND, nonLoopParticles: true });
    expect(result.stats.collisions).toBe(1);
    // 入射速度 -1,restitution 0.5 → 反弹速度 +0.5,零重力下保持向上。
    result.finalParticles.forEach(particle => expect(particle.velocity[1]).toBeCloseTo(0.5, 12));
  });

  it("keeps collisions below one per particle across a long window", () => {
    const result = simulateParticleEvents(FLOW, 600, FRAME, { planes: GROUND });
    expect(result.stats.collisions).toBe(4);
  });

  it("rejects degenerate planes", () => {
    expect(() => simulateParticleEvents(FLOW, 10, FRAME,
      { planes: [{ normal: [0, 0, 0], offset: 0 }] })).toThrow(RangeError);
    expect(() => simulateParticleEvents(FLOW, 10, FRAME,
      { planes: [{ normal: [0, 1, 0], offset: 0, restitution: 1.5 }] })).toThrow(RangeError);
  });
});

describe("particleEvents determinism and budget", () => {
  it("is bitwise reproducible for identical inputs", () => {
    const options = { planes: GROUND, eventLimit: 128 } as const;
    const first = simulateParticleEvents(FLOW, 90, FRAME, options);
    const second = simulateParticleEvents(FLOW, 90, FRAME, options);
    expect(second).toEqual(first);
  });

  it("orders events by (frame, id) monotonically", () => {
    const result = simulateParticleEvents(FLOW, 90, FRAME, { planes: GROUND });
    for (let index = 1; index < result.events.length; index++) {
      const previous = result.events[index - 1]!;
      const current = result.events[index]!;
      expect(current.frame).toBeGreaterThanOrEqual(previous.frame);
      if (current.frame === previous.frame) {
        expect(current.id).toBeGreaterThanOrEqual(previous.id);
      }
    }
  });

  it("truncates at the event limit and records the quantified degradation", () => {
    const result = simulateParticleEvents(FLOW, 300, FRAME, { planes: GROUND, eventLimit: 6 });
    expect(result.stats.truncated).toBe(true);
    expect(result.events).toHaveLength(6);
    expect(result.stats.degradationReasons).toEqual(["event-limit:6"]);
  });

  it("rejects invalid frame counts and configs", () => {
    expect(() => simulateParticleEvents([], 10, FRAME)).toThrow(RangeError);
    expect(() => simulateParticleEvents(FLOW, 0, FRAME)).toThrow(RangeError);
    expect(() => simulateParticleEvents(FLOW, 10.5, FRAME)).toThrow(RangeError);
    expect(() => simulateParticleEvents(FLOW, 10, FRAME, { eventLimit: 0 })).toThrow(RangeError);
  });
});
