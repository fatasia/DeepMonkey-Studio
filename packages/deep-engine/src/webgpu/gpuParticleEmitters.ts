import type { DeviceSession } from "./deviceSession.js";
import { GpuParticleRuntime, type GpuParticleFrameResult } from "./gpuParticleRuntime.js";
import {
  GPU_PARTICLE_DEFAULT_CAPACITY, GPU_PARTICLE_FLAG_LOOP, GPU_PARTICLE_FLAG_PULSE,
  GPU_PARTICLE_MAX_CAPACITY, resolveGpuParticleCapacity,
  type GpuParticleSeed, type ParticleColor, type ParticleVector3,
} from "./gpuParticleTypes.js";

interface EmitterBase {
  readonly id: string;
  readonly count?: number;
  readonly lifetime?: number;
  readonly color?: ParticleColor;
  readonly size?: number;
  readonly seed?: number;
}
export interface AlarmPulseEmitter extends EmitterBase {
  readonly preset: "alarm-pulse";
  readonly position: ParticleVector3;
}
export interface ExpandingRingEmitter extends EmitterBase {
  readonly preset: "expanding-ring";
  readonly center: ParticleVector3;
  readonly innerRadius?: number;
  readonly outerRadius?: number;
}
export interface FlowLineEmitter extends EmitterBase {
  readonly preset: "flow-line";
  readonly start: ParticleVector3;
  readonly end: ParticleVector3;
}
export type GpuParticleEmitter = AlarmPulseEmitter | ExpandingRingEmitter | FlowLineEmitter;

export interface GpuParticleEmitterEvidence {
  readonly requestedParticleCount: number;
  readonly emittedParticleCount: number;
  readonly capacity: number;
  readonly degraded: boolean;
  readonly degradationReasons: readonly string[];
  readonly emitterCounts: Readonly<Record<string, number>>;
}
export interface GpuParticleEmitterProgram {
  readonly particles: readonly GpuParticleSeed[];
  readonly evidence: GpuParticleEmitterEvidence;
}
export interface GpuParticleEmitterRuntimeSetup {
  readonly runtime: GpuParticleRuntime;
  readonly program: GpuParticleEmitterProgram;
}
export interface GpuParticleEmitterRuntimeOptions { readonly capacity?: number }
export interface GpuParticleEmitterFrameInput { readonly frame?: number; readonly deltaTime: number }

interface NormalizedEmitter {
  readonly source: GpuParticleEmitter;
  readonly count: number;
  readonly lifetime: number;
  readonly color: ParticleColor;
  readonly size: number;
  readonly seed: number;
}
const DEFAULTS = Object.freeze({
  "alarm-pulse": { count: 1, lifetime: 1.6, size: 0.25, color: [1, 0.16, 0.04, 1] },
  "expanding-ring": { count: 48, lifetime: 1.5, size: 0.06, color: [1, 0.45, 0.08, 0.9] },
  "flow-line": { count: 32, lifetime: 2, size: 0.05, color: [0.1, 0.75, 1, 0.9] },
} as const);

/** Compiles declarative effects into deterministic seeds for the existing GPU runtime. */
export function compileGpuParticleEmitters(emitters: readonly GpuParticleEmitter[],
  capacity: number): GpuParticleEmitterProgram {
  const normalized = normalizeEmitters(emitters);
  integer(capacity, "capacity", 1, GPU_PARTICLE_MAX_CAPACITY);
  const requested = normalized.reduce((sum, emitter) => sum + emitter.count, 0);
  if (requested > GPU_PARTICLE_MAX_CAPACITY) throw new RangeError("Emitter particle budget exceeds the hard limit.");
  const counts = allocateCounts(normalized.map(emitter => emitter.count), Math.min(capacity, requested));
  const particles: GpuParticleSeed[] = [], emitterCounts: Record<string, number> = {};
  normalized.forEach((emitter, emitterIndex) => {
    const count = counts[emitterIndex]!; emitterCounts[emitter.source.id] = count;
    for (let index = 0; index < count; index++) {
      particles.push(createSeed(emitter, index, count, particles.length));
    }
  });
  const degraded = particles.length < requested;
  const reasons = Object.freeze(degraded ? [`particle-count:${requested}->${particles.length}`] : []);
  return Object.freeze({ particles: Object.freeze(particles), evidence: Object.freeze({
    requestedParticleCount: requested, emittedParticleCount: particles.length, capacity,
    degraded, degradationReasons: reasons, emitterCounts: Object.freeze(emitterCounts),
  }) });
}

/** Allocates one existing GpuParticleRuntime; this creates no second simulation path. */
export function createGpuParticleRuntimeFromEmitters(session: DeviceSession, deviceEpoch: string,
  emitters: readonly GpuParticleEmitter[], options: GpuParticleEmitterRuntimeOptions = {}):
GpuParticleEmitterRuntimeSetup {
  const requested = normalizeEmitters(emitters).reduce((sum, emitter) => sum + emitter.count, 0);
  const automatic = Math.min(GPU_PARTICLE_DEFAULT_CAPACITY,
    Math.max(1_024, 2 ** Math.ceil(Math.log2(Math.max(requested, 1)))));
  const desired = options.capacity ?? automatic;
  const resolved = resolveGpuParticleCapacity(session.device, desired, 0);
  const program = compileGpuParticleEmitters(emitters, resolved.capacity);
  const runtime = new GpuParticleRuntime(session, deviceEpoch,
    { capacity: resolved.capacity, initialParticles: program.particles });
  return Object.freeze({ runtime, program });
}

/** Presets use constant velocity, so GPU lifetime wrapping stays spatially continuous. */
export function submitGpuParticleEmitterFrame(runtime: GpuParticleRuntime,
  input: GpuParticleEmitterFrameInput, signal?: AbortSignal): Promise<GpuParticleFrameResult> {
  return runtime.beginFrame({ ...input, acceleration: [0, 0, 0], drag: 0 }, signal);
}

function normalizeEmitters(values: readonly GpuParticleEmitter[]): readonly NormalizedEmitter[] {
  if (!Array.isArray(values) || values.length > 64) throw new RangeError("Emitters must be an array of at most 64 items.");
  const ids = new Set<string>();
  return Object.freeze((values as readonly GpuParticleEmitter[]).map((source, index) => {
    if (!source || typeof source !== "object" || !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$/.test(source.id)
      || ids.has(source.id) || typeof source.preset !== "string" || !(source.preset in DEFAULTS)) {
      throw new TypeError(`Emitter ${index} is invalid.`);
    }
    ids.add(source.id); const defaults = DEFAULTS[source.preset];
    validatePreset(source, index);
    const color = source.color ?? defaults.color;
    if (!Array.isArray(color) || color.length !== 4
      || color.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 65_504)) {
      throw new RangeError(`Emitter ${source.id} color is invalid.`);
    }
    return Object.freeze({ source, count: integer(source.count ?? defaults.count,
      `emitters[${index}].count`, 1, 65_536),
    lifetime: finite(source.lifetime ?? defaults.lifetime, `emitters[${index}].lifetime`, 0.01, 3_600),
    color: Object.freeze([...color]) as ParticleColor,
    size: finite(source.size ?? defaults.size, `emitters[${index}].size`, 0.0001, 1e6),
    seed: integer(source.seed ?? hash(source.id), `emitters[${index}].seed`, 0, 0xffffffff) });
  }));
}
function validatePreset(source: GpuParticleEmitter, index: number): void {
  if (source.preset === "alarm-pulse") { vector(source.position, `emitters[${index}].position`); return; }
  if (source.preset === "expanding-ring") {
    vector(source.center, `emitters[${index}].center`);
    const inner = finite(source.innerRadius ?? 0, `emitters[${index}].innerRadius`, 0, 1e6);
    const outer = finite(source.outerRadius ?? 3, `emitters[${index}].outerRadius`, 0.0001, 1e6);
    if (outer <= inner) throw new RangeError(`Emitter ${source.id} outerRadius must exceed innerRadius.`);
    return;
  }
  const start = vector(source.start, `emitters[${index}].start`), end = vector(source.end, `emitters[${index}].end`);
  if (distance(start, end) <= 1e-6) throw new RangeError(`Emitter ${source.id} flow line has zero length.`);
}

function createSeed(emitter: NormalizedEmitter, index: number, count: number, id: number): GpuParticleSeed {
  const random = noise(emitter.seed, index), phase = (index + random * 0.5) / count;
  const common = { id, lifetime: emitter.lifetime, age: phase * emitter.lifetime,
    color: emitter.color, size: emitter.size, flags: GPU_PARTICLE_FLAG_LOOP } as const;
  const source = emitter.source;
  if (source.preset === "alarm-pulse") return { ...common, position: source.position,
    velocity: [0, 0, 0], rotation: random * Math.PI * 2,
    flags: GPU_PARTICLE_FLAG_LOOP | GPU_PARTICLE_FLAG_PULSE };
  if (source.preset === "expanding-ring") {
    const angle = Math.PI * 2 * ((index + random * 0.25) / count), direction = [Math.cos(angle), 0, Math.sin(angle)] as const;
    const inner = source.innerRadius ?? 0, outer = source.outerRadius ?? 3;
    const speed = (outer - inner) / emitter.lifetime, radius = inner + (outer - inner) * phase;
    return { ...common, position: add(source.center, scale(direction, radius)),
      velocity: scale(direction, speed), rotation: -angle };
  }
  const delta = subtract(source.end, source.start), speed = scale(delta, 1 / emitter.lifetime);
  return { ...common, position: add(source.start, scale(delta, phase)), velocity: speed,
    rotation: Math.atan2(delta[1], delta[0]) };
}

function allocateCounts(requests: readonly number[], capacity: number): number[] {
  const total = requests.reduce((sum, value) => sum + value, 0);
  if (total <= capacity) return [...requests];
  const exact = requests.map(value => value * capacity / total), result = exact.map(Math.floor);
  let remaining = capacity - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const item of order) { if (!remaining) break; if (result[item.index]! < requests[item.index]!) {
    result[item.index] = result[item.index]! + 1; remaining--;
  } }
  return result;
}
function hash(value: string): number { let result = 2166136261; for (const char of value) {
  result = Math.imul(result ^ char.charCodeAt(0), 16777619); } return result >>> 0; }
function noise(seed: number, index: number): number { let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b); return ((value ^ value >>> 16) >>> 0) / 0x100000000; }
function vector(value: ParticleVector3, name: string): ParticleVector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must contain three values.`);
  value.forEach((item, axis) => finite(item, `${name}[${axis}]`, -1e9, 1e9)); return value;
}
function finite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`); } return value;
}
function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}.`); } return value;
}
function add(a: ParticleVector3, b: ParticleVector3): ParticleVector3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract(a: ParticleVector3, b: ParticleVector3): ParticleVector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(value: ParticleVector3, amount: number): ParticleVector3 { return [value[0] * amount, value[1] * amount, value[2] * amount]; }
function distance(a: ParticleVector3, b: ParticleVector3): number { return Math.hypot(...subtract(a, b)); }
