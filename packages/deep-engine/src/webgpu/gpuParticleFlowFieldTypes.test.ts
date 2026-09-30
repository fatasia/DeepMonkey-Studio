import { describe, expect, it } from "vitest";
import { packGpuParticleFlowField } from "./gpuParticleFlowFieldTypes.js";
describe("particle flow ABI", () => {
  it("packs bounded f32 parameters and an exact u32 seed in 32 bytes", () => {
    const packed = packGpuParticleFlowField({ phase: .2, seed: 0xffffffff });
    expect(packed.bytes.byteLength).toBe(32); expect(packed.active).toBe(true);
    expect(Array.from(new Float32Array(packed.bytes).slice(0, 6))).toEqual([Math.fround(.2), .5, 1, 1, 0, 0]);
    expect(new Uint32Array(packed.bytes)[6]).toBe(0xffffffff); expect(new Uint32Array(packed.bytes)[7]).toBe(0);
    expect(packGpuParticleFlowField({ phase: 0, flowStrength: 0 }).active).toBe(false);
    expect(packGpuParticleFlowField({ phase: 0, flowStrength: 0, maxSpeed: 2 }).active).toBe(true);
  });
  it("rejects invalid inputs before GPU work", () => {
    for (const value of [NaN, Infinity, -1_000_001, 1_000_001]) expect(() => packGpuParticleFlowField({ phase: value })).toThrow();
    for (const key of ["noiseScale", "flowSpeed", "flowStrength", "maxSpeed"] as const) {
      expect(() => packGpuParticleFlowField({ phase: 0, [key]: -1 })).toThrow();
      expect(() => packGpuParticleFlowField({ phase: 0, [key]: NaN })).toThrow();
    }
    for (const seed of [-1, .5, 0x100000000]) expect(() => packGpuParticleFlowField({ phase: 0, seed })).toThrow();
  });
});
