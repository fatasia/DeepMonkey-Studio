/// <reference types="@webgpu/types" />

export const BLOOM_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;

export interface BloomSource {
  readonly color: GPUTexture;
  readonly revision: number;
  readonly colorEncoding: "linear-hdr";
}

export interface BloomOptions {
  /** Linear HDR threshold in [0, 65504]. */
  readonly threshold: number;
  /** Normalized soft transition width in [0, 1]. */
  readonly softKnee: number;
  /** Bloom energy mixed into the original scene in [0, 16]. */
  readonly intensity: number;
  /** Requested pyramid depth. Small inputs safely stop at 1x1. */
  readonly maxLevels: number;
}

export interface BloomLevelSize {
  readonly width: number;
  readonly height: number;
}

export interface BloomResult {
  /** Borrowed until resize, level-count change, device loss, or dispose. */
  readonly texture: GPUTexture;
  readonly format: typeof BLOOM_COLOR_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly colorEncoding: "linear-hdr";
  readonly levels: readonly BloomLevelSize[];
  readonly passCount: number;
}
