/**
 * T20 切片:CPU 发射与模拟统计参考模型(同公式异实现)。
 *
 * 公式源(只读底座,本文件不替代 GPU 路径):
 * - RNG:与 `webgpu/gpuParticleEmitters.ts` 的 `noise(seed,index)` 同一整数混淆链
 *   (0x9e3779b1 / 0x7feb352d / 0x846ca68b,32 位全量除数)。
 * - 发射:`createSeed` 的 phase / 环形角 / 线段分布公式逐项一致。
 * - 积分:`GPU_PARTICLE_COMPUTE_WGSL.simulateAndCompact` 同公式(死亡判定、
 *   damping=exp(-drag*dt)、半隐式速度、loop 回绕),CPU 用 f64 实现。
 *
 * 对照口径:CPU 参考与 GPU 核是"同公式异实现",只做统计级对照(计数/分布/指纹),
 * 不承诺 f32 逐位一致——GPU f32 逐位对拍留真机联测。确定性域 = 同一运行时
 * (同 Node/V8 构建)内,同 seed 两次模拟逐位一致;`fingerprint` 是逐位一致的主证据。
 */

export type ReferenceEmitterPreset = "alarm-pulse" | "expanding-ring" | "flow-line";
export type ReferenceVec3 = readonly [number, number, number];

export interface ReferenceEmitterConfig {
  readonly id: string;
  readonly preset: ReferenceEmitterPreset;
  readonly count: number;
  readonly lifetime: number;
  readonly seed?: number;
  readonly position?: ReferenceVec3;
  readonly center?: ReferenceVec3;
  readonly innerRadius?: number;
  readonly outerRadius?: number;
  readonly start?: ReferenceVec3;
  readonly end?: ReferenceVec3;
}

export interface ReferenceParticle {
  readonly id: number;
  readonly emitterId: string;
  readonly position: ReferenceVec3;
  readonly velocity: ReferenceVec3;
  readonly age: number;
  readonly lifetime: number;
  readonly loop: boolean;
}

export interface ReferenceFrameInput {
  readonly deltaTime: number;
  readonly drag?: number;
  readonly acceleration?: ReferenceVec3;
}

export interface DistributionSummary {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
}

export interface ParticleSimulationStatistics {
  readonly emitterId: string;
  readonly seed: number;
  readonly frameCount: number;
  readonly emittedCount: number;
  readonly firstFrameAlive: number;
  readonly lastFrameAlive: number;
  readonly deaths: number;
  readonly wraps: number;
  readonly nonFinitePurged: number;
  readonly lifetime: DistributionSummary;
  readonly initialSpeed: DistributionSummary;
  readonly fingerprint: string;
}

export interface ParticleSystemSimulationResult {
  readonly emitters: readonly ParticleSimulationStatistics[];
  readonly emittedCount: number;
  readonly fingerprint: string;
}

/** 与底座 noise() 同公式:确定性 32 位混淆,输出 [0,1)。 */
export function particleNoise(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return ((value ^ value >>> 16) >>> 0) / 0x100000000;
}

/** 与底座 hash() 同公式(FNV-1a):id 字符串 → 默认 seed。 */
export function particleIdHash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}
function finite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`);
  }
  return value;
}
function vec3(value: ReferenceVec3 | undefined, name: string, fallback: ReferenceVec3): ReferenceVec3 {
  const resolved = value ?? fallback;
  if (!Array.isArray(resolved) || resolved.length !== 3) throw new TypeError(`${name} must contain three values.`);
  resolved.forEach((item, axis) => finite(item, `${name}[${axis}]`, -1e9, 1e9));
  return Object.freeze([...resolved]) as ReferenceVec3;
}
function add(a: ReferenceVec3, b: ReferenceVec3): ReferenceVec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract(a: ReferenceVec3, b: ReferenceVec3): ReferenceVec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(value: ReferenceVec3, amount: number): ReferenceVec3 {
  return [value[0] * amount, value[1] * amount, value[2] * amount];
}

function normalizeEmitter(config: ReferenceEmitterConfig, index: number): Required<ReferenceEmitterConfig> {
  if (!config || !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$/.test(String(config.id))) {
    throw new TypeError(`Emitters[${index}].id is invalid.`);
  }
  const count = integer(config.count, `emitters[${index}].count`, 1, 65_536);
  const lifetime = finite(config.lifetime, `emitters[${index}].lifetime`, 0.01, 3_600);
  const seed = integer(config.seed ?? particleIdHash(config.id), `emitters[${index}].seed`, 0, 0xffffffff);
  if (config.preset === "alarm-pulse") {
    return { ...config, count, lifetime, seed, position: vec3(config.position, `emitters[${index}].position`, [0, 0, 0]) } as Required<ReferenceEmitterConfig>;
  }
  if (config.preset === "expanding-ring") {
    const inner = finite(config.innerRadius ?? 0, `emitters[${index}].innerRadius`, 0, 1e6);
    const outer = finite(config.outerRadius ?? 3, `emitters[${index}].outerRadius`, 0.0001, 1e6);
    if (outer <= inner) throw new RangeError(`emitters[${index}] outerRadius must exceed innerRadius.`);
    return { ...config, count, lifetime, seed, innerRadius: inner, outerRadius: outer,
      center: vec3(config.center, `emitters[${index}].center`, [0, 0, 0]) } as Required<ReferenceEmitterConfig>;
  }
  const start = vec3(config.start, `emitters[${index}].start`, [0, 0, 0]);
  const end = vec3(config.end, `emitters[${index}].end`, [0, 1, 0]);
  if (Math.hypot(...subtract(start, end)) <= 1e-6) {
    throw new RangeError(`emitters[${index}] flow line has zero length.`);
  }
  return { ...config, count, lifetime, seed, start, end } as Required<ReferenceEmitterConfig>;
}

/** 与底座 createSeed 同公式:预设种子(三预设均为 loop 粒子)。 */
export function createReferenceEmitterSeeds(config: ReferenceEmitterConfig,
  idBase: number): readonly ReferenceParticle[] {
  const emitter = normalizeEmitter(config, 0);
  const seeds: ReferenceParticle[] = [];
  for (let index = 0; index < emitter.count; index++) {
    const random = particleNoise(emitter.seed, index);
    const phase = (index + random * 0.5) / emitter.count;
    const common = { id: idBase + index, emitterId: emitter.id, lifetime: emitter.lifetime,
      age: phase * emitter.lifetime, loop: true } as const;
    if (emitter.preset === "alarm-pulse") {
      seeds.push({ ...common, position: emitter.position as ReferenceVec3, velocity: [0, 0, 0] });
      continue;
    }
    if (emitter.preset === "expanding-ring") {
      const angle = Math.PI * 2 * ((index + random * 0.25) / emitter.count);
      const direction: ReferenceVec3 = [Math.cos(angle), 0, Math.sin(angle)];
      const inner = emitter.innerRadius ?? 0, outer = emitter.outerRadius ?? 3;
      const speed = (outer - inner) / emitter.lifetime, radius = inner + (outer - inner) * phase;
      seeds.push({ ...common, position: add(emitter.center as ReferenceVec3, scale(direction, radius)),
        velocity: scale(direction, speed) });
      continue;
    }
    const delta = subtract(emitter.end as ReferenceVec3, emitter.start as ReferenceVec3);
    seeds.push({ ...common, position: add(emitter.start as ReferenceVec3, scale(delta, phase)),
      velocity: scale(delta, 1 / emitter.lifetime) });
  }
  return Object.freeze(seeds);
}

export interface ReferenceStepOutcome {
  readonly particle: ReferenceParticle | undefined;
  readonly wrapped: boolean;
  readonly nonFinite: boolean;
}

/** 与 GPU simulateAndCompact 同公式的一粒子步进;undefined = 死亡(被压缩丢弃)。 */
export function stepReferenceParticle(particle: ReferenceParticle, input: ReferenceFrameInput): ReferenceStepOutcome {
  const deltaTime = finite(input.deltaTime, "deltaTime", 0, 0.25);
  const drag = finite(input.drag ?? 0, "drag", 0, 100);
  const acceleration = vec3(input.acceleration, "acceleration", [0, -9.81, 0]);
  let age = particle.age + deltaTime;
  if (age >= particle.lifetime && !particle.loop) return Object.freeze({ particle: undefined, wrapped: false, nonFinite: false });
  const damping = Math.exp(-drag * deltaTime);
  const velocity: ReferenceVec3 = [
    (particle.velocity[0] + acceleration[0] * deltaTime) * damping,
    (particle.velocity[1] + acceleration[1] * deltaTime) * damping,
    (particle.velocity[2] + acceleration[2] * deltaTime) * damping];
  let position: ReferenceVec3 = add(particle.position, scale(velocity, deltaTime));
  let wrapped = false;
  if (particle.loop && age >= particle.lifetime) {
    const cycles = Math.floor(age / particle.lifetime);
    age -= cycles * particle.lifetime;
    position = subtract(position, scale(velocity, particle.lifetime * cycles));
    wrapped = true;
  }
  const finiteState = position.every(Number.isFinite) && velocity.every(Number.isFinite);
  if (!finiteState) return Object.freeze({ particle: undefined, wrapped, nonFinite: true });
  return Object.freeze({ particle: { ...particle, position, velocity, age }, wrapped, nonFinite: false });
}

function summarize(values: readonly number[]): DistributionSummary {
  if (values.length < 1) throw new RangeError("Distribution requires at least one sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * (sorted.length - 1)))]!;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Object.freeze({ mean: total / values.length, min: sorted[0]!, max: sorted[sorted.length - 1]!,
    p50: quantile(0.5), p95: quantile(0.95) });
}

/** 逐帧状态指纹:整数滚动哈希,同 seed 逐位一致 ⇔ 指纹相等。 */
function advanceFingerprint(fingerprint: number, value: number): number {
  const bits = Math.fround(value) * 1000;
  let hash = (fingerprint ^ Math.imul(bits | 0, 0x9e3779b1)) >>> 0;
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ hash >>> 16) >>> 0;
}

/** 单发射器统计模拟:发射计数、生命周期/初速分布、逐帧存活与死亡、确定性指纹。 */
export function simulateEmitterStatistics(config: ReferenceEmitterConfig, frames: number,
  input: ReferenceFrameInput): ParticleSimulationStatistics {
  const frameCount = integer(frames, "frames", 1, 1_000_000);
  const emitter = normalizeEmitter(config, 0);
  let particles = createReferenceEmitterSeeds(config, 0).slice();
  const initial = particles.slice();
  const lifetimes = initial.map(seed => seed.lifetime);
  const speeds = initial.map(seed => Math.hypot(...seed.velocity));
  let fingerprint = emitter.seed >>> 0;
  let deaths = 0, wraps = 0, nonFinite = 0, firstAlive = -1, lastAlive = 0;
  initial.forEach(seed => { fingerprint = advanceFingerprint(fingerprint, seed.position[0]!); });
  for (let frame = 0; frame < frameCount; frame++) {
    const next: ReferenceParticle[] = [];
    for (const particle of particles) {
      const outcome = stepReferenceParticle(particle, input);
      if (outcome.nonFinite) { nonFinite++; continue; }
      if (!outcome.particle) { deaths++; continue; }
      if (outcome.wrapped) wraps++;
      next.push(outcome.particle);
    }
    particles = next;
    if (particles.length > 0) {
      if (firstAlive < 0) firstAlive = frame;
      lastAlive = frame;
    }
    particles.forEach((particle, index) => {
      fingerprint = advanceFingerprint(fingerprint, particle.position[index % 3]!);
      fingerprint = advanceFingerprint(fingerprint, particle.age);
    });
    fingerprint = advanceFingerprint(fingerprint, particles.length);
  }
  return Object.freeze({ emitterId: emitter.id, seed: emitter.seed, frameCount,
    emittedCount: initial.length, firstFrameAlive: firstAlive, lastFrameAlive: lastAlive,
    deaths, wraps, nonFinitePurged: nonFinite,
    lifetime: summarize(lifetimes), initialSpeed: summarize(speeds),
    fingerprint: fingerprint.toString(16).padStart(8, "0") });
}

/** 多发射器系统级统计:总发射数与系统指纹(按发射器声明顺序组合)。 */
export function simulateParticleSystemStatistics(configs: readonly ReferenceEmitterConfig[], frames: number,
  input: ReferenceFrameInput): ParticleSystemSimulationResult {
  if (!Array.isArray(configs) || configs.length < 1 || configs.length > 64) {
    throw new RangeError("Configs must contain between 1 and 64 emitters.");
  }
  let systemFingerprint = 0x5ea0_0000, total = 0;
  const emitters = configs.map((config, index) => {
    const stats = simulateEmitterStatistics(config, frames, input);
    total += stats.emittedCount;
    systemFingerprint = (Math.imul(systemFingerprint ^ Number.parseInt(stats.fingerprint, 16), 16777619)) >>> 0;
    return stats;
  });
  return Object.freeze({ emitters: Object.freeze(emitters), emittedCount: total,
    fingerprint: systemFingerprint.toString(16).padStart(8, "0") });
}
