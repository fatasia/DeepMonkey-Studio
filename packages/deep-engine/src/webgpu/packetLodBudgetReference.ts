import { GPU_LOD_MAX_LEVELS } from "./gpuLodTypes.js";

const MAX_U32 = 0xffff_ffff;

export interface PacketLodBudgetCandidate {
  readonly selectedLevel: number | null;
  readonly triangles: number;
  readonly drawable: boolean;
  readonly inFrustum: boolean;
}

export interface PacketLodBudgetReferenceResult {
  readonly accepted: Uint8Array<ArrayBuffer>;
  readonly levelCounts: Uint32Array<ArrayBuffer>;
  readonly compactedIndices: readonly (readonly number[])[];
}

/** CPU oracle for the GPU stable-prefix budget and stable per-level compaction contract. */
export function applyPacketLodBudgetReference(candidates: readonly PacketLodBudgetCandidate[],
  maxObjects: number, maxTriangles: number): PacketLodBudgetReferenceResult {
  budget(maxObjects, "object"); budget(maxTriangles, "triangle");
  const accepted = new Uint8Array(candidates.length), levelCounts = new Uint32Array(GPU_LOD_MAX_LEVELS);
  const compacted = Array.from({ length: GPU_LOD_MAX_LEVELS }, () => [] as number[]);
  let objects = 0, triangles = 0;
  candidates.forEach((candidate, index) => {
    validateCandidate(candidate, index);
    if (!candidate.drawable || !candidate.inFrustum || candidate.selectedLevel === null) return;
    objects += 1; triangles += candidate.triangles;
    if (objects > maxObjects || triangles > maxTriangles) return;
    accepted[index] = 1; levelCounts[candidate.selectedLevel] = levelCounts[candidate.selectedLevel]! + 1;
    compacted[candidate.selectedLevel]!.push(index);
  });
  return Object.freeze({ accepted, levelCounts,
    compactedIndices: Object.freeze(compacted.map(values => Object.freeze(values))) });
}

function validateCandidate(candidate: PacketLodBudgetCandidate, index: number): void {
  if (!candidate || typeof candidate !== "object") throw new TypeError(`Packet LOD candidate ${index} is invalid.`);
  if (candidate.selectedLevel !== null && (!Number.isInteger(candidate.selectedLevel)
    || candidate.selectedLevel < 0 || candidate.selectedLevel >= GPU_LOD_MAX_LEVELS)) {
    throw new RangeError(`Packet LOD candidate ${index} level is invalid.`);
  }
  if (!Number.isInteger(candidate.triangles) || candidate.triangles < 0 || candidate.triangles > MAX_U32) {
    throw new RangeError(`Packet LOD candidate ${index} triangle count is invalid.`);
  }
}

function budget(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) throw new RangeError(`Packet LOD ${label} budget is invalid.`);
}
