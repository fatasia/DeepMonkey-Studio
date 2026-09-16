import { describe, expect, it } from "vitest";
import { GPU_PARTICLE_FLAG_LOOP, GPU_PARTICLE_FLAG_PULSE } from "./gpuParticleTypes.js";
import {
  compileGpuParticleEmitters, type GpuParticleEmitter,
} from "./gpuParticleEmitters.js";

const effects: readonly GpuParticleEmitter[] = [
  { id: "alarm", preset: "alarm-pulse", position: [1, 2, 3], seed: 7 },
  { id: "ring", preset: "expanding-ring", center: [10, 0, 0], count: 8,
    innerRadius: 1, outerRadius: 5, lifetime: 2, seed: 11 },
  { id: "flow", preset: "flow-line", start: [20, 0, 0], end: [24, 4, 0],
    count: 4, lifetime: 1, seed: 13 },
];

describe("declarative GPU particle emitters", () => {
  it("compiles all presets into deterministic looping particle seeds", () => {
    const first = compileGpuParticleEmitters(effects, 64), repeated = compileGpuParticleEmitters(effects, 64);
    expect(first).toEqual(repeated);
    expect(first.evidence).toEqual({ requestedParticleCount: 13, emittedParticleCount: 13,
      capacity: 64, degraded: false, degradationReasons: [], emitterCounts: { alarm: 1, ring: 8, flow: 4 } });
    expect(first.particles[0]).toMatchObject({ position: [1, 2, 3], velocity: [0, 0, 0],
      flags: GPU_PARTICLE_FLAG_LOOP | GPU_PARTICLE_FLAG_PULSE });
    const ring = first.particles.slice(1, 9), flow = first.particles.slice(9);
    expect(ring.every(particle => particle.flags === GPU_PARTICLE_FLAG_LOOP
      && Math.hypot(particle.position[0] - 10, particle.position[2]) >= 1
      && Math.hypot(particle.position[0] - 10, particle.position[2]) < 5)).toBe(true);
    expect(flow.every(particle => particle.flags === GPU_PARTICLE_FLAG_LOOP
      && particle.position[0] >= 20 && particle.position[0] < 24
      && particle.velocity[0] === 4 && particle.velocity[1] === 4)).toBe(true);
  });

  it("degrades counts proportionally with deterministic tie breaking", () => {
    const program = compileGpuParticleEmitters([
      { id: "ring", preset: "expanding-ring", center: [0, 0, 0], count: 6 },
      { id: "flow", preset: "flow-line", start: [0, 0, 0], end: [1, 0, 0], count: 4 },
    ], 5);
    expect(program.evidence).toEqual({ requestedParticleCount: 10, emittedParticleCount: 5,
      capacity: 5, degraded: true, degradationReasons: ["particle-count:10->5"],
      emitterCounts: { ring: 3, flow: 2 } });
    expect(program.particles.map(particle => particle.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("fails closed on duplicate ids, invalid geometry and hostile budgets", () => {
    expect(() => compileGpuParticleEmitters([effects[0]!, effects[0]!], 8)).toThrow("invalid");
    expect(() => compileGpuParticleEmitters([{ id: "ring", preset: "expanding-ring",
      center: [0, 0, 0], innerRadius: 2, outerRadius: 1 }], 8)).toThrow("outerRadius");
    expect(() => compileGpuParticleEmitters([{ id: "flow", preset: "flow-line",
      start: [0, 0, 0], end: [0, 0, 0] }], 8)).toThrow("zero length");
    expect(() => compileGpuParticleEmitters(new Array(65).fill(effects[0]), 8)).toThrow("at most 64");
  });
});
