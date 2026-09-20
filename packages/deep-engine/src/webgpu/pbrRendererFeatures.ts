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
  /** G7 half-resolution participating medium march + HDR composite; opt-in to preserve existing visuals. */
  readonly volumetricFog?: boolean;
  readonly temporalAa?: boolean;
  /** Display-domain edge AA, independent of temporal history. */
  readonly spatialAa?: boolean;
  /** P0-2 visibility-buffer slice for static opaque meshlet batches; off keeps the forward path byte-identical. */
  readonly visibilityBuffer?: boolean;
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
  readonly volumetricFog: boolean;
  readonly temporalAa: boolean;
  readonly spatialAa: boolean;
  readonly visibilityBuffer: boolean;
  readonly occlusionCulling: boolean;
  readonly bloom: boolean;
  readonly vignette: boolean;
  readonly toneMapping: PbrToneMapping;
}

export const DEFAULT_PBR_RENDERER_FEATURES: PbrRendererFeatures = Object.freeze({
  environment: true, fog: true, groundPlane: true, groundGrid: true, ambientOcclusion: true,
  screenSpaceReflection: false, volumetricFog: false, temporalAa: true, spatialAa: true, visibilityBuffer: false,
  occlusionCulling: true, bloom: true, vignette: true, toneMapping: "deep-aces",
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
  const volumetricFog = boolean("volumetricFog");
  // Participating-medium composition replaces the legacy surface fog unless the caller explicitly layers both.
  const fog = options.fog === undefined && volumetricFog ? false : boolean("fog");
  return Object.freeze({ environment: boolean("environment"), fog,
    groundPlane: boolean("groundPlane"),
    groundGrid: boolean("groundGrid"), ambientOcclusion: boolean("ambientOcclusion"),
    screenSpaceReflection: boolean("screenSpaceReflection"),
    volumetricFog,
    temporalAa: boolean("temporalAa"), spatialAa: boolean("spatialAa"), visibilityBuffer: boolean("visibilityBuffer"),
    occlusionCulling: boolean("occlusionCulling"),
    bloom: boolean("bloom"), vignette: boolean("vignette"), toneMapping });
}
