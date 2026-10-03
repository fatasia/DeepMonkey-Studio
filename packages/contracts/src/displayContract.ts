export type DisplayToneMappingOperator = "three-aces-r185" | "deep-aces";
export type DisplayOutputColorSpace = "srgb";
export type DisplayShadowFilter = "pcf" | "pcf-soft";
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
  };
  readonly antialias: {
    readonly level: DisplayAntialiasLevel;
    readonly smaa: boolean;
    readonly fxaa: boolean;
    readonly gtao: boolean;
    readonly gtaoIntensity: number;
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
