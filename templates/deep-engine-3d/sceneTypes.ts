/**
 * H-C7-P2 模板套件共享场景合同（无 DOM/WebGPU 运行时依赖，Node 与浏览器两侧共用）。
 */
import type { InstanceUpdate, RenderPacket } from "@bim-studio/deep-engine";
import type { PbrRendererFeatureOptions } from "@bim-studio/deep-engine/webgpu";

export interface TemplateSceneSpec {
  readonly packet: RenderPacket;
  /** 相机眼点随时间推进（环绕/巡检路径），Node 与浏览器两侧共用同一函数。 */
  eye(elapsedMs: number): readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly extent: number;
  /** 线性空间背景/地面渐变双色；禁止纯黑裸背景。 */
  readonly background: readonly [number, number, number];
  readonly floor: readonly [number, number, number];
  readonly exposure?: number;
  readonly roughness?: number;
  /** 每帧实例/材质动画（InstanceUpdate）；缺省为静态场景。 */
  update?(elapsedMs: number): InstanceUpdate;
}

/** 工业深色氛围基线：雾 + 地面网格 + 辉光 + 暗角 + ACES；其余特性按已验门保守关闭。 */
export const TEMPLATE_FEATURES: PbrRendererFeatureOptions = {
  environment: false, fog: true, groundPlane: false, groundGrid: true, ambientOcclusion: false,
  screenSpaceReflection: false, volumetricFog: false, temporalAa: false, spatialAa: false,
  visibilityBuffer: false, softRasterizeFallback: false, textureArrays: false, layeredMaterials: false,
  occlusionCulling: false, contactShadows: false, temporalUpscale: false,
  bloom: true, vignette: true, toneMapping: "three-aces-r185",
};
