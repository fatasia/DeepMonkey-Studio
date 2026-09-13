export type PbrToneMapping = "deep-aces" | "three-aces-r185";

export interface PbrRendererFeatureOptions {
  readonly environment?: boolean;
  readonly fog?: boolean;
  readonly groundGrid?: boolean;
  readonly ambientOcclusion?: boolean;
  readonly temporalAa?: boolean;
  readonly bloom?: boolean;
  readonly vignette?: boolean;
  readonly toneMapping?: PbrToneMapping;
}

export interface PbrRendererFeatures {
  readonly environment: boolean;
  readonly fog: boolean;
  readonly groundGrid: boolean;
  readonly ambientOcclusion: boolean;
  readonly temporalAa: boolean;
  readonly bloom: boolean;
  readonly vignette: boolean;
  readonly toneMapping: PbrToneMapping;
}

export const DEFAULT_PBR_RENDERER_FEATURES: PbrRendererFeatures = Object.freeze({
  environment: true, fog: true, groundGrid: true, ambientOcclusion: true,
  temporalAa: true, bloom: true, vignette: true, toneMapping: "deep-aces",
});

export function resolvePbrRendererFeatures(options: PbrRendererFeatureOptions = {}): PbrRendererFeatures {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("PBR renderer features must be an object.");
  }
  const boolean = (key: keyof Omit<PbrRendererFeatures, "toneMapping">): boolean => {
    const value = options[key];
    if (value !== undefined && typeof value !== "boolean") throw new TypeError(`PBR feature ${key} must be boolean.`);
    return value ?? DEFAULT_PBR_RENDERER_FEATURES[key];
  };
  const toneMapping = options.toneMapping ?? DEFAULT_PBR_RENDERER_FEATURES.toneMapping;
  if (toneMapping !== "deep-aces" && toneMapping !== "three-aces-r185") throw new RangeError("Unknown PBR tone mapping.");
  return Object.freeze({ environment: boolean("environment"), fog: boolean("fog"),
    groundGrid: boolean("groundGrid"), ambientOcclusion: boolean("ambientOcclusion"),
    temporalAa: boolean("temporalAa"), bloom: boolean("bloom"), vignette: boolean("vignette"), toneMapping });
}
