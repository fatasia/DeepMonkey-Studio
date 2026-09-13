/// <reference types="@webgpu/types" />

export const AMBIENT_OCCLUSION_OUTPUT_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const AMBIENT_OCCLUSION_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const AMBIENT_OCCLUSION_NORMAL_FORMAT = "rgba8unorm" as const satisfies GPUTextureFormat;

export interface AmbientOcclusionSource {
  readonly depth: GPUTexture;
  readonly normal: GPUTexture;
  readonly revision: number;
  /** Removes standard/reversed-Z ambiguity before AO reconstruction. */
  readonly depthEncoding: "linear-view-depth-positive";
  readonly normalSpace: "view";
}

export interface AmbientOcclusionOptions {
  readonly verticalFovRadians: number;
  readonly radius: number;
  readonly thickness: number;
  readonly power: number;
}

export interface AmbientOcclusionResult {
  /** Borrowed until resize, device loss, or dispose. */
  readonly texture: GPUTexture;
  readonly format: typeof AMBIENT_OCCLUSION_OUTPUT_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly depthEncoding: "linear-view-depth-positive";
  readonly sampleCount: 16;
}

export interface AmbientOcclusionCpuInput {
  readonly width: number;
  readonly height: number;
  readonly depth: readonly number[];
  /** Tightly packed view-space xyz. */
  readonly normals: readonly number[];
}

export interface AmbientOcclusionCpuResult {
  readonly width: number;
  readonly height: number;
  readonly raw: Float32Array;
  readonly horizontal: Float32Array;
  readonly output: Float32Array;
}
