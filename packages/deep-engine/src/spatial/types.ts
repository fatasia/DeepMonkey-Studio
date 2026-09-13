export type SpatialItemId = string | number;
export type SpatialVec3 = readonly [number, number, number];
export type SpatialPlane = readonly [number, number, number, number];

export interface SpatialAabb {
  readonly min: SpatialVec3;
  readonly max: SpatialVec3;
}

export interface SpatialFrustum {
  readonly planes: readonly SpatialPlane[];
}

export interface LooseOctreeOptions {
  readonly bounds: SpatialAabb;
  readonly maxDepth?: number;
  readonly looseness?: number;
  readonly maxEntries?: number;
  readonly maxNodes?: number;
}

export interface LooseOctreeConfiguration {
  readonly maxDepth: number;
  readonly looseness: number;
  readonly maxEntries: number;
  readonly maxNodes: number;
}

export interface SpatialEntryOptions {
  readonly mask?: number;
}

export interface SpatialQueryOptions {
  readonly mask?: number;
  readonly limit?: number;
}

export interface SpatialQueryResult<TId extends SpatialItemId> {
  readonly ids: readonly TId[];
  readonly visitedNodes: number;
  readonly testedEntries: number;
  readonly matchedEntries: number;
  readonly truncated: boolean;
}

export interface LooseOctreeStats {
  readonly entries: number;
  readonly nodes: number;
  readonly overflowEntries: number;
  readonly budgetLimitedEntries: number;
  readonly revision: number;
}

export type SpatialIndexErrorCode =
  | "capacity-exceeded"
  | "duplicate-id"
  | "duplicate-instance"
  | "invalid-bounds"
  | "invalid-frustum"
  | "invalid-id"
  | "invalid-mask"
  | "invalid-options"
  | "invalid-query"
  | "invalid-transform"
  | "invalid-handle"
  | "missing-metadata"
  | "missing-id";

export class SpatialIndexError extends Error {
  readonly code: SpatialIndexErrorCode;

  constructor(code: SpatialIndexErrorCode, message: string) {
    super(message);
    this.name = "SpatialIndexError";
    this.code = code;
  }
}
