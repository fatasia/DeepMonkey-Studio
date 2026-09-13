import { type LooseOctreeConfiguration, type SpatialAabb, SpatialIndexError, type SpatialItemId, type SpatialQueryResult, type SpatialVec3 } from "./types.js";

export const DEEP_SPATIAL_INDEX_LIMITS = Object.freeze({
  maxDepth: 16,
  maxEntries: 2_000_000,
  maxNodes: 1_000_000,
  minLooseness: 1,
  maxLooseness: 2,
} as const);

export const DEFAULT_SPATIAL_MASK = 0xffff_ffff;

export interface OctreeNode<TId extends SpatialItemId> {
  readonly center: SpatialVec3;
  readonly halfExtents: SpatialVec3;
  readonly looseBounds: SpatialAabb;
  readonly depth: number;
  readonly parent: OctreeNode<TId> | null;
  readonly parentSlot: number;
  readonly entries: SpatialRecord<TId>[];
  readonly children: Array<OctreeNode<TId> | undefined>;
}

export interface SpatialRecord<TId extends SpatialItemId> {
  readonly id: TId;
  readonly ordinal: number;
  bounds: SpatialAabb;
  mask: number;
  node: OctreeNode<TId> | null;
  overflow: boolean;
  budgetLimited: boolean;
}

export function resolveOctreeOptions(options: {
  readonly maxDepth?: number;
  readonly looseness?: number;
  readonly maxEntries?: number;
  readonly maxNodes?: number;
}): Readonly<LooseOctreeConfiguration> {
  if (!options || typeof options !== "object") throw new SpatialIndexError("invalid-options", "Loose octree options are required.");
  const maxDepth = boundedInteger(options.maxDepth ?? 8, 0, DEEP_SPATIAL_INDEX_LIMITS.maxDepth, "maxDepth");
  const maxEntries = boundedInteger(options.maxEntries ?? 1_000_000, 1, DEEP_SPATIAL_INDEX_LIMITS.maxEntries, "maxEntries");
  const maxNodes = boundedInteger(options.maxNodes ?? 262_144, 1, DEEP_SPATIAL_INDEX_LIMITS.maxNodes, "maxNodes");
  const looseness = options.looseness ?? 1.5;
  if (!Number.isFinite(looseness) || looseness < DEEP_SPATIAL_INDEX_LIMITS.minLooseness || looseness > DEEP_SPATIAL_INDEX_LIMITS.maxLooseness) {
    throw new SpatialIndexError("invalid-options", "looseness must be between 1 and 2.");
  }
  return Object.freeze({ maxDepth, maxEntries, maxNodes, looseness });
}

export function createOctreeNode<TId extends SpatialItemId>(
  parent: OctreeNode<TId> | null,
  parentSlot: number,
  depth: number,
  center: SpatialVec3,
  halfExtents: SpatialVec3,
  looseness: number,
): OctreeNode<TId> {
  const looseHalf = vectorScale(halfExtents, looseness);
  return {
    center,
    halfExtents,
    depth,
    parent,
    parentSlot,
    entries: [],
    children: new Array(8),
    looseBounds: boundsFromCenter(center, looseHalf),
  };
}

export function octreeChildSpec<TId extends SpatialItemId>(
  node: OctreeNode<TId>,
  slot: number,
  looseness: number,
): { center: SpatialVec3; halfExtents: SpatialVec3; looseBounds: SpatialAabb } {
  const halfExtents = vectorScale(node.halfExtents, 0.5);
  const center = halfExtents.map((value, axis) =>
    node.center[axis]! + ((slot & (1 << axis)) === 0 ? -value : value)) as unknown as SpatialVec3;
  return { center, halfExtents, looseBounds: boundsFromCenter(center, vectorScale(halfExtents, looseness)) };
}

export function octreeChildSlot(center: SpatialVec3, parentCenter: SpatialVec3): number {
  return (center[0] >= parentCenter[0] ? 1 : 0)
    | (center[1] >= parentCenter[1] ? 2 : 0)
    | (center[2] >= parentCenter[2] ? 4 : 0);
}

export function validateSpatialId(id: SpatialItemId): void {
  if ((typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isSafeInteger(id))) return;
  throw new SpatialIndexError("invalid-id", "Spatial entry id must be a non-empty string or safe integer.");
}

export function validateSpatialMask(mask: number): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > DEFAULT_SPATIAL_MASK) {
    throw new SpatialIndexError("invalid-mask", "Spatial mask must be an unsigned 32-bit integer.");
  }
  return mask >>> 0;
}

export function validateSpatialLimit(limit: number, maximum: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new SpatialIndexError("invalid-query", `Spatial query limit must be between 0 and ${maximum}.`);
  }
  return limit;
}

export function makeSpatialQueryResult<TId extends SpatialItemId>(
  matches: readonly SpatialRecord<TId>[],
  visitedNodes: number,
  testedEntries: number,
  matchedEntries: number,
  limit: number,
): SpatialQueryResult<TId> {
  return Object.freeze({
    ids: Object.freeze(matches.slice(0, limit).map((entry) => entry.id)),
    visitedNodes,
    testedEntries,
    matchedEntries,
    truncated: matchedEntries > limit,
  });
}

function vectorScale(value: SpatialVec3, scale: number): SpatialVec3 {
  return value.map((component) => component * scale) as unknown as SpatialVec3;
}

function boundsFromCenter(center: SpatialVec3, half: SpatialVec3): SpatialAabb {
  return {
    min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
  };
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SpatialIndexError("invalid-options", `${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
