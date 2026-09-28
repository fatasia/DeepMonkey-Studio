import type { LightVector3 } from "../lighting/types.js";

/**
 * T04 local-light shadow cache invalidation strategy (CPU logic only).
 *
 * Shadows are view-independent, so only light signature changes and occluder
 * movement inside a light's influence sphere invalidate a cached shadow page.
 * A frozen scene plans zero updates, a moving light invalidates only its own
 * pages, and a removed light is evicted so no stale shadow can survive.
 * 语义契约：`update` 集合 = 本帧必须重渲并写缓存的灯；`reuse` = 缓存有效；
 * `evict` = 已删除的灯，消费方必须释放其页。三者互斥且并集 = 上帧 ∪ 本帧灯集。
 */

export interface LocalShadowLightState {
  readonly key: string;
  readonly position: LightVector3;
  /** Spot direction; points omit it. Part of the change signature. */
  readonly direction?: LightVector3;
  readonly range: number;
  readonly intensity: number;
  readonly castShadow: boolean;
  /** Bump when non-scalar shadow config (softness, IES) changes. */
  readonly configEpoch?: number;
}

export interface LocalShadowOccluderState {
  readonly id: string;
  readonly min: LightVector3;
  readonly max: LightVector3;
}

export interface LocalShadowFrameInput {
  readonly frame: number;
  readonly lights: readonly LocalShadowLightState[];
  readonly occluders: readonly LocalShadowOccluderState[];
}

export interface LocalShadowInvalidationStats {
  readonly lightsTotal: number;
  readonly lightsUpdated: number;
  readonly lightsReused: number;
  readonly lightsEvicted: number;
  readonly occludersChanged: number;
}

export interface LocalShadowInvalidationPlan {
  readonly frame: number;
  /** Lights that must re-render and re-commit their cached shadow pages. */
  readonly update: readonly string[];
  /** Lights whose cached shadow pages remain valid; skip rendering. */
  readonly reuse: readonly string[];
  /** Lights removed from the scene; consumers must free their pages. */
  readonly evict: readonly string[];
  readonly stats: LocalShadowInvalidationStats;
}

/** Rounds scalars to a stable string signature; -0 normalizes to 0. */
function signature(values: readonly (number | string | boolean | undefined)[]): string {
  return values.map(value => typeof value === "number" && Object.is(value, -0) ? "0" : String(value)).join(",");
}

function lightSignature(light: LocalShadowLightState): string {
  return signature([light.position[0], light.position[1], light.position[2],
    ...(light.direction ? [light.direction[0], light.direction[1], light.direction[2]] : []),
    light.range, light.intensity, light.castShadow, light.configEpoch]);
}

function occluderSignature(occluder: LocalShadowOccluderState): string {
  return signature([occluder.min[0], occluder.min[1], occluder.min[2],
    occluder.max[0], occluder.max[1], occluder.max[2]]);
}

/** Conservative sphere-vs-AABB overlap between a light's influence and an occluder. */
export function lightInfluencesOccluder(light: LocalShadowLightState, occluder: LocalShadowOccluderState): boolean {
  if (!(light.range > 0) || !light.castShadow) return false;
  const [px, py, pz] = light.position;
  const closest = [
    Math.max(occluder.min[0], Math.min(px, occluder.max[0])),
    Math.max(occluder.min[1], Math.min(py, occluder.max[1])),
    Math.max(occluder.min[2], Math.min(pz, occluder.max[2])),
  ] as const;
  const dx = closest[0] - px, dy = closest[1] - py, dz = closest[2] - pz;
  return dx * dx + dy * dy + dz * dz <= light.range * light.range;
}

function validateLight(light: LocalShadowLightState): void {
  if (!light || typeof light !== "object") throw new TypeError("Local shadow light state must be an object.");
  if (typeof light.key !== "string" || light.key.length === 0) throw new TypeError("Local shadow light key must be a non-empty string.");
  if (![light.position, ...(light.direction ? [light.direction] : [])].every(position => position.length === 3
    && position.every(Number.isFinite))) throw new TypeError(`Light ${light.key} needs finite 3-component vectors.`);
  if (!Number.isFinite(light.range) || light.range < 0) throw new TypeError(`Light ${light.key} range must be finite and non-negative.`);
  if (!Number.isFinite(light.intensity)) throw new TypeError(`Light ${light.key} intensity must be finite.`);
  if (typeof light.castShadow !== "boolean") throw new TypeError(`Light ${light.key} castShadow must be boolean.`);
}

function validateOccluder(occluder: LocalShadowOccluderState): void {
  if (!occluder || typeof occluder !== "object") throw new TypeError("Local shadow occluder must be an object.");
  if (typeof occluder.id !== "string" || occluder.id.length === 0) throw new TypeError("Occluder id must be a non-empty string.");
  if ([occluder.min, occluder.max].some(bound => bound.length !== 3 || !bound.every(Number.isFinite))) {
    throw new TypeError(`Occluder ${occluder.id} needs finite 3-component bounds.`);
  }
}

/**
 * Stateless-per-call cache planner: one `plan` call diffs the frame against
 * the committed state and commits the result. Duplicate light keys or
 * occluder ids in one frame throw, so consumers cannot silently merge.
 */
export class LocalShadowCache {
  private readonly rendered = new Map<string, string>();
  private readonly occluders = new Map<string, LocalShadowOccluderState>();

  get cachedLightCount(): number { return this.rendered.size; }

  reset(): void {
    this.rendered.clear();
    this.occluders.clear();
  }

  plan(input: LocalShadowFrameInput): LocalShadowInvalidationPlan {
    if (!input || typeof input !== "object") throw new TypeError("Local shadow frame input must be an object.");
    if (!Number.isSafeInteger(input.frame) || input.frame < 0) throw new RangeError("Frame index must be a non-negative safe integer.");
    const lights = input.lights ?? [], occluders = input.occluders ?? [];
    const lightByKey = new Map<string, LocalShadowLightState>();
    for (const light of lights) {
      validateLight(light);
      if (lightByKey.has(light.key)) throw new Error(`Duplicate light key ${light.key} in one frame.`);
      lightByKey.set(light.key, light);
    }
    const occluderById = new Map<string, LocalShadowOccluderState>();
    for (const occluder of occluders) {
      validateOccluder(occluder);
      if (occluderById.has(occluder.id)) throw new Error(`Duplicate occluder id ${occluder.id} in one frame.`);
      occluderById.set(occluder.id, occluder);
    }

    // 1. Occluder diffs: any change (move, add, remove) invalidates lights the
    // old OR new bounds influence — entering and leaving both leave residue.
    const changedOccluderIds: string[] = [];
    for (const [id, occluder] of occluderById) {
      const previous = this.occluders.get(id);
      if (!previous || occluderSignature(previous) !== occluderSignature(occluder)) changedOccluderIds.push(id);
    }
    for (const id of this.occluders.keys()) {
      if (!occluderById.has(id)) changedOccluderIds.push(id);
    }
    const occluderInvalidated = new Set<string>();
    for (const id of changedOccluderIds) {
      const current = occluderById.get(id), previous = this.occluders.get(id);
      for (const light of lightByKey.values()) {
        if ((current && lightInfluencesOccluder(light, current))
          || (previous && lightInfluencesOccluder(light, previous))) occluderInvalidated.add(light.key);
      }
    }

    // 2. Classify lights: a non-shadow-casting light needs no shadow work at
    // all (reused as "nothing to do"); signature change or occluder hit ->
    // update; gone -> evict; else reuse.
    const update: string[] = [], reuse: string[] = [], evict: string[] = [];
    for (const [key, light] of lightByKey) {
      const invalidated = light.castShadow
        && (lightSignature(light) !== this.rendered.get(key) || occluderInvalidated.has(key));
      if (invalidated) update.push(key); else reuse.push(key);
    }
    for (const key of this.rendered.keys()) {
      if (!lightByKey.has(key)) evict.push(key);
    }

    // 3. Commit: rendered signatures and occluder snapshots advance atomically.
    this.rendered.clear();
    for (const [key, light] of lightByKey) {
      if (light.castShadow) this.rendered.set(key, lightSignature(light));
    }
    this.occluders.clear();
    for (const [id, occluder] of occluderById) this.occluders.set(id, occluder);

    const order = (left: string, right: string): number => left.localeCompare(right);
    const stats: LocalShadowInvalidationStats = Object.freeze({
      lightsTotal: lights.length, lightsUpdated: update.length, lightsReused: reuse.length,
      lightsEvicted: evict.length, occludersChanged: changedOccluderIds.length,
    });
    return Object.freeze({ frame: input.frame, update: Object.freeze(update.sort(order)),
      reuse: Object.freeze(reuse.sort(order)), evict: Object.freeze(evict.sort(order)), stats });
  }
}
