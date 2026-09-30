import { GPU_PARTICLE_FLOW_UNIFORM_BYTES } from "./gpuParticleFlowFieldWgsl.js";

/** Explicit field time makes replay independent of the renderer's wall clock. */
export interface GpuParticleFlowField {
  readonly phase: number;
  readonly noiseScale?: number;
  readonly flowSpeed?: number;
  readonly flowStrength?: number;
  /** Zero leaves speed uncapped. */
  readonly maxSpeed?: number;
  readonly seed?: number;
}
export interface PackedGpuParticleFlowField {
  readonly bytes: ArrayBuffer;
  readonly active: boolean;
}
export function packGpuParticleFlowField(value: GpuParticleFlowField): PackedGpuParticleFlowField {
  if (!value || typeof value !== "object") throw new TypeError("Particle flow is invalid.");
  const phase = finite(value.phase, "phase", -1_000_000, 1_000_000);
  const scale = finite(value.noiseScale ?? .5, "noiseScale", 0.000001, 1_000_000);
  const speed = finite(value.flowSpeed ?? 1, "flowSpeed", 0, 1_000_000);
  const strength = finite(value.flowStrength ?? 1, "flowStrength", 0, 1_000_000);
  const maxSpeed = finite(value.maxSpeed ?? 0, "maxSpeed", 0, 1_000_000);
  const seed = value.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("Particle flow seed must be u32.");
  const bytes = new ArrayBuffer(GPU_PARTICLE_FLOW_UNIFORM_BYTES);
  new Float32Array(bytes).set([phase, scale, speed, strength, maxSpeed, 0]);
  new Uint32Array(bytes)[6] = seed;
  return Object.freeze({ bytes, active: strength > 0 || maxSpeed > 0 });
}
function finite(value: number, name: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
    throw new RangeError(`Particle flow ${name} must be finite within [${low}, ${high}].`);
  }
  return Math.fround(value);
}
