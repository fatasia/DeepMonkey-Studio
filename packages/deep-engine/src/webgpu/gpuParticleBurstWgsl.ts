import { GPU_PARTICLE_WORKGROUP_SIZE } from "./gpuParticleTypes.js";

export const GPU_PARTICLE_BURST_WGSL = /* wgsl */ `
struct Particle {
  positionAge: vec4f,
  velocityLifetime: vec4f,
  color: vec4f,
  sizeRotationId: vec4f,
}
struct Counter { value: atomic<u32> }
struct BurstEvent {
  originCount: vec4f,
  directionSpeed: vec4f,
  color: vec4f,
  lifetimeSizeSpread: vec4f,
  identity: vec4u,
}
struct BurstParams { eventCount: u32, frame: u32, capacity: u32, spawnCount: u32 }
struct BurstReservation { base: u32, accepted: u32, _padding0: u32, _padding1: u32 }
@group(0) @binding(0) var<storage, read_write> outputParticles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> outputCounter: Counter;
@group(0) @binding(2) var<storage, read> events: array<BurstEvent>;
@group(0) @binding(3) var<uniform> params: BurstParams;
@group(0) @binding(4) var<storage, read_write> reservation: BurstReservation;

fn deepBurstHash(input: u32) -> u32 {
  var value = input; value ^= value >> 16u; value *= 0x7feb352du;
  value ^= value >> 15u; value *= 0x846ca68bu; return value ^ (value >> 16u);
}
fn deepBurstRandom(input: u32) -> f32 {
  return f32(deepBurstHash(input) & 0x00ffffffu) / 16777216.0;
}

@compute @workgroup_size(1)
fn reserveBursts(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let base = min(atomicLoad(&outputCounter.value), params.capacity);
  let accepted = min(params.spawnCount, params.capacity - base);
  reservation.base = base; reservation.accepted = accepted;
  atomicStore(&outputCounter.value, base + accepted);
}

@compute @workgroup_size(${GPU_PARTICLE_WORKGROUP_SIZE}, 1, 1)
fn spawnBursts(@builtin(global_invocation_id) id: vec3u) {
  if (id.y >= params.eventCount) { return; }
  let event = events[id.y]; let count = u32(round(event.originCount.w));
  if (id.x >= count) { return; }
  let globalIndex = event.identity.y + id.x;
  if (globalIndex >= reservation.accepted) { return; }
  let localSeed = event.identity.x ^ (id.x * 0x9e3779b1u);
  let jitter = vec3f(deepBurstRandom(localSeed), deepBurstRandom(localSeed ^ 0x68bc21ebu),
    deepBurstRandom(localSeed ^ 0x02e5be93u)) * 2.0 - 1.0;
  var direction = event.directionSpeed.xyz + jitter * event.lifetimeSizeSpread.z;
  let lengthSquared = dot(direction, direction);
  if (lengthSquared > 0.000000000001) { direction *= inverseSqrt(lengthSquared); }
  else { direction = event.directionSpeed.xyz; }
  let destination = reservation.base + globalIndex;
  let localId = params.frame * params.capacity + globalIndex;
  var particle: Particle; particle.positionAge = vec4f(event.originCount.xyz, 0.0);
  particle.velocityLifetime = vec4f(direction * event.directionSpeed.w, event.lifetimeSizeSpread.x);
  particle.color = event.color;
  particle.sizeRotationId = vec4f(event.lifetimeSizeSpread.y,
    deepBurstRandom(localSeed ^ 0xa511e9b3u) * 6.2831853, f32(0x00800000u + localId % 0x00800000u), 0.0);
  outputParticles[destination] = particle;
}
`;
