import type { ParticleColor, ParticleVector3 } from "./gpuParticleTypes.js";

export const GPU_PARTICLE_BURST_EVENT_BYTES = 80;
export const GPU_PARTICLE_BURST_UNIFORM_BYTES = 16;
export const GPU_PARTICLE_BURST_MAX_EVENTS = 64;
const GPU_PARTICLE_BURST_INPUT_LIMIT = 256;

export interface GpuParticleBurstEvent {
  readonly id: string;
  readonly position: ParticleVector3;
  readonly direction: ParticleVector3;
  readonly count: number;
  readonly lifetime?: number;
  readonly speed?: number;
  readonly spread?: number;
  readonly color?: ParticleColor;
  readonly size?: number;
  readonly seed?: number;
}
export interface GpuParticleBurstOptions {
  readonly maxEvents?: number;
  readonly particleBudget?: number;
}
export interface ResolvedGpuParticleBurstOptions {
  readonly maxEvents: number;
  readonly particleBudget: number;
  readonly eventBufferBytes: number;
  readonly totalBufferBytes: number;
}
export interface GpuParticleBurstEvidence extends ResolvedGpuParticleBurstOptions {
  readonly requestedEventCount: number;
  readonly submittedEventCount: number;
  readonly requestedParticleCount: number;
  readonly submittedParticleCount: number;
  readonly degraded: boolean;
  readonly degradationReasons: readonly string[];
}
export interface PackedGpuParticleBurstFrame {
  readonly eventBytes: ArrayBuffer;
  readonly uniformBytes: ArrayBuffer;
  readonly dispatchX: number;
  readonly dispatchY: number;
  readonly evidence: GpuParticleBurstEvidence;
}

interface ValidBurst extends Required<Omit<GpuParticleBurstEvent, "color">> {
  readonly color: ParticleColor;
}

export function resolveGpuParticleBurstOptions(capacity: number,
  options: GpuParticleBurstOptions = {}): ResolvedGpuParticleBurstOptions {
  integer(capacity, "capacity", 1, 1_048_576);
  const maxEvents = integer(options.maxEvents ?? 32, "maxEvents", 1, GPU_PARTICLE_BURST_MAX_EVENTS);
  const particleBudget = integer(options.particleBudget ?? Math.min(capacity, 4_096),
    "particleBudget", 1, capacity);
  return Object.freeze({ maxEvents, particleBudget,
    eventBufferBytes: maxEvents * GPU_PARTICLE_BURST_EVENT_BYTES,
    totalBufferBytes: maxEvents * GPU_PARTICLE_BURST_EVENT_BYTES + GPU_PARTICLE_BURST_UNIFORM_BYTES + 16 });
}

/** Packs only event descriptors; particle expansion remains entirely on the GPU. */
export function packGpuParticleBurstFrame(events: readonly GpuParticleBurstEvent[], frame: number,
  capacity: number, options: ResolvedGpuParticleBurstOptions): PackedGpuParticleBurstFrame {
  if (!Array.isArray(events) || events.length > GPU_PARTICLE_BURST_INPUT_LIMIT) {
    throw new RangeError(`Burst events must contain at most ${GPU_PARTICLE_BURST_INPUT_LIMIT} items.`);
  }
  integer(frame, "frame", 0, Number.MAX_SAFE_INTEGER);
  const resolved = resolveGpuParticleBurstOptions(capacity, options);
  const validated = events.map((event, index) => validateEvent(event, index));
  const requestedParticles = validated.reduce((sum, event) => sum + event.count, 0);
  const accepted = validated.slice(0, resolved.maxEvents);
  let remaining = resolved.particleBudget, submittedParticles = 0, maxCount = 0;
  const packed: Array<{ readonly event: ValidBurst; readonly count: number; readonly start: number }> = [];
  for (const event of accepted) {
    const count = Math.min(event.count, remaining);
    if (count > 0) { packed.push({ event, count, start: submittedParticles });
      submittedParticles += count; remaining -= count; maxCount = Math.max(maxCount, count); }
    if (remaining === 0) break;
  }
  const eventBytes = new ArrayBuffer(packed.length * GPU_PARTICLE_BURST_EVENT_BYTES);
  const floats = new Float32Array(eventBytes), words = new Uint32Array(eventBytes);
  packed.forEach(({ event, count, start }, index) => {
    const base = index * GPU_PARTICLE_BURST_EVENT_BYTES / 4;
    floats.set([...event.position, count], base);
    floats.set([...event.direction, event.speed], base + 4);
    floats.set(event.color, base + 8);
    floats.set([event.lifetime, event.size, event.spread, 0], base + 12);
    words.set([event.seed, start, 0, 0], base + 16);
  });
  const uniformBytes = new Uint32Array([packed.length, frame >>> 0, capacity, submittedParticles]).buffer;
  const reasons: string[] = [];
  if (validated.length > accepted.length) reasons.push(`event-count:${validated.length}->${accepted.length}`);
  if (submittedParticles < requestedParticles) reasons.push(`particle-count:${requestedParticles}->${submittedParticles}`);
  const evidence = Object.freeze({ ...resolved, requestedEventCount: validated.length,
    submittedEventCount: packed.length, requestedParticleCount: requestedParticles,
    submittedParticleCount: submittedParticles, degraded: reasons.length > 0,
    degradationReasons: Object.freeze(reasons) });
  return Object.freeze({ eventBytes, uniformBytes,
    dispatchX: maxCount ? Math.ceil(maxCount / 64) : 0, dispatchY: packed.length, evidence });
}

function validateEvent(value: GpuParticleBurstEvent, index: number): ValidBurst {
  if (!value || typeof value !== "object" || !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$/.test(value.id)) {
    throw new TypeError(`Burst event ${index} is invalid.`);
  }
  const position = vector(value.position, `events[${index}].position`, false);
  const direction = vector(value.direction, `events[${index}].direction`, true);
  const color = value.color ?? [1, 0.5, 0.1, 1];
  if (!Array.isArray(color) || color.length !== 4) throw new TypeError(`events[${index}].color is invalid.`);
  color.forEach((channel, item) => finite(channel, `events[${index}].color[${item}]`, 0, 65_504));
  return Object.freeze({ ...value, position, direction, color: Object.freeze([...color]) as ParticleColor,
    count: integer(value.count, `events[${index}].count`, 1, 1_048_576),
    lifetime: finite(value.lifetime ?? 1, `events[${index}].lifetime`, 0.01, 3_600),
    speed: finite(value.speed ?? 1, `events[${index}].speed`, 0, 1e6),
    spread: finite(value.spread ?? 0.25, `events[${index}].spread`, 0, 1),
    size: finite(value.size ?? 0.08, `events[${index}].size`, 0.0001, 1e6),
    seed: integer(value.seed ?? hash(value.id), `events[${index}].seed`, 0, 0xffffffff) });
}
function vector(value: ParticleVector3, name: string, normalize: boolean): ParticleVector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must contain three values.`);
  value.forEach((item, axis) => finite(item, `${name}[${axis}]`, -1e9, 1e9));
  if (!normalize) return Object.freeze([...value]) as ParticleVector3;
  const length = Math.hypot(...value); if (length <= 1e-9) throw new RangeError(`${name} must be non-zero.`);
  return Object.freeze(value.map(item => item / length)) as unknown as ParticleVector3;
}
function hash(value: string): number { let result = 2166136261; for (const char of value) {
  result = Math.imul(result ^ char.charCodeAt(0), 16777619); } return result >>> 0; }
function finite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`); } return value;
}
function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}.`); } return value;
}
