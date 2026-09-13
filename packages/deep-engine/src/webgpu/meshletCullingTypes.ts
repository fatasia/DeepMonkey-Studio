/// <reference types="@webgpu/types" />
import type { MeshletBuildResult } from "../geometry/types.js";
import type { Frustum } from "./gpuFrustumCulling.js";
import type { HiZResult } from "./hiZPyramid.js";

export const MESHLET_CULL_MIN_COUNT = 64;
export const MESHLET_CULL_MAX_COUNT = 1_048_576;
export const MESHLET_PLANNER_RECORD_STRIDE = 32;
export const MESHLET_CULL_UNIFORM_SIZE = 304;

export interface MeshletCullingInput {
  /** GPU copy of MeshletBuildResult.descriptors; ownership stays with the caller. */
  readonly descriptors: GPUBuffer;
  /** GPU copy of MeshletBuildResult.bounds; ownership stays with the caller. */
  readonly bounds: GPUBuffer;
  readonly count: number;
  readonly revision: number;
}

export interface MeshletCullingView {
  readonly viewProjection: Float32Array | readonly number[];
  /** Column-major affine transform. Identity is used when omitted. */
  readonly worldFromObject?: Float32Array | readonly number[];
  readonly cameraPosition: readonly [number, number, number];
  readonly frustum: Frustum;
  readonly viewport: readonly [number, number];
  readonly reversedZ: boolean;
  /** Optional conservative depth pyramid. */
  readonly hiz?: HiZResult;
}

export interface MeshletCullingOptions {
  /** Disable for double-sided geometry. Defaults to true. */
  readonly normalCone?: boolean;
  readonly depthBias?: number;
  readonly nearClipEpsilon?: number;
  readonly coneEpsilon?: number;
}

export interface MeshletCullingDirectResult {
  readonly mode: "direct";
  readonly inputCount: number;
  readonly updated: false;
}

export interface MeshletCullingGpuResult {
  readonly mode: "gpu";
  readonly inputCount: number;
  readonly capacity: number;
  readonly visibleIndices: GPUBuffer;
  readonly visibleCount: GPUBuffer;
  /** Stable source-order records; see meshletPlannerRecord for the eight-u32 layout. */
  readonly visibleRecords: GPUBuffer;
  readonly recordStride: typeof MESHLET_PLANNER_RECORD_STRIDE;
  readonly hizTested: boolean;
  readonly normalConeTested: boolean;
  readonly updated: boolean;
}

export type MeshletCullingResult = MeshletCullingDirectResult | MeshletCullingGpuResult;

/** Accepts one descriptor record or a descriptor-array slice. */
export function meshletPlannerRecord(meshletIndex: number, descriptor: ArrayLike<number>): Uint32Array<ArrayBuffer> {
  if (!Number.isInteger(meshletIndex) || meshletIndex < 0 || meshletIndex > 0xffff_ffff || descriptor.length !== 4) {
    throw new Error("Invalid meshlet planner record input.");
  }
  const values = Array.from(descriptor);
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)) {
    throw new Error("Meshlet descriptor values must be uint32.");
  }
  const [vertexOffset, vertexCount, triangleOffset, triangleCount] = values as [number, number, number, number];
  if (triangleCount > Math.floor(0xffff_ffff / 3) || triangleOffset > Math.floor(0xffff_ffff / 3)) {
    throw new Error("Meshlet planner draw fields overflow uint32.");
  }
  return new Uint32Array([meshletIndex, vertexOffset, vertexCount, triangleOffset,
    triangleCount, triangleCount * 3, triangleOffset * 3, 0]);
}

/** Convenience upload sizes for one validated CPU meshlet build. */
export function meshletGpuInputByteLengths(value: MeshletBuildResult): Readonly<{ descriptors: number; bounds: number }> {
  return Object.freeze({ descriptors: value.descriptors.byteLength, bounds: value.bounds.byteLength });
}
