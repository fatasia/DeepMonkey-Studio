/// <reference types="@webgpu/types" />
import type { VolumetricMedium } from "./volumetricFog.js";

// G7 体积雾 GPU ray-march pass(切片一)。半分辨率 compute:沿视图射线步进,
// 采样深度重建世界位置,HG 相位 + Beer-Lambert 积分,输出散射 rgb + 透过率 a。
// 数学基线是 ./volumetricFog.ts 的 CPU 参考(已修复消光 σ₀ 双重计入的量纲缺陷),
// WGSL 与 CPU 镜像逐式对拍,对拍纪律见 volumetricFogPassCpu.ts 与 volumetricFogPassCpu.test.ts。

export const VOLUMETRIC_FOG_SCATTER_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const VOLUMETRIC_FOG_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;

export interface VolumetricFogSource {
  /** 全分辨率线性正深度(与 AO/SSR 同一 linearize 前置契约),0 表示天空。 */
  readonly depth: GPUTexture;
  readonly revision: number;
  /** 在步进前消除 standard/reversed-Z 歧义。 */
  readonly depthEncoding: "linear-view-depth-positive";
}

/** 光照方向约定与 VolumetricLight.direction 完全一致(核内归一化,cosTheta = dot(view, light))。 */
export interface VolumetricFogLight {
  /** 视图空间光方向;核内与 CPU 镜像各自归一化,零向量在校验期拒绝。 */
  readonly direction: readonly [number, number, number];
  /** 线性 HDR 辐射亮度。 */
  readonly radiance: readonly [number, number, number];
}

export interface VolumetricFogPassOptions {
  readonly verticalFovRadians: number;
  /** 视图射线步进数;切片一固定 [32, 64](任务规格),放宽是后续切片。 */
  readonly steps: number;
  /** 天空像素(深度 0)的步进终点(米);几何像素步进到深度重建位置。 */
  readonly maxDistance: number;
  /** 介质参数:与 CPU 参考 volumetricFog.ts 的 VolumetricMedium 同一类型、同一语义。 */
  readonly medium: VolumetricMedium;
  readonly light: VolumetricFogLight;
}

export interface VolumetricFogPassResult {
  /** 半分辨率 rgba16float(rgb=散射入射亮度,a=透过率);借用至 resize、设备丢失或 dispose。 */
  readonly texture: GPUTexture;
  readonly format: typeof VOLUMETRIC_FOG_SCATTER_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly passCount: 1;
}

export interface VolumetricFogCpuInput {
  readonly width: number;
  readonly height: number;
  /** 线性正视图深度,行主序紧排;0 表示天空(步进到 maxDistance)。 */
  readonly depth: readonly number[];
}

export interface VolumetricFogCpuOptions extends VolumetricFogPassOptions {}

export interface VolumetricFogCpuResult {
  /** 半分辨率散射击穿结果,rgba 紧排(rgb=散射,a=透过率)。 */
  readonly width: number;
  readonly height: number;
  readonly scatter: Float32Array;
}
