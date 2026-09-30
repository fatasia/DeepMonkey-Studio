import { flowCurlVelocity } from "./flowFieldNoise.js";
import { GPU_PARTICLE_FLOW_DOMAIN_LIMIT } from "../webgpu/gpuParticleFlowFieldWgsl.js";
import { packGpuParticleFlowField } from "../webgpu/gpuParticleFlowFieldTypes.js";
import { packGpuParticleFrame, packGpuParticleSeeds, GPU_PARTICLE_FLAG_LOOP, type GpuParticleSeed } from "../webgpu/gpuParticleTypes.js";
import type { GpuParticleRuntimeFrameInput } from "../webgpu/gpuParticleRuntime.js";
const f = Math.fround, add = (a: number, b: number) => f(a + b), mul = (a: number, b: number) => f(a * b);
/** Numeric reference for the canonical flow kernel, not a production CPU particle simulator. */
export function advanceFlowParticleCpu(seed: GpuParticleSeed, input: GpuParticleRuntimeFrameInput): GpuParticleSeed | undefined {
  const packed = packGpuParticleFrame(input, 1), particle = new Float32Array(packGpuParticleSeeds([seed], 1));
  const frameValues = new Float32Array(packed.bytes), dt = frameValues[0]!, lifetime = particle[7]!;
  let age = add(particle[3]!, dt);
  const looping = (Math.round(particle[15]!) & GPU_PARTICLE_FLAG_LOOP) !== 0;
  if (age >= lifetime && !looping) return undefined;
  const flow = input.flow === undefined ? undefined : packGpuParticleFlowField(input.flow);
  const params = flow ? new Float32Array(flow.bytes) : undefined;
  let velocity = [particle[4]!, particle[5]!, particle[6]!] as [number, number, number];
  if (flow?.active) {
    const p = [0, 1, 2].map(axis => Math.max(-GPU_PARTICLE_FLOW_DOMAIN_LIMIT, Math.min(GPU_PARTICLE_FLOW_DOMAIN_LIMIT,
      f(mul(particle[axis]!, params![1]!) - (axis === 2 ? params![0]! : 0))))) as [number, number, number];
    const curl = flowCurlVelocity(p, new Uint32Array(flow.bytes)[6]!);
    const follow = f(1 - f(Math.exp(mul(-params![3]!, dt))));
    velocity = velocity.map((v, axis) => add(mul(f(1 - follow), v), mul(follow, mul(curl[axis]!, params![2]!)))) as [number, number, number];
  }
  const damping = f(Math.exp(mul(-frameValues[1]!, dt)));
  velocity = velocity.map((v, axis) => mul(add(v, mul(frameValues[axis + 4]!, dt)), damping)) as [number, number, number];
  if (flow?.active && params![4]! > 0) {
    const speed = f(Math.sqrt(add(add(mul(velocity[0], velocity[0]), mul(velocity[1], velocity[1])), mul(velocity[2], velocity[2]))));
    if (speed > params![4]!) velocity = velocity.map(v => mul(v, f(params![4]! / Math.max(speed, 1e-9)))) as [number, number, number];
  }
  let position = velocity.map((v, axis) => add(particle[axis]!, mul(v, dt))) as [number, number, number];
  if (looping && age >= lifetime) {
    const cycles = Math.floor(f(age / lifetime)); age = f(age - mul(cycles, lifetime));
    position = position.map((p, axis) => f(p - mul(mul(velocity[axis]!, lifetime), cycles))) as [number, number, number];
  }
  if (![...position, ...velocity].every(v => Number.isFinite(v) && Math.abs(v) <= 3.402823e38)) return undefined;
  return { ...seed, position, velocity, age };
}
