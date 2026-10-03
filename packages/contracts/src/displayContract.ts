export type DisplayToneMappingOperator = "three-aces-r185" | "deep-aces";
export type DisplayOutputColorSpace = "srgb";
export type DisplayShadowFilter = "pcf" | "pcf-soft";
/**
 * 主阴影实现档(B1 Brief-VSM,2026-10-03):
 * - "virtual":三环 clipmap 虚拟阴影图(16k² 等效虚拟分辨率,页表物化 + 着色端页
 *   表查询,PCSS 软硬化,页缺失回退上一环);
 * - "cascaded":既有级联阴影(CSM)。
 * 合同向后兼容:`shadow.mode` 缺字段(或非法值)一律按 "cascaded" 处理
 * (resolveDisplayShadowMode fail-closed),既有合同/资产/录制零迁移。
 */
export type DisplayShadowMode = "virtual" | "cascaded";
export type DisplayAntialiasLevel = "off" | "smaa-gtao";

export interface DisplayContract {
  readonly toneMapping: {
    readonly operator: DisplayToneMappingOperator;
    readonly exposure: number;
    readonly dynamicExposure: {
      readonly enabled: boolean;
      readonly min: number;
      readonly max: number;
      readonly base: number;
      readonly intensityScale: number;
    };
  };
  readonly outputColorSpace: DisplayOutputColorSpace;
  readonly environment: {
    readonly environmentIntensity: number;
    readonly globalIlluminationIntensity: number;
  };
  readonly shadow: {
    readonly filter: DisplayShadowFilter;
    readonly mapSize: number;
    readonly bias: number;
    readonly normalBias: number;
    readonly radius: number;
    readonly blurSamples: number;
    /** 主阴影实现档;缺字段 = "cascaded"(向后兼容,见 DisplayShadowMode)。 */
    readonly mode?: DisplayShadowMode;
  };
  readonly antialias: {
    readonly level: DisplayAntialiasLevel;
    readonly smaa: boolean;
    readonly fxaa: boolean;
    readonly gtao: boolean;
    readonly gtaoIntensity: number;
    /**
     * AA-M1(2026-10-03)主 pass 硬件 MSAA 采样数档;缺字段 = 引擎默认(4 = 默认开)。
     * 设备不支持时引擎侧 fail-closed 回 1x 并在帧遥测披露;合同本身不感知设备能力。
     */
    readonly msaaSampleCount?: 1 | 4;
  };
  readonly bloom: {
    readonly enabled: boolean;
    readonly strength: number;
    readonly radius: number;
    readonly threshold: number;
  };
}

export const DEFAULT_DISPLAY_CONTRACT: DisplayContract = Object.freeze({
  toneMapping: Object.freeze({
    operator: "three-aces-r185",
    exposure: 1.05,
    dynamicExposure: Object.freeze({
      enabled: true,
      min: 0.55,
      max: 1.55,
      base: 0.72,
      intensityScale: 0.33,
    }),
  }),
  outputColorSpace: "srgb",
  environment: Object.freeze({
    environmentIntensity: 1,
    globalIlluminationIntensity: 0.32,
  }),
  shadow: Object.freeze({
    filter: "pcf",
    mapSize: 2_048,
    bias: -0.0001,
    normalBias: 0.015,
    radius: 3,
    blurSamples: 8,
  }),
  antialias: Object.freeze({
    level: "smaa-gtao",
    smaa: true,
    fxaa: false,
    gtao: true,
    gtaoIntensity: 0.72,
  }),
  bloom: Object.freeze({
    enabled: false,
    strength: 0.35,
    radius: 0.25,
    threshold: 0.9,
  }),
});

/**
 * 主 pass MSAA 档解析(fail-closed):缺字段 = 4(引擎默认,向后兼容旧合同/资产);
 * 非法值一律回 4,不静默透传任意数字。单源判定点 —— 宿主经它取值后喂
 * PbrRendererOptions.msaaSampleCount。
 */
export function resolveDisplayMsaaSampleCount(
  antialias: DisplayContract["antialias"] | undefined): 1 | 4 {
  return antialias?.msaaSampleCount === 1 ? 1 : 4;
}

/**
 * 阴影档解析(fail-closed):缺字段/非法值/非 "virtual" 一律 "cascaded"。
 * 单源判定点——宿主不得各自展开 `mode === "virtual"` 字面量比较。
 */
export function resolveDisplayShadowMode(
  shadow: DisplayContract["shadow"] | undefined): DisplayShadowMode {
  return shadow?.mode === "virtual" ? "virtual" : "cascaded";
}
