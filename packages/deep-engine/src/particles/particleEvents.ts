/**
 * T20 切片:粒子事件流(出生 / 死亡 / 碰撞标记),确定性输出。
 *
 * 事件口径:
 * - `spawn`:粒子进入活跃集(初始发射或 loop 回绕重新出生,与底座 FLAG_LOOP 语义一致);
 * - `death`:age ≥ lifetime 且非 loop(GPU 核中被 compaction 丢弃的时刻);
 * - `collision`:粒子位置穿越解析碰撞平面(法向速度按 restitution 反弹,确定性)。
 *   每个粒子全程只记录首个碰撞,防事件爆炸。
 *
 * 确定性:事件按 (frame, id, kind) 排序;同输入两次生成逐位一致。事件预算
 * `eventLimit` 溢出时截断并记录 `event-limit:A->B`(量化降级,沿底座字符串格式)。
 * GPU 侧事件读回(读回缓冲/时间戳对照)留真机联测,本文件是 CPU 统计口径源。
 */

import { createReferenceEmitterSeeds, stepReferenceParticle, type ReferenceEmitterConfig,
  type ReferenceFrameInput, type ReferenceParticle, type ReferenceVec3 } from "./particleStats.js";

export type ParticleEventKind = "collision" | "death" | "spawn";

export interface ParticleEvent {
  readonly frame: number;
  readonly id: number;
  readonly kind: ParticleEventKind;
  readonly emitterId: string;
}

export interface ParticleCollisionPlane {
  /** 单位法向(内部归一化校验);障碍占据 n·x ≤ offset 一侧。 */
  readonly normal: ReferenceVec3;
  readonly offset: number;
  readonly restitution?: number;
}

export interface ParticleEventOptions {
  readonly eventLimit?: number;
  readonly planes?: readonly ParticleCollisionPlane[];
  /** true = 按 GPU burst 语义发射非 loop 粒子(flags=0),产生 death 事件。 */
  readonly nonLoopParticles?: boolean;
}

export interface ParticleEventStats {
  readonly spawns: number;
  readonly deaths: number;
  readonly collisions: number;
  readonly emitted: number;
  readonly truncated: boolean;
  readonly degradationReasons: readonly string[];
}

export interface ParticleEventResult {
  readonly events: readonly ParticleEvent[];
  readonly stats: ParticleEventStats;
  /** 终态活跃粒子(碰撞反弹已应用)。 */
  readonly finalParticles: readonly ReferenceParticle[];
}

function finite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`);
  }
  return value;
}

function normalizePlanes(planes: readonly ParticleCollisionPlane[]): readonly {
  readonly normal: ReferenceVec3; readonly offset: number; readonly restitution: number }[] {
  if (planes.length > 16) throw new RangeError("planes must contain at most 16 items.");
  return Object.freeze(planes.map((plane, index) => {
    if (!plane || !Array.isArray(plane.normal) || plane.normal.length !== 3) {
      throw new TypeError(`planes[${index}].normal is invalid.`);
    }
    const length = Math.hypot(...plane.normal);
    if (!Number.isFinite(length) || length <= 1e-9) throw new RangeError(`planes[${index}].normal is degenerate.`);
    return Object.freeze({
      normal: Object.freeze(plane.normal.map(axis => axis / length)) as ReferenceVec3,
      offset: finite(plane.offset, `planes[${index}].offset`, -1e9, 1e9),
      restitution: finite(plane.restitution ?? 0.5, `planes[${index}].restitution`, 0, 1),
    });
  }));
}

function signedDistance(plane: { readonly normal: ReferenceVec3; readonly offset: number },
  position: ReferenceVec3): number {
  return plane.normal[0] * position[0] + plane.normal[1] * position[1]
    + plane.normal[2] * position[2] - plane.offset;
}

/** 生成确定性事件流:出生 / 死亡 / 碰撞,含事件预算截断与终态粒子。 */
export function simulateParticleEvents(configs: readonly ReferenceEmitterConfig[], frames: number,
  input: ReferenceFrameInput, options: ParticleEventOptions = {}): ParticleEventResult {
  if (!Array.isArray(configs) || configs.length < 1 || configs.length > 64) {
    throw new RangeError("Configs must contain between 1 and 64 emitters.");
  }
  const frameCount = frames;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 1_000_000) {
    throw new RangeError("frames must be an integer in 1..1000000.");
  }
  const eventLimit = options.eventLimit === undefined ? 4_096
    : Math.floor(options.eventLimit);
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 1_048_576) {
    throw new RangeError("eventLimit must be an integer in 1..1048576.");
  }
  const planes = normalizePlanes(options.planes ?? []);
  const particles: ReferenceParticle[] = [];
  const emitterIds = new Map<number, string>();
  const nonLoop = options.nonLoopParticles === true;
  configs.forEach((config, index) => {
    const seeds = createReferenceEmitterSeeds(config, index * config.count)
      .map(seed => nonLoop ? { ...seed, loop: false } : seed);
    seeds.forEach(seed => emitterIds.set(seed.id, config.id));
    particles.push(...seeds);
  });
  const emitted = particles.length;
  const collisionSeen = new Set<number>();
  const events: ParticleEvent[] = [];
  const record = (frame: number, id: number, kind: ParticleEventKind, emitterId: string): void => {
    if (events.length < eventLimit) events.push(Object.freeze({ frame, id, kind, emitterId }));
  };
  let active = particles.slice();
  active.forEach((particle, index) => record(0, particle.id, "spawn", emitterIds.get(particle.id) ?? `e${index}`));
  for (let frame = 1; frame <= frameCount; frame++) {
    const next: ReferenceParticle[] = [];
    for (const particle of active) {
      const outcome = stepReferenceParticle(particle, input);
      const emitterId = emitterIds.get(particle.id)!;
      if (!outcome.particle) {
        record(frame, particle.id, "death", emitterId);
        continue;
      }
      if (outcome.wrapped) record(frame, particle.id, "spawn", emitterId);
      let current = outcome.particle;
      const previous = particle.position;
      for (const plane of planes) {
        if (collisionSeen.has(current.id)) break;
        const before = signedDistance(plane, previous);
        const after = signedDistance(plane, current.position);
        if (before > 0 && after <= 0) {
          collisionSeen.add(current.id);
          record(frame, current.id, "collision", emitterId);
          const dot = plane.normal[0] * current.velocity[0] + plane.normal[1] * current.velocity[1]
            + plane.normal[2] * current.velocity[2];
          if (dot < 0) {
            const scale = (1 + plane.restitution) * dot;
            current = { ...current, velocity: [
              current.velocity[0] - plane.normal[0] * scale,
              current.velocity[1] - plane.normal[1] * scale,
              current.velocity[2] - plane.normal[2] * scale] };
          }
        }
      }
      next.push(current);
    }
    active = next;
  }
  const truncated = events.length >= eventLimit;
  const reasons = truncated ? Object.freeze([`event-limit:${events.length}`]) : Object.freeze([] as string[]);
  const spawns = events.filter(event => event.kind === "spawn").length;
  const deaths = events.filter(event => event.kind === "death").length;
  const collisions = events.filter(event => event.kind === "collision").length;
  return Object.freeze({ events: Object.freeze(events), finalParticles: Object.freeze(active),
    stats: Object.freeze({ spawns, deaths, collisions, emitted, truncated, degradationReasons: reasons }) });
}
