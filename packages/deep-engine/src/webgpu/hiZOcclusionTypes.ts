/// <reference types="@webgpu/types" />
import type { HiZResult } from "./hiZPyramid.js";

export const HI_Z_OCCLUSION_WORKGROUP_SIZE = 64;
export const HI_Z_OCCLUSION_MIN_INSTANCES = 128;
export const HI_Z_OCCLUSION_MAX_INSTANCES = 1_048_576;
export const HI_Z_OCCLUSION_UNIFORM_SIZE = 128;

export interface HiZOcclusionInput {
  /** Deep 144-byte instance rows, aligned one-to-one with bounds. */
  readonly instances: GPUBuffer;
  /** Object-space sphere bounds as vec4(center, radius), aligned with instances. */
  readonly bounds: GPUBuffer;
  readonly count: number;
  /** Monotonic author-data revision. Used for exact no-op detection. */
  readonly revision: number;
  readonly indexCount: number;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstInstance?: number;
}

export interface HiZOcclusionView {
  /** Column-major world-to-WebGPU-clip matrix, depth range 0..1. */
  readonly viewProjection: Float32Array | readonly number[];
  readonly cameraPosition: readonly [number, number, number];
  readonly viewport: readonly [number, number];
  readonly hiz: HiZResult;
  readonly reversedZ: boolean;
}

export interface HiZOcclusionOptions {
  readonly temporal?: boolean;
  readonly cameraCut?: boolean;
  /** Maximum absolute matrix-element delta before temporal history is reset. */
  readonly cameraJumpThreshold?: number;
  readonly depthBias?: number;
  readonly nearClipEpsilon?: number;
}

export interface HiZOcclusionDirectResult {
  readonly mode: "direct";
  readonly inputCount: number;
  readonly updated: false;
}

export interface HiZOcclusionIndirectResult {
  readonly mode: "indirect";
  readonly inputCount: number;
  readonly capacity: number;
  readonly visibleIndices: GPUBuffer;
  readonly visibleCount: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly historyReset: boolean;
  readonly updated: boolean;
}

export type HiZOcclusionResult = HiZOcclusionDirectResult | HiZOcclusionIndirectResult;

export interface HiZOcclusionResources {
  readonly capacity: number;
  readonly visibleIndices: GPUBuffer;
  readonly visibleCount: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly history: GPUBuffer;
  readonly uniform: GPUBuffer;
  readonly hizTexture: GPUTexture;
  readonly hizMipLevelCount: number;
  readonly hizView: GPUTextureView;
  readonly inputInstances: GPUBuffer;
  readonly inputBounds: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
}

export interface HiZOcclusionLastFrame {
  readonly inputRevision: number;
  readonly inputCount: number;
  readonly instances: GPUBuffer;
  readonly bounds: GPUBuffer;
  readonly hizTexture: GPUTexture;
  readonly hizRevision: number;
  readonly hizMipLevelCount: number;
  readonly viewProjection: readonly number[];
  readonly cameraPosition: readonly number[];
  readonly viewport: readonly number[];
  readonly reversedZ: boolean;
  readonly temporal: boolean;
  readonly depthBias: number;
  readonly nearClipEpsilon: number;
  readonly indexArgs: readonly number[];
  readonly result: HiZOcclusionIndirectResult;
}
