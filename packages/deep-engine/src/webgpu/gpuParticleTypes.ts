/// <reference types="@webgpu/types" />

export const GPU_PARTICLE_STRIDE = 64;
export const GPU_PARTICLE_FRAME_UNIFORM_BYTES = 32;
export const GPU_PARTICLE_INDIRECT_BYTES = 16;
export const GPU_PARTICLE_CAMERA_UNIFORM_BYTES = 96;
export const GPU_PARTICLE_WORKGROUP_SIZE = 64;
export const GPU_PARTICLE_DEFAULT_CAPACITY = 65_536;
export const GPU_PARTICLE_MAX_CAPACITY = 1_048_576;
export const GPU_PARTICLE_FLAG_LOOP = 1;
export const GPU_PARTICLE_FLAG_PULSE = 2;

export type ParticleVector3 = readonly [number, number, number];
export type ParticleColor = readonly [number, number, number, number];

export interface GpuParticleSeed {
  readonly position: ParticleVector3;
  readonly velocity: ParticleVector3;
  readonly lifetime: number;
  readonly age?: number;
  readonly color?: ParticleColor;
  readonly size?: number;
  readonly rotation?: number;
  /** Exact while within the validated 24-bit integer range. */
  readonly id?: number;
  readonly flags?: number;
}
export interface GpuParticleFrameInput {
  readonly frame?: number;
  readonly deltaTime: number;
  readonly acceleration?: ParticleVector3;
  readonly drag?: number;
}
export interface GpuParticleCapacityEvidence {
  readonly requestedCapacity: number;
  readonly capacity: number;
  readonly degraded: boolean;
  readonly stateBytes: number;
  readonly totalBufferBytes: number;
}
export interface PackedParticleFrame {
  readonly bytes: ArrayBuffer;
  readonly deltaTime: number;
  readonly acceleration: ParticleVector3;
  readonly drag: number;
}

export function resolveGpuParticleCapacity(device: GPUDevice, requested: number | undefined,
  seedCount: number): GpuParticleCapacityEvidence {
  integer(seedCount, "seedCount", 0, GPU_PARTICLE_MAX_CAPACITY);
  const supported = Math.min(GPU_PARTICLE_MAX_CAPACITY,
    Math.floor(Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)
      / GPU_PARTICLE_STRIDE),
    device.limits.maxComputeWorkgroupsPerDimension * GPU_PARTICLE_WORKGROUP_SIZE);
  if (!Number.isSafeInteger(supported) || supported < 1
    || device.limits.maxStorageBuffersPerShaderStage < 5
    || device.limits.maxBindGroups < 2 || device.limits.maxUniformBuffersPerShaderStage < 1
    || device.limits.maxComputeInvocationsPerWorkgroup < GPU_PARTICLE_WORKGROUP_SIZE
    || device.limits.maxComputeWorkgroupSizeX < GPU_PARTICLE_WORKGROUP_SIZE) {
    throw new Error("WebGPU device cannot support the particle compute ABI.");
  }
  const automatic = Math.min(GPU_PARTICLE_DEFAULT_CAPACITY,
    Math.max(1_024, nextPowerOfTwo(Math.max(seedCount, 1))));
  const desired = requested === undefined ? automatic
    : integer(requested, "capacity", 1, GPU_PARTICLE_MAX_CAPACITY);
  const capacity = Math.min(desired, supported);
  if (seedCount > capacity) throw new RangeError(`Initial particles exceed resolved capacity ${capacity}.`);
  const stateBytes = capacity * GPU_PARTICLE_STRIDE;
  return Object.freeze({ requestedCapacity: desired, capacity, degraded: capacity < desired,
    stateBytes, totalBufferBytes: stateBytes * 2 + 8 + GPU_PARTICLE_INDIRECT_BYTES * 2
      + GPU_PARTICLE_FRAME_UNIFORM_BYTES });
}

export function packGpuParticleSeeds(seeds: readonly GpuParticleSeed[], capacity: number): ArrayBuffer {
  if (!Array.isArray(seeds) || seeds.length > capacity) throw new RangeError("Particle seeds exceed capacity.");
  const values = new Float32Array(seeds.length * GPU_PARTICLE_STRIDE / 4);
  seeds.forEach((seed, index) => {
    const base = index * 16;
    const position = vector(seed.position, `particles[${index}].position`, 1e9);
    const velocity = vector(seed.velocity, `particles[${index}].velocity`, 1e6);
    const age = finite(seed.age ?? 0, `particles[${index}].age`, 0, 1e9);
    const lifetime = finite(seed.lifetime, `particles[${index}].lifetime`, Number.MIN_VALUE, 1e9);
    const color = seed.color ?? [1, 1, 1, 1];
    if (!Array.isArray(color) || color.length !== 4) throw new TypeError(`particles[${index}].color is invalid.`);
    color.forEach((value, channel) => finite(value, `particles[${index}].color[${channel}]`, 0, 65_504));
    const size = finite(seed.size ?? 1, `particles[${index}].size`, Number.MIN_VALUE, 1e6);
    const rotation = finite(seed.rotation ?? 0, `particles[${index}].rotation`, -1e9, 1e9);
    const id = integer(seed.id ?? index, `particles[${index}].id`, 0, 16_777_215);
    const flags = integer(seed.flags ?? 0, `particles[${index}].flags`, 0, 255);
    values.set([...position, age], base); values.set([...velocity, lifetime], base + 4);
    values.set(color, base + 8); values.set([size, rotation, id, flags], base + 12);
  });
  return values.buffer;
}

export function packGpuParticleFrame(input: GpuParticleFrameInput, capacity: number): PackedParticleFrame {
  const deltaTime = finite(input.deltaTime, "deltaTime", 0, 0.25);
  const drag = finite(input.drag ?? 0, "drag", 0, 100);
  const acceleration = vector(input.acceleration ?? [0, -9.81, 0], "acceleration", 1e6);
  const data = new ArrayBuffer(GPU_PARTICLE_FRAME_UNIFORM_BYTES);
  const floats = new Float32Array(data), uints = new Uint32Array(data);
  floats[0] = deltaTime; floats[1] = drag; uints[2] = capacity;
  floats.set([...acceleration, 0], 4);
  return Object.freeze({ bytes: data, deltaTime, acceleration, drag });
}

function nextPowerOfTwo(value: number): number { return 2 ** Math.ceil(Math.log2(value)); }
function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}
function finite(value: number, name: string, minimum: number, maximum: number): number {
  const packed = Math.fround(value);
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(packed)
    || packed < minimum || packed > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`);
  }
  return value;
}
function vector(value: ParticleVector3, name: string, magnitude: number): ParticleVector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must contain three values.`);
  value.forEach((item, axis) => finite(item, `${name}[${axis}]`, -magnitude, magnitude));
  return Object.freeze([...value]) as ParticleVector3;
}
