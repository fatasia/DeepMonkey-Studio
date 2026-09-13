import {
  DEFAULT_SPATIAL_MASK,
  makeSpatialQueryResult,
  validateSpatialLimit,
  validateSpatialMask,
  type OctreeNode,
  type SpatialRecord,
} from "./octreeInternals.js";
import type {
  SpatialAabb,
  SpatialItemId,
  SpatialQueryOptions,
  SpatialQueryResult,
} from "./types.js";

type BoundsIntersection = (bounds: SpatialAabb) => boolean;

/** Traverses the tree and overflow set while preserving insertion-order results. */
export function executeOctreeQuery<TId extends SpatialItemId>(
  root: OctreeNode<TId>,
  overflow: ReadonlySet<SpatialRecord<TId>>,
  entryCount: number,
  maximumLimit: number,
  intersectsNode: BoundsIntersection,
  intersectsEntry: BoundsIntersection,
  options: SpatialQueryOptions,
): SpatialQueryResult<TId> {
  const mask = validateSpatialMask(options.mask ?? DEFAULT_SPATIAL_MASK);
  const limit = validateSpatialLimit(options.limit ?? maximumLimit, maximumLimit);
  if (mask === 0 || entryCount === 0) return makeSpatialQueryResult([], 0, 0, 0, limit);

  const matches: SpatialRecord<TId>[] = [];
  let visitedNodes = 0;
  let testedEntries = 0;
  const pending = intersectsNode(root.looseBounds) ? [root] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    visitedNodes += 1;
    for (const entry of node.entries) {
      if (((entry.mask & mask) >>> 0) === 0) continue;
      testedEntries += 1;
      if (intersectsEntry(entry.bounds)) matches.push(entry);
    }
    for (let slot = 7; slot >= 0; slot -= 1) {
      const child = node.children[slot];
      if (child && intersectsNode(child.looseBounds)) pending.push(child);
    }
  }
  for (const entry of overflow) {
    if (((entry.mask & mask) >>> 0) === 0) continue;
    testedEntries += 1;
    if (intersectsEntry(entry.bounds)) matches.push(entry);
  }
  matches.sort((left, right) => left.ordinal - right.ordinal);
  return makeSpatialQueryResult(matches, visitedNodes, testedEntries, matches.length, limit);
}
