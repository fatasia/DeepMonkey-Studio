/// <reference types="@webgpu/types" />

/**
 * P2 六引擎对标:SSGI 屏空间漫射一次反弹(three r186 SSGI / UE 糖霜 GI 共同指向的
 * 屏空间漫射补全)。与既有 GI 的分工(裁决,消费点实证):
 * - probe GI(F1 clipmap)/ sdf-gi(sdfGiPublish 探针场)在**主 pass shader 内**替换
 *   ambient 项(pbrShader `mix(environmentIrradiance, gi.rgb, gi.a)`),编码的是
 *   **天空辐射可见性**,不含表面间反弹;
 * - SSGI 是**后链加性层**:对已合成 HDR 重建视空间着色点,余弦半球采样屏空间
 *   一次反弹,补探针不表达的色彩渗透/邻近互射。两者叠加无双计, opting-in 独立。
 * 时域稳定:与 SSR 同策略——本 pass 输出在 TAA 前,TAA 顺带平滑逐帧旋转采样噪声
 * (不另建第二历史缓冲;`seed` 逐帧旋转,确定性可镜像)。
 */

export const SSGI_TRACE_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const SSGI_COMPOSITE_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const SSGI_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const SSGI_NORMAL_FORMAT = "rgba8unorm" as const satisfies GPUTextureFormat;
export const SSGI_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;

export interface ScreenSpaceGiSource {
  /** Full-resolution composite-domain HDR color the bounce rays sample from. */
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
  readonly normal: GPUTexture;
  readonly revision: number;
  /** Removes standard/reversed-Z ambiguity before ray marching. */
  readonly depthEncoding: "linear-view-depth-positive";
  readonly normalSpace: "view";
  readonly colorEncoding: "linear-hdr";
}

export interface ScreenSpaceGiOptions {
  readonly verticalFovRadians: number;
  /** Cosine-hemisphere sample count per pixel (recommend 8-16; half-res trace absorbs cost). */
  readonly samples: number;
  /** View-space march length (world units); also the bounce distance-attenuation radius. */
  readonly maxDistance: number;
  /** View-space depth band treated as a real hit instead of a thin occluder pass-through. */
  readonly thickness: number;
  readonly steps: number;
  readonly refines: number;
  /** UV distance (0..1, from the edge) below which a hit contribution fades out. */
  readonly edgeFade: number;
  /** Linear-domain bounce scale (art-tunable; absorbs the unknown albedo/π factor — documented). */
  readonly intensity: number;
  /** Frame-rotating integer seed (deterministic; TS mirror bit-exact). */
  readonly seed: number;
  /**
   * F1 逐 pass GPU 计时作用域(opt-in 诊断);只用于 marker 括夹,不参与缓存键
   * (sameOptions 不比较)与参数打包。
   */
  readonly passTiming?: import("../webgpu/gpuTimer.js").GpuPassTimingScope;
}

export interface ScreenSpaceGiResult {
  /** Borrowed until resize, device loss, or dispose. */
  readonly texture: GPUTexture;
  readonly format: typeof SSGI_COMPOSITE_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly passCount: number;
}

export interface ScreenSpaceGiCpuInput {
  readonly width: number;
  readonly height: number;
  /** Positive linear view depth, tightly packed, row-major. */
  readonly depth: readonly number[];
  /** Tightly packed view-space xyz (unorm decode is the mirror's job). */
  readonly normals: readonly number[];
  /** Linear HDR rgb, tightly packed. */
  readonly color: readonly number[];
}

export interface ScreenSpaceGiCpuOptions {
  readonly verticalFovRadians: number;
  readonly samples: number;
  readonly maxDistance: number;
  readonly thickness: number;
  readonly steps: number;
  readonly refines: number;
  readonly edgeFade: number;
  readonly intensity: number;
  readonly seed: number;
}

export interface ScreenSpaceGiCpuResult {
  readonly width: number;
  readonly height: number;
  readonly trace: Float32Array;
  readonly output: Float32Array;
}
