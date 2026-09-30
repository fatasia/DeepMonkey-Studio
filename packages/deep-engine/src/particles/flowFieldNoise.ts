import type { ParticleVector3 } from "../webgpu/gpuParticleTypes.js";
import { GPU_PARTICLE_FLOW_DOMAIN_LIMIT, GPU_PARTICLE_FLOW_POTENTIAL_A,
  GPU_PARTICLE_FLOW_POTENTIAL_B, GPU_PARTICLE_FLOW_POTENTIAL_C } from "../webgpu/gpuParticleFlowFieldWgsl.js";

const f = Math.fround;
const add = (a: number, b: number) => f(a + b);
const sub = (a: number, b: number) => f(a - b);
const mul = (a: number, b: number) => f(a * b);
export interface FlowNoiseSample { readonly value: number; readonly dx: number; readonly dy: number; readonly dz: number }
export function flowFade(t: number): readonly [number, number] {
  t = f(t); const t2 = mul(t, t), t3 = mul(t2, t);
  return [mul(t3, add(sub(mul(t2, 6), mul(t, 15)), 10)), mul(mul(t2, mul(sub(t, 1), sub(t, 1))), 30)];
}
function gradient(x: number, y: number, z: number, seed: number): ParticleVector3 {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 2246822519); h ^= h >>> 16;
  return [sub((h & 65535) / 32768, 1), sub(((h >>> 7) & 65535) / 32768, 1),
    sub(((h >>> 14) & 65535) / 32768, 1)];
}
/** Closed-form gradient, with the WGSL expression tree rounded at every f32 operation. */
export function flowGradientNoise(position: ParticleVector3, seed: number): FlowNoiseSample {
  const p = position.map(value => f(Math.max(-GPU_PARTICLE_FLOW_DOMAIN_LIMIT,
    Math.min(GPU_PARTICLE_FLOW_DOMAIN_LIMIT, value))));
  const base = p.map(Math.floor), r = p.map((value, axis) => sub(value, base[axis]!));
  const fades = r.map(flowFade), corners: FlowNoiseSample[] = [];
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const g = gradient(base[0]! + x, base[1]! + y, base[2]! + z, seed);
    const value = add(add(mul(g[0], sub(r[0]!, x)), mul(g[1], sub(r[1]!, y))), mul(g[2], sub(r[2]!, z)));
    corners.push({ value, dx: g[0], dy: g[1], dz: g[2] });
  }
  const ax = interpolate(corners[0]!, corners[1]!, fades[0]!, "dx");
  const bx = interpolate(corners[2]!, corners[3]!, fades[0]!, "dx");
  const cx = interpolate(corners[4]!, corners[5]!, fades[0]!, "dx");
  const ex = interpolate(corners[6]!, corners[7]!, fades[0]!, "dx");
  return interpolate(interpolate(ax, bx, fades[1]!, "dy"), interpolate(cx, ex, fades[1]!, "dy"), fades[2]!, "dz");
}
function interpolate(a: FlowNoiseSample, b: FlowNoiseSample, fade: readonly [number, number], axis: "dx" | "dy" | "dz"): FlowNoiseSample {
  const left = sub(1, fade[0]);
  const blend = (x: number, y: number) => add(mul(left, x), mul(fade[0], y));
  const result = { value: blend(a.value, b.value), dx: blend(a.dx, b.dx), dy: blend(a.dy, b.dy), dz: blend(a.dz, b.dz) };
  result[axis] = add(result[axis], mul(fade[1], sub(b.value, a.value)));
  return result;
}
export function flowCurlVelocity(position: ParticleVector3, seed: number): ParticleVector3 {
  const a = flowGradientNoise(position, seed ^ GPU_PARTICLE_FLOW_POTENTIAL_A);
  const b = flowGradientNoise(position, seed ^ GPU_PARTICLE_FLOW_POTENTIAL_B);
  const c = flowGradientNoise(position, seed ^ GPU_PARTICLE_FLOW_POTENTIAL_C);
  return [sub(c.dy, b.dz), sub(a.dz, c.dx), sub(b.dx, a.dy)];
}
