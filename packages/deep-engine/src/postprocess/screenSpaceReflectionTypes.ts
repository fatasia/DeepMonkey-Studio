/// <reference types="@webgpu/types" />

export const SSR_TRACE_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const SSR_COMPOSITE_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const SSR_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const SSR_NORMAL_FORMAT = "rgba8unorm" as const satisfies GPUTextureFormat;
export const SSR_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;

export interface ScreenSpaceReflectionSource {
  /** Full-resolution composite-domain HDR color the trace samples from. */
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
  readonly normal: GPUTexture;
  /**
   * C11 物理化:与主着色器同一 split-sum DFG LUT(environment.brdf,rgba16float 128²)。
   * 替换分数取 specularFraction(nv, rough) 而非镜面 Schlick,与被替换的 IBL 高光回退同权。
   */
  readonly brdfLut: GPUTextureView;
  readonly revision: number;
  /** Removes standard/reversed-Z ambiguity before ray marching. */
  readonly depthEncoding: "linear-view-depth-positive";
  readonly normalSpace: "view";
  readonly colorEncoding: "linear-hdr";
}

export interface ScreenSpaceReflectionOptions {
  readonly verticalFovRadians: number;
  /** View-space march length in world units before the ray gives up. */
  readonly maxDistance: number;
  /** View-space depth band treated as a real hit instead of a thin occluder pass-through. */
  readonly thickness: number;
  readonly steps: number;
  readonly refines: number;
  /** UV distance (0..1, from the edge) below which the contribution fades out. */
  readonly edgeFade: number;
  readonly fresnelF0: number;
  /** Active prefiltered cone levels; physical storage remains bounded to six. */
  readonly coneMipLevels?: number;
  /**
   * F1 逐 pass GPU 计时作用域(opt-in 诊断);只用于 marker 括夹,不参与缓存键
   * (sameOptions 不比较)与参数打包。
   */
  readonly passTiming?: import("../webgpu/gpuTimer.js").GpuPassTimingScope;
}

export interface ScreenSpaceReflectionResult {
  /** Borrowed until resize, device loss, or dispose. */
  readonly texture: GPUTexture;
  readonly format: typeof SSR_COMPOSITE_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  /** Actual bounded rough-radiance hierarchy consumed by cone tracing. */
  readonly radianceMipLevelCount: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly passCount: number;
}

export interface ScreenSpaceReflectionCpuInput {
  readonly width: number;
  readonly height: number;
  /** Positive linear view depth, tightly packed, row-major. */
  readonly depth: readonly number[];
  /** Tightly packed view-space xyz. */
  readonly normals: readonly number[];
  /** Optional perceptual roughness mirror of view-normal alpha; omitted preserves the legacy sharp path. */
  readonly roughness?: readonly number[];
  /** Linear HDR rgb, tightly packed. */
  readonly color: readonly number[];
}

export interface ScreenSpaceReflectionCpuOptions {
  readonly verticalFovRadians: number;
  readonly maxDistance: number;
  readonly thickness: number;
  readonly steps: number;
  readonly refines: number;
  readonly edgeFade: number;
  readonly fresnelF0: number;
  readonly coneMipLevels?: number;
}

export interface ScreenSpaceReflectionCpuResult {
  readonly width: number;
  readonly height: number;
  readonly trace: Float32Array;
  readonly output: Float32Array;
}
