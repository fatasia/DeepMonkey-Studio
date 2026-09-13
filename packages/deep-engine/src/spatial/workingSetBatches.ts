import { SpatialIndexError, type SpatialItemId } from "./types.js";
import type { ScreenSpaceLodSelection } from "./lodTypes.js";
import type {
  VisibleCandidate,
  VisibleCandidateBatch,
} from "./workingSetTypes.js";
import type { ValidatedVisibleObject } from "./workingSetValidation.js";

export interface BuiltWorkingSet<TId extends SpatialItemId> {
  readonly candidates: readonly VisibleCandidate<TId>[];
  readonly batches: readonly VisibleCandidateBatch[];
  readonly triangles: number;
}

export function buildWorkingSetBatches<TId extends SpatialItemId>(
  selections: readonly ScreenSpaceLodSelection<TId>[],
  records: ReadonlyMap<TId, ValidatedVisibleObject<TId>>,
): BuiltWorkingSet<TId> {
  const candidates: VisibleCandidate<TId>[] = [];
  for (const selection of selections) {
    if (selection.selectedLevel === null) continue;
    const record = records.get(selection.id);
    const level = record?.levels[selection.selectedLevel];
    if (!record || !level) {
      throw new SpatialIndexError("missing-metadata", `Selected object ${String(selection.id)} has no valid LOD geometry.`);
    }
    candidates.push(Object.freeze({
      objectId: record.id,
      instanceId: record.instanceId,
      bounds: record.bounds,
      materialId: record.materialId,
      geometryId: level.geometryId,
      lodLevel: selection.selectedLevel,
      priority: record.priority,
      triangles: selection.triangles,
      projectedDiameterPixels: selection.projectedDiameterPixels,
      projectedErrorPixels: selection.projectedErrorPixels,
    }));
  }
  candidates.sort(compareCandidates);

  const batches: VisibleCandidateBatch[] = [];
  let triangles = 0;
  for (let first = 0; first < candidates.length;) {
    const head = candidates[first]!;
    let end = first + 1;
    let batchTriangles = head.triangles;
    while (end < candidates.length && sameBatch(head, candidates[end]!)) {
      batchTriangles += candidates[end]!.triangles;
      end += 1;
    }
    batches.push(Object.freeze({
      materialId: head.materialId,
      geometryId: head.geometryId,
      lodLevel: head.lodLevel,
      firstCandidate: first,
      candidateCount: end - first,
      triangles: batchTriangles,
    }));
    triangles += batchTriangles;
    first = end;
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    batches: Object.freeze(batches),
    triangles,
  });
}

function sameBatch<TId extends SpatialItemId>(left: VisibleCandidate<TId>, right: VisibleCandidate<TId>): boolean {
  return left.materialId === right.materialId && left.geometryId === right.geometryId && left.lodLevel === right.lodLevel;
}

function compareCandidates<TId extends SpatialItemId>(left: VisibleCandidate<TId>, right: VisibleCandidate<TId>): number {
  return compareStrings(left.materialId, right.materialId)
    || compareStrings(left.geometryId, right.geometryId)
    || left.lodLevel - right.lodLevel
    || compareIds(left.objectId, right.objectId);
}

export function compareIds(left: SpatialItemId, right: SpatialItemId): number {
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
