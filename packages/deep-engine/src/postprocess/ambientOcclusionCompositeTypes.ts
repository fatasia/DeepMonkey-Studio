/// <reference types="@webgpu/types" />
import type { AmbientOcclusionResult } from "./ambientOcclusionTypes.js";

export const AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const AMBIENT_OCCLUSION_COMPOSITE_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;

export interface AmbientOcclusionCompositeSource {
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
  /** Optional rgba8unorm view normals; alpha=1 marks unlit pixels that must bypass AO. */
  readonly normal?: GPUTexture;
  readonly ambientOcclusion: AmbientOcclusionResult;
  readonly revision: number;
  readonly colorEncoding: "linear-hdr";
  readonly depthEncoding: "linear-view-depth-positive";
}

export interface AmbientOcclusionCompositeOptions {
  /** Absolute view-space depth distance controlling cross-edge rejection. */
  readonly depthSigma: number;
  /** Visibility exponent. Zero disables AO; one preserves the AO result. */
  readonly strength: number;
}

export interface AmbientOcclusionCompositeResult {
  /** Borrowed until resize, device loss, or dispose. */
  readonly texture: GPUTexture;
  readonly format: typeof AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly colorEncoding: "linear-hdr";
}

export interface AmbientOcclusionCompositeCpuInput {
  readonly width: number;
  readonly height: number;
  /** Tightly packed linear HDR rgba. */
  readonly color: readonly number[];
  /** Positive linear view depth; nonpositive values denote background. */
  readonly depth: readonly number[];
  readonly unlitMask?: readonly number[];
  readonly ambientOcclusionWidth: number;
  readonly ambientOcclusionHeight: number;
  readonly ambientOcclusion: readonly number[];
}
