/// <reference types="@webgpu/types" />
export const TEMPORAL_AA_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const TEMPORAL_AA_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const TEMPORAL_AA_MOTION_FORMAT = "rg16float" as const satisfies GPUTextureFormat;

export interface TemporalAaSource {
  readonly color: GPUTexture; readonly depth: GPUTexture; readonly motion: GPUTexture;
  readonly revision: number; readonly cameraCut?: boolean;
  /** Pixel-space projection jitter. Both values must be supplied together; omission keeps the revision-based Halton sequence. */
  readonly currentJitter?: readonly [number, number];
  readonly previousJitter?: readonly [number, number];
  readonly colorEncoding: "linear-hdr"; readonly depthEncoding: "linear-view-depth-positive";
  /** UV delta added to current UV to locate the previous sample, excluding jitter. */
  readonly motionEncoding: "current-to-previous-uv";
}
export interface TemporalAaOptions {
  readonly feedback: number;
  readonly depthThreshold: number;
  readonly relativeDepthThreshold: number;
}
export interface TemporalAaResult {
  readonly texture: GPUTexture; readonly format: typeof TEMPORAL_AA_COLOR_FORMAT;
  readonly width: number; readonly height: number; readonly revision: number;
  readonly jitter: readonly [number, number]; readonly previousJitter: readonly [number, number];
  readonly historyUsed: boolean; readonly historyInvalidation: "first-frame" | "camera-cut" | "resize" | "revision-gap" | null;
}
export interface TemporalAaCpuInput {
  readonly width: number; readonly height: number;
  readonly color: readonly number[]; readonly depth: readonly number[]; readonly motion: readonly number[];
  readonly previousColor?: readonly number[]; readonly previousDepth?: readonly number[];
  readonly currentJitter: readonly [number, number]; readonly previousJitter: readonly [number, number];
  readonly historyValid: boolean;
}
