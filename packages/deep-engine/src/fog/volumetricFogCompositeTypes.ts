/// <reference types="@webgpu/types" />
import type { VolumetricFogPassResult } from "./volumetricFogPassTypes.js";

export const VOLUMETRIC_FOG_COMPOSITE_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;

export interface VolumetricFogCompositeSource {
  readonly color: GPUTexture;
  readonly scatter: VolumetricFogPassResult;
  readonly revision: number;
  readonly colorEncoding: "linear-hdr";
}

export interface VolumetricFogCompositeResult {
  readonly texture: GPUTexture;
  readonly format: typeof VOLUMETRIC_FOG_COMPOSITE_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly colorEncoding: "linear-hdr";
  readonly passCount: 1;
}
