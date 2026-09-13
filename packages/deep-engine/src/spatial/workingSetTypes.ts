import type {
  LodCamera,
  LodFrameBudget,
  LodViewport,
  ScreenSpaceLodLevel,
} from "./lodTypes.js";
import type {
  LooseOctreeConfiguration,
  SpatialAabb,
  SpatialFrustum,
  SpatialItemId,
} from "./types.js";

export interface VisibleObjectLodLevel extends ScreenSpaceLodLevel {
  readonly geometryId: string;
}

export interface VisibleObjectRegistration<TId extends SpatialItemId = string> {
  readonly id: TId;
  readonly instanceId: SpatialItemId;
  readonly bounds: SpatialAabb;
  readonly materialId: string;
  readonly levels: readonly VisibleObjectLodLevel[];
  readonly mask?: number;
  readonly priority?: number;
  readonly hysteresisRatio?: number;
}

export interface VisibleObjectPatch {
  readonly instanceId?: SpatialItemId;
  readonly bounds?: SpatialAabb;
  readonly materialId?: string;
  readonly levels?: readonly VisibleObjectLodLevel[];
  readonly mask?: number;
  readonly priority?: number;
  readonly hysteresisRatio?: number;
}

export interface CpuVisibleWorkingSetOptions {
  readonly bounds: SpatialAabb;
  readonly maxEntries?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly looseness?: number;
  readonly defaultHysteresisRatio?: number;
}

export interface CpuVisibleWorkingSetConfiguration extends LooseOctreeConfiguration {
  readonly defaultHysteresisRatio: number;
}

export interface VisibleWorkingSetFrameInput {
  readonly frustum: SpatialFrustum;
  readonly camera: LodCamera;
  readonly viewport: LodViewport;
  readonly mask?: number;
  readonly maxQueryCandidates?: number;
  readonly budget?: LodFrameBudget;
}

export interface VisibleCandidate<TId extends SpatialItemId> {
  readonly objectId: TId;
  readonly instanceId: SpatialItemId;
  readonly bounds: SpatialAabb;
  readonly materialId: string;
  readonly geometryId: string;
  readonly lodLevel: number;
  readonly priority: number;
  readonly triangles: number;
  readonly projectedDiameterPixels: number;
  readonly projectedErrorPixels: number;
}

export interface VisibleCandidateBatch {
  readonly materialId: string;
  readonly geometryId: string;
  readonly lodLevel: number;
  readonly firstCandidate: number;
  readonly candidateCount: number;
  readonly triangles: number;
}

export interface VisibleQueryStats {
  readonly visitedNodes: number;
  readonly testedEntries: number;
  readonly matchedEntries: number;
  readonly submittedToLod: number;
  readonly truncated: boolean;
}

export interface CpuVisibleWorkingSetFrame<TId extends SpatialItemId> {
  readonly revision: number;
  readonly generation: number;
  readonly candidates: readonly VisibleCandidate<TId>[];
  readonly batches: readonly VisibleCandidateBatch[];
  readonly query: VisibleQueryStats;
  readonly renderedTriangles: number;
}

export interface CpuVisibleWorkingSetStats {
  readonly revision: number;
  readonly generation: number;
  readonly registeredObjects: number;
  readonly registeredInstances: number;
  readonly activeSpatialObjects: number;
  readonly trackedLodObjects: number;
  readonly spatialNodes: number;
  readonly spatialOverflowEntries: number;
}
