import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { validateAuthorBloomOptions, type AuthorBloomOptions as PbrAuthorBloomOptions } from "../postprocess/authorBloomCpu.js";
import type { VolumetricFogLight } from "../fog/volumetricFogPassTypes.js";
import type { VolumetricMedium } from "../fog/volumetricFog.js";
import { validateVolumetricFogLight, validateVolumetricMedium } from "../fog/volumetricFogPassCpu.js";
export type { AuthorBloomOptions as PbrAuthorBloomOptions } from "../postprocess/authorBloomCpu.js";

export interface PbrVolumetricFogProfile {
  readonly medium: VolumetricMedium;
  readonly light: VolumetricFogLight;
  readonly steps?: number;
  /** Absolute view distance in scene units; omitted derives a bounded distance from scene extent. */
  readonly maxDistance?: number;
}

export interface PbrScreenSpaceReflectionProfile {
  readonly steps: number;
  readonly thicknessScale: number;
  readonly maxDistanceScale: number;
}

export const DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE: Readonly<PbrVolumetricFogProfile> = Object.freeze({
  medium: Object.freeze({ baseExtinction: 0.006, scaleHeight: 64, anisotropy: 0.3, albedo: 0.82 }),
  light: Object.freeze({ direction: Object.freeze([0.45, -0.8, -0.4] as const),
    radiance: Object.freeze([3.2, 3.1, 2.9] as const) }),
  steps: 48,
});

/** Per-frame switches; omitted fields retain the allocated renderer defaults. */
export interface PbrPostProcessOverrides {
  readonly ambientOcclusion?: boolean;
  readonly screenSpaceReflection?: boolean;
  readonly screenSpaceReflectionProfile?: PbrScreenSpaceReflectionProfile;
  readonly volumetricFog?: boolean;
  readonly volumetricFogProfile?: PbrVolumetricFogProfile;
  readonly bloom?: boolean;
  readonly authorBloom?: PbrAuthorBloomOptions;
}

export function validatePbrPostProcessOverrides(value: PbrPostProcessOverrides | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PBR postProcess must be an options object.");
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (key === "authorBloom") { validateAuthorBloomOptions(candidate as PbrAuthorBloomOptions); continue; }
    if (key === "volumetricFogProfile") { validateVolumetricFogProfile(candidate as PbrVolumetricFogProfile); continue; }
    if (key === "screenSpaceReflectionProfile") { validateScreenSpaceReflectionProfile(candidate as PbrScreenSpaceReflectionProfile); continue; }
    if (key !== "ambientOcclusion" && key !== "screenSpaceReflection" && key !== "volumetricFog" && key !== "bloom") {
      throw new TypeError(`Unknown PBR postProcess option: ${key}.`);
    }
    if (typeof candidate !== "boolean") throw new TypeError(`PBR postProcess ${key} must be boolean.`);
  }
}

export function resolvePbrPostProcessOverrides(value: PbrPostProcessOverrides | undefined,
  features: Pick<PbrRendererFeatures, "ambientOcclusion" | "screenSpaceReflection" | "bloom">
    & Partial<Pick<PbrRendererFeatures, "volumetricFog">>): Readonly<{
    ambientOcclusion: boolean; screenSpaceReflection: boolean; volumetricFog: boolean; bloom: boolean;
    volumetricFogProfile: Readonly<PbrVolumetricFogProfile>; screenSpaceReflectionProfile?: Readonly<PbrScreenSpaceReflectionProfile>;
    authorBloom?: PbrAuthorBloomOptions }> {
  validatePbrPostProcessOverrides(value);
  for (const key of ["ambientOcclusion", "screenSpaceReflection", "volumetricFog", "bloom"] as const) {
    if (value?.[key] === true && !features[key]) throw new Error(`PBR postProcess ${key} was not allocated by renderer features.`);
  }
  const bloom = value?.bloom ?? features.bloom;
  if (value?.authorBloom && !bloom) throw new Error("Author bloom profile requires enabled, allocated bloom.");
  if (value?.screenSpaceReflectionProfile && !(value.screenSpaceReflection ?? features.screenSpaceReflection)) {
    throw new Error("Screen-space reflection profile requires enabled, allocated SSR.");
  }
  const volumetricFog = value?.volumetricFog ?? features.volumetricFog ?? false;
  if (value?.volumetricFogProfile && !volumetricFog) throw new Error("Volumetric fog profile requires enabled, allocated volumetric fog.");
  return { ambientOcclusion: value?.ambientOcclusion ?? features.ambientOcclusion,
    screenSpaceReflection: value?.screenSpaceReflection ?? features.screenSpaceReflection, volumetricFog, bloom,
    volumetricFogProfile: value?.volumetricFogProfile
      ? snapshotVolumetricFogProfile(value.volumetricFogProfile) : DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE,
    ...(value?.screenSpaceReflectionProfile ? { screenSpaceReflectionProfile: Object.freeze({ ...value.screenSpaceReflectionProfile }) } : {}),
    ...(value?.authorBloom ? { authorBloom: Object.freeze({ strength: value.authorBloom.strength,
      threshold: value.authorBloom.threshold }) } : {}) };
}

function validateScreenSpaceReflectionProfile(value: PbrScreenSpaceReflectionProfile): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["steps", "thicknessScale", "maxDistanceScale"].includes(key))) {
    throw new TypeError("Invalid screen-space reflection profile.");
  }
  if (!Number.isInteger(value.steps) || value.steps < 8 || value.steps > 128) throw new RangeError("SSR steps must be an integer in [8,128].");
  if (!Number.isFinite(value.thicknessScale) || value.thicknessScale < 0.001 || value.thicknessScale > 0.1) throw new RangeError("SSR thicknessScale must be in [0.001,0.1].");
  if (!Number.isFinite(value.maxDistanceScale) || value.maxDistanceScale < 0.25 || value.maxDistanceScale > 4) throw new RangeError("SSR maxDistanceScale must be in [0.25,4].");
}

function validateVolumetricFogProfile(value: PbrVolumetricFogProfile): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Volumetric fog profile must be an object.");
  const keys = Object.keys(value);
  if (keys.some(key => !["medium", "light", "steps", "maxDistance"].includes(key))) throw new TypeError("Unknown volumetric fog profile option.");
  validateVolumetricMedium(value.medium); validateVolumetricFogLight(value.light);
  if (value.steps !== undefined && (!Number.isInteger(value.steps) || value.steps < 32 || value.steps > 64)) {
    throw new RangeError("Volumetric fog profile steps must be an integer in [32, 64].");
  }
  if (value.maxDistance !== undefined && (!Number.isFinite(value.maxDistance) || value.maxDistance <= 0)) {
    throw new RangeError("Volumetric fog profile maxDistance must be finite and positive.");
  }
}

function snapshotVolumetricFogProfile(value: PbrVolumetricFogProfile): Readonly<PbrVolumetricFogProfile> {
  validateVolumetricFogProfile(value);
  return Object.freeze({ medium: Object.freeze({ ...value.medium }), light: Object.freeze({
    direction: Object.freeze([...value.light.direction]) as unknown as VolumetricFogLight["direction"],
    radiance: Object.freeze([...value.light.radiance]) as unknown as VolumetricFogLight["radiance"],
  }), ...(value.steps === undefined ? {} : { steps: value.steps }),
  ...(value.maxDistance === undefined ? {} : { maxDistance: value.maxDistance }) });
}
