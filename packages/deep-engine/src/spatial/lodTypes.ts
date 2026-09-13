import type { SpatialAabb, SpatialItemId, SpatialVec3 } from "./types.js";

export interface PerspectiveLodCamera {
  readonly projection: "perspective";
  readonly position: SpatialVec3;
  readonly forward: SpatialVec3;
  readonly verticalFovRadians: number;
  readonly near: number;
  readonly far: number;
}

export interface OrthographicLodCamera {
  readonly projection: "orthographic";
  readonly position: SpatialVec3;
  readonly forward: SpatialVec3;
  readonly verticalSize: number;
  readonly near: number;
  readonly far: number;
}

export type LodCamera = PerspectiveLodCamera | OrthographicLodCamera;

export interface LodViewport {
  readonly width: number;
  readonly height: number;
}

/** Levels are ordered from finest to coarsest; the final threshold must be zero. */
export interface ScreenSpaceLodLevel {
  readonly minProjectedDiameterPixels: number;
  readonly geometricError: number;
  readonly triangles: number;
}

export interface ScreenSpaceLodObject<TId extends SpatialItemId = string> {
  readonly id: TId;
  readonly bounds: SpatialAabb;
  readonly levels: readonly ScreenSpaceLodLevel[];
  readonly priority?: number;
  readonly hysteresisRatio?: number;
}

export interface LodFrameBudget {
  readonly maxObjects?: number;
  readonly maxTriangles?: number;
}

export interface ScreenSpaceLodSelectorOptions {
  readonly maxTrackedObjects?: number;
  readonly defaultHysteresisRatio?: number;
}

export interface ScreenSpaceLodSelectorConfiguration {
  readonly maxTrackedObjects: number;
  readonly defaultHysteresisRatio: number;
}

export type LodSelectionReason =
  | "preferred"
  | "depth-range"
  | "object-budget"
  | "triangle-budget";

export interface ScreenSpaceLodSelection<TId extends SpatialItemId> {
  readonly id: TId;
  readonly projectedDiameterPixels: number;
  readonly baseLevel: number;
  readonly preferredLevel: number;
  readonly selectedLevel: number | null;
  readonly projectedErrorPixels: number;
  readonly triangles: number;
  readonly reason: LodSelectionReason;
}

export interface ScreenSpaceLodFrameResult<TId extends SpatialItemId> {
  readonly selections: readonly ScreenSpaceLodSelection<TId>[];
  readonly renderedObjects: number;
  readonly renderedTriangles: number;
  readonly trackedObjects: number;
  readonly revision: number;
}
