/// <reference types="@webgpu/types" />
import type { LodCamera, LodViewport } from "../spatial/lodTypes.js";
import type { SpatialAabb } from "../spatial/types.js";

export const GPU_LOD_MAX_LEVELS = 8;
export const GPU_LOD_MAX_OBJECTS = 524_288;
export const GPU_LOD_OBJECT_STRIDE = 32;
export const GPU_LOD_LEVEL_STRIDE = 20;
export const GPU_LOD_OUTPUT_STRIDE = 48;
export const GPU_LOD_UNIFORM_SIZE = 64;
export const GPU_LOD_WORKGROUP_SIZE = 64;
export const GPU_LOD_UNAVAILABLE = 0xffff_ffff;

export const GPU_LOD_FLAG_VISIBLE = 1;
export const GPU_LOD_FLAG_DRAWABLE = 2;
export const GPU_LOD_FLAG_HISTORY_RESET = 4;
export const GPU_LOD_FLAG_INVALID = 8;

export interface GpuLodLevelSource {
  readonly minProjectedDiameterPixels: number;
  readonly geometricError: number;
  readonly triangles: number;
  readonly meshletOffset: number;
  readonly meshletCount: number;
  readonly resident?: boolean;
}

export interface GpuLodObjectSource {
  /** Supply bounds for imported assets or an exact world-space sphere for packet runtime data. */
  readonly bounds?: SpatialAabb;
  readonly sphere?: readonly [number, number, number, number];
  /** Ordered from finest to coarsest; the final threshold must be zero. */
  readonly levels: readonly GpuLodLevelSource[];
  readonly instanceIndex: number;
  readonly hysteresisRatio?: number;
}

export interface PackedGpuLodScene {
  readonly objectData: ArrayBuffer;
  readonly levelData: ArrayBuffer;
  readonly count: number;
  readonly objectStride: typeof GPU_LOD_OBJECT_STRIDE;
  readonly levelStride: typeof GPU_LOD_LEVEL_STRIDE;
  readonly levelSlots: typeof GPU_LOD_MAX_LEVELS;
}

export interface GpuLodInput {
  readonly objects: GPUBuffer;
  readonly levels: GPUBuffer;
  readonly count: number;
  readonly revision: number;
}

export interface GpuLodView {
  readonly camera: LodCamera;
  readonly viewport: LodViewport;
  /** Explicit cut marker supplied by the camera controller. */
  readonly cameraJump?: boolean;
}

export interface GpuLodSelectorOptions {
  /** Max absolute camera-signature change that resets history. Set Infinity to use explicit cuts only. */
  readonly cameraJumpThreshold?: number;
}

export interface GpuLodResult {
  readonly inputCount: number;
  readonly capacity: number;
  readonly records: GPUBuffer;
  readonly recordStride: typeof GPU_LOD_OUTPUT_STRIDE;
  readonly historyReset: boolean;
  /** True when compute work was encoded and must be committed after queue.submit. */
  readonly updated: boolean;
  /** Per-object records are the deterministic input to a later stable-prefix object/triangle budget pass. */
  readonly budgetMode: "deferred-stable-prefix";
}

export interface GpuLodReferenceRecord {
  readonly objectIndex: number;
  readonly baseLevel: number;
  readonly desiredLevel: number;
  readonly selectedLevel: number | null;
  readonly instanceIndex: number;
  readonly flags: number;
  readonly projectedDiameterPixels: number;
  readonly projectedErrorPixels: number;
  readonly pixelsPerWorldUnit: number;
  readonly depth: number;
  readonly triangles: number;
  readonly meshletOffset: number;
  readonly meshletCount: number;
}

export interface GpuLodReferenceResult {
  readonly records: readonly GpuLodReferenceRecord[];
  readonly packedRecords: ArrayBuffer;
  readonly nextPreviousLevels: Uint32Array;
}
