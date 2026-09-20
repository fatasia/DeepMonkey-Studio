import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";

const MAX_SURFACES = 65_536;
export const MAX_PROBE_SURFACE_FRAME_BOUNDS = 64;
const SURFACE_ID = /^[0-9A-Za-z][0-9A-Za-z._:/-]{0,255}$/;
const MAX_COORDINATE = 1_000_000_000;

export interface ProbeSurfaceCacheEntry {
  readonly id: string;
  /** Geometry/material/transform changes must monotonically advance this revision. */
  readonly revision: number;
  readonly bounds: ProbeAabb;
  /** Dynamic entries are refreshed every frame, not only after a revision change. */
  readonly dynamic?: boolean;
}

export interface ProbeSurfaceCacheFrame {
  readonly revision: number;
  readonly dirtyBounds: readonly ProbeAabb[];
  readonly dynamicBounds: readonly ProbeAabb[];
}

interface PendingInvalidation { readonly revision: number; readonly bounds: ProbeAabb }

/** Tracks surface-cache invalidation until a GPU probe publication commits. */
export class ProbeSurfaceCache {
  private readonly surfaces = new Map<string, ProbeSurfaceCacheEntry>();
  private readonly pending = new Map<string, PendingInvalidation>();
  private mutationRevision = 0;

  get size(): number { return this.surfaces.size; }
  get pendingCount(): number { return this.pending.size; }

  /** Read-only occluder bounds in canonical id order; consumed by probe relocation. */
  snapshotBounds(): readonly ProbeAabb[] {
    return Object.freeze([...this.surfaces.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(entry => entry.bounds));
  }

  upsert(input: ProbeSurfaceCacheEntry): boolean {
    const entry = normalizeEntry(input);
    const previous = this.surfaces.get(entry.id);
    if (previous) {
      if (entry.revision < previous.revision) throw new Error(`Surface cache revision regressed for ${entry.id}.`);
      if (entry.revision === previous.revision) {
        if (sameEntry(previous, entry)) return false;
        throw new Error(`Surface cache content changed without advancing revision for ${entry.id}.`);
      }
    } else if (this.surfaces.size >= MAX_SURFACES) {
      throw new RangeError(`Surface cache exceeds ${MAX_SURFACES} entries.`);
    }
    this.surfaces.set(entry.id, entry);
    this.invalidate(entry.id, previous ? unionBounds(previous.bounds, entry.bounds) : entry.bounds);
    return true;
  }

  remove(id: string): boolean {
    assertId(id);
    const previous = this.surfaces.get(id);
    if (!previous) return false;
    this.surfaces.delete(id);
    this.invalidate(id, previous.bounds);
    return true;
  }

  beginFrame(): ProbeSurfaceCacheFrame {
    const dirtyBounds = compactProbeBounds(
      [...this.pending.entries()].sort(compareId).map(([, value]) => value.bounds));
    const dynamicBounds = compactProbeBounds([...this.surfaces.values()].filter(entry => entry.dynamic)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(entry => entry.bounds));
    return Object.freeze({ revision: this.mutationRevision,
      dirtyBounds: Object.freeze(dirtyBounds), dynamicBounds: Object.freeze(dynamicBounds) });
  }

  /** Clears only invalidations represented by a successfully published frame. */
  commit(frame: ProbeSurfaceCacheFrame): void {
    if (!Number.isSafeInteger(frame.revision) || frame.revision < 0 || frame.revision > this.mutationRevision) {
      throw new RangeError("Surface cache frame revision is invalid.");
    }
    for (const [id, value] of this.pending) if (value.revision <= frame.revision) this.pending.delete(id);
  }

  private invalidate(id: string, bounds: ProbeAabb): void {
    const revision = ++this.mutationRevision;
    const pending = this.pending.get(id);
    this.pending.set(id, Object.freeze({ revision,
      bounds: pending ? unionBounds(pending.bounds, bounds) : bounds }));
  }
}

/** Deterministically unions adjacent identity-sorted regions to the probe planner's 64-box budget. */
export function compactProbeBounds(bounds: readonly ProbeAabb[], limit = MAX_PROBE_SURFACE_FRAME_BOUNDS): readonly ProbeAabb[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PROBE_SURFACE_FRAME_BOUNDS) {
    throw new RangeError(`Surface cache bounds limit must be in 0..${MAX_PROBE_SURFACE_FRAME_BOUNDS}.`);
  }
  if (limit === 0 || bounds.length === 0) return Object.freeze([]);
  if (bounds.length <= limit) return Object.freeze([...bounds]);
  const compacted: ProbeAabb[] = [];
  for (let bucket = 0; bucket < limit; bucket += 1) {
    const start = Math.floor(bucket * bounds.length / limit);
    const end = Math.floor((bucket + 1) * bounds.length / limit);
    let merged = bounds[start]!;
    for (let index = start + 1; index < end; index += 1) merged = unionBounds(merged, bounds[index]!);
    compacted.push(merged);
  }
  return Object.freeze(compacted);
}

function normalizeEntry(input: ProbeSurfaceCacheEntry): ProbeSurfaceCacheEntry {
  if (!input || typeof input !== "object") throw new TypeError("Surface cache entry is invalid.");
  assertId(input.id);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RangeError("Surface cache revision must be a positive integer.");
  if (input.dynamic !== undefined && typeof input.dynamic !== "boolean") throw new TypeError("Surface cache dynamic flag must be boolean.");
  return Object.freeze({ id: input.id, revision: input.revision, bounds: normalizeBounds(input.bounds),
    ...(input.dynamic === undefined ? {} : { dynamic: input.dynamic }) });
}

function normalizeBounds(input: ProbeAabb): ProbeAabb {
  if (!input || !Array.isArray(input.min) || !Array.isArray(input.max) || input.min.length !== 3 || input.max.length !== 3) {
    throw new TypeError("Surface cache bounds must contain min/max vectors.");
  }
  const min = normalizeVector(input.min, "min"), max = normalizeVector(input.max, "max");
  if (min.some((value, axis) => value > max[axis]!)) throw new RangeError("Surface cache bounds min must not exceed max.");
  return Object.freeze({ min, max });
}

function normalizeVector(input: readonly number[], label: string): ProbeVector3 {
  if (input.some(value => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)) {
    throw new RangeError(`Surface cache ${label} contains an invalid coordinate.`);
  }
  return Object.freeze([...input]) as ProbeVector3;
}

function unionBounds(left: ProbeAabb, right: ProbeAabb): ProbeAabb {
  return Object.freeze({
    min: Object.freeze(left.min.map((value, axis) => Math.min(value, right.min[axis]!))) as ProbeVector3,
    max: Object.freeze(left.max.map((value, axis) => Math.max(value, right.max[axis]!))) as ProbeVector3,
  });
}

function sameEntry(left: ProbeSurfaceCacheEntry, right: ProbeSurfaceCacheEntry): boolean {
  return left.dynamic === right.dynamic && left.bounds.min.every((value, axis) => value === right.bounds.min[axis])
    && left.bounds.max.every((value, axis) => value === right.bounds.max[axis]);
}
function assertId(id: string): void { if (!SURFACE_ID.test(id)) throw new TypeError("Surface cache id is not canonical."); }
function compareId(left: readonly [string, unknown], right: readonly [string, unknown]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
