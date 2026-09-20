export type PbrToneMapping = "deep-aces" | "three-aces-r185";

export interface PbrRendererFeatureOptions {
  readonly environment?: boolean;
  readonly fog?: boolean;
  /** Built-in solid preview ground; disable when the author scene owns its floor. */
  readonly groundPlane?: boolean;
  readonly groundGrid?: boolean;
  readonly ambientOcclusion?: boolean;
  /** E04 first slice: screen-space reflection trace+composite ahead of temporal AA; off by default. */
  readonly screenSpaceReflection?: boolean;
  readonly temporalAa?: boolean;
  /** Display-domain edge AA, independent of temporal history. */
  readonly spatialAa?: boolean;
  readonly occlusionCulling?: boolean;
  readonly bloom?: boolean;
  readonly vignette?: boolean;
  readonly toneMapping?: PbrToneMapping;
}

export interface PbrRendererFeatures {
  readonly environment: boolean;
  readonly fog: boolean;
  readonly groundPlane: boolean;
  readonly groundGrid: boolean;
  readonly ambientOcclusion: boolean;
  readonly screenSpaceReflection: boolean;
  readonly temporalAa: boolean;
  readonly spatialAa: boolean;
  readonly occlusionCulling: boolean;
  readonly bloom: boolean;
  readonly vignette: boolean;
  readonly toneMapping: PbrToneMapping;
}

export const DEFAULT_PBR_RENDERER_FEATURES: PbrRendererFeatures = Object.freeze({
  environment: true, fog: true, groundPlane: true, groundGrid: true, ambientOcclusion: true,
  screenSpaceReflection: false, temporalAa: true, spatialAa: true, occlusionCulling: true,
  bloom: true, vignette: true, toneMapping: "deep-aces",
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
    groundPlane: boolean("groundPlane"),
    groundGrid: boolean("groundGrid"), ambientOcclusion: boolean("ambientOcclusion"),
    screenSpaceReflection: boolean("screenSpaceReflection"),
    temporalAa: boolean("temporalAa"), spatialAa: boolean("spatialAa"), occlusionCulling: boolean("occlusionCulling"),
    bloom: boolean("bloom"), vignette: boolean("vignette"), toneMapping });
}
