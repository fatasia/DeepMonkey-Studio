import { describe, expect, it } from "vitest";
import {
  GPU_PARTICLE_BURST_EVENT_BYTES, packGpuParticleBurstFrame, resolveGpuParticleBurstOptions,
  type GpuParticleBurstEvent,
} from "./gpuParticleBurstTypes.js";

const events: readonly GpuParticleBurstEvent[] = [
  { id: "first", position: [1, 2, 3], direction: [0, 2, 0], count: 6, seed: 11,
    lifetime: 2, speed: 4, spread: 0, size: 0.5, color: [1, 0.5, 0.25, 1] },
  { id: "second", position: [4, 5, 6], direction: [1, 0, 0], count: 4, seed: 22 },
  { id: "overflow", position: [0, 0, 0], direction: [0, 0, 1], count: 2 },
];

describe("GPU particle burst packing", () => {
  it("packs descriptors deterministically while enforcing both fixed budgets", () => {
    const options = resolveGpuParticleBurstOptions(16, { maxEvents: 2, particleBudget: 8 });
    const first = packGpuParticleBurstFrame(events, 7, 16, options);
    const repeated = packGpuParticleBurstFrame(events, 7, 16, options);
    expect(new Uint8Array(first.eventBytes)).toEqual(new Uint8Array(repeated.eventBytes));
    expect(first).toMatchObject({ dispatchX: 1, dispatchY: 2, evidence: {
      maxEvents: 2, particleBudget: 8, requestedEventCount: 3, submittedEventCount: 2,
      requestedParticleCount: 12, submittedParticleCount: 8, degraded: true,
      degradationReasons: ["event-count:3->2", "particle-count:12->8"],
    } });
    expect(first.eventBytes.byteLength).toBe(2 * GPU_PARTICLE_BURST_EVENT_BYTES);
    const floats = new Float32Array(first.eventBytes), words = new Uint32Array(first.eventBytes);
    expect(Array.from(floats.slice(0, 8))).toEqual([1, 2, 3, 6, 0, 1, 0, 4]);
    expect(Array.from(words.slice(16, 18))).toEqual([11, 0]);
    expect(floats[GPU_PARTICLE_BURST_EVENT_BYTES / 4 + 3]).toBe(2);
  });

  it("uses zero upload/dispatch bytes for an empty frame", () => {
    const options = resolveGpuParticleBurstOptions(8);
    const packed = packGpuParticleBurstFrame([], 0, 8, options);
    expect(packed.eventBytes.byteLength).toBe(0);
    expect(packed).toMatchObject({ dispatchX: 0, dispatchY: 0,
      evidence: { submittedEventCount: 0, submittedParticleCount: 0, degraded: false } });
  });

  it("rejects invalid limits and hostile event data", () => {
    expect(() => resolveGpuParticleBurstOptions(4, { particleBudget: 5 })).toThrow("particleBudget");
    expect(() => packGpuParticleBurstFrame([{ ...events[0]!, direction: [0, 0, 0] }], 0, 16,
      resolveGpuParticleBurstOptions(16))).toThrow("non-zero");
    expect(() => packGpuParticleBurstFrame(new Array(257).fill(events[0]), 0, 16,
      resolveGpuParticleBurstOptions(16))).toThrow("at most 256");
  });
});
