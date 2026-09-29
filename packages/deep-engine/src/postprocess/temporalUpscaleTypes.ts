/// <reference types="@webgpu/types" />
export const TEMPORAL_UPSCALE_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const TEMPORAL_UPSCALE_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const TEMPORAL_UPSCALE_MOTION_FORMAT = "rg16float" as const satisfies GPUTextureFormat;

/**
 * F4 时域上采样:低分辨率主帧渲染 + 全分辨率时域重建输出。
 * 输入合同与 TAA 同族(linear HDR / 正向线性视深 / current-to-previous-UV),
 * motion 与 jitter 的 UV/像素语义见 temporalUpscaleCpu 注释。
 */
export interface TemporalUpscaleSource {
  /** 内部(低分辨率)渲染分辨率 HDR 颜色。 */
  readonly color: GPUTexture;
  /** 内部分辨率正向线性视深。 */
  readonly depth: GPUTexture;
  /** 内部分辨率 current-to-previous-UV 运动矢量(渲染主帧逐像素写入,UV 语义与分辨率无关)。 */
  readonly motion: GPUTexture;
  readonly revision: number;
  /** 渲染分辨率像素抖动(与 TemporalAaSource 同源);成对供给,缺省用 revision Halton 序列。 */
  readonly currentJitter?: readonly [number, number];
  readonly previousJitter?: readonly [number, number];
  readonly colorEncoding: "linear-hdr";
  readonly depthEncoding: "linear-view-depth-positive";
  readonly motionEncoding: "current-to-previous-uv";
}

export interface TemporalUpscaleOptions {
  /** 时域反馈权重 [0, 0.99];历史失效帧自动退化为纯 Catmull-Rom 空间核。 */
  readonly feedback: number;
  readonly depthThreshold: number;
  readonly relativeDepthThreshold: number;
}

export interface TemporalUpscaleResult {
  readonly texture: GPUTexture;
  readonly format: typeof TEMPORAL_UPSCALE_COLOR_FORMAT;
  /** 全分辨率(显示画布)输出尺寸。 */
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly historyUsed: boolean;
  readonly historyInvalidation: "first-frame" | "camera-cut" | "resize" | "revision-gap" | null;
}

/** CPU 参考输入:显示尺寸(内部尺寸由 scale 派生),缓冲按显示分辨率排布。 */
export interface TemporalUpscaleCpuInput {
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** 内部渲染分辨率 = 显示分辨率 × scale(floor,与 renderer 尺寸决策同源)。 */
  readonly scale: number;
  /** 内部分辨率颜色(长度 = internalW × internalH × 4)。 */
  readonly color: readonly number[];
  /** 内部分辨率正向线性视深。 */
  readonly depth: readonly number[];
  /** 内部分辨率 current-to-previous-UV 运动矢量(UV 与分辨率无关)。 */
  readonly motion: readonly number[];
  /** 内部分辨率像素抖动(与 TemporalAaSource 同语义,[-0.5, 0.5] 内部像素)。 */
  readonly currentJitter: readonly [number, number];
  readonly previousJitter: readonly [number, number];
  /** 全分辨率历史(缺省或 invalid 首帧退化纯 Catmull-Rom)。 */
  readonly historyValid: boolean;
  readonly previousColor?: readonly number[];
  readonly previousDepth?: readonly number[];
}
