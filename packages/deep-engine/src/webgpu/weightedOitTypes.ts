/// <reference types="@webgpu/types" />

export const WEIGHTED_OIT_ACCUMULATION_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const WEIGHTED_OIT_REVEALAGE_FORMAT = "r16float" as const satisfies GPUTextureFormat;

export interface WeightedOitSize {
  readonly width: number;
  readonly height: number;
}

export interface WeightedOitTargets extends WeightedOitSize {
  /** Borrowed until resize, dispose, or device loss. */
  readonly accumulationTexture: GPUTexture;
  readonly accumulationView: GPUTextureView;
  /** Borrowed until resize, dispose, or device loss. */
  readonly revealageTexture: GPUTexture;
  readonly revealageView: GPUTextureView;
  readonly generation: number;
}

export interface WeightedOitCompositeOptions {
  readonly outputFormat: GPUTextureFormat;
  readonly clearColor?: GPUColor;
  readonly loadOp?: GPULoadOp;
}

export interface WeightedOitCompositeResult extends WeightedOitSize {
  readonly generation: number;
  readonly outputFormat: GPUTextureFormat;
}
