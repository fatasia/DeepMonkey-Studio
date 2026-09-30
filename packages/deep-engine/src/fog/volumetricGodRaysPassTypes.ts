/// <reference types="@webgpu/types" />
import type { VolumetricFogPassOptions } from "./volumetricFogPassTypes.js";
/** Borrowed from the actual CSM owner; the pass never releases any shadow resource. */
export interface GodRaysShadowSource {
  readonly uniform: GPUBuffer;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly enabled: boolean;
}
export interface VolumetricGodRaysPassOptions extends VolumetricFogPassOptions {
  readonly strength: number;
  /** Column-major inverse of the exact view matrix used to render linear depth. */
  readonly viewToWorld: ArrayLike<number>;
}
