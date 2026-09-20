import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { validateAuthorBloomOptions, type AuthorBloomOptions as PbrAuthorBloomOptions } from "../postprocess/authorBloomCpu.js";
export type { AuthorBloomOptions as PbrAuthorBloomOptions } from "../postprocess/authorBloomCpu.js";

/** Per-frame switches; omitted fields retain the allocated renderer defaults. */
export interface PbrPostProcessOverrides {
  readonly ambientOcclusion?: boolean;
  readonly screenSpaceReflection?: boolean;
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
    if (key !== "ambientOcclusion" && key !== "screenSpaceReflection" && key !== "bloom") {
      throw new TypeError(`Unknown PBR postProcess option: ${key}.`);
    }
    if (typeof candidate !== "boolean") throw new TypeError(`PBR postProcess ${key} must be boolean.`);
  }
}

export function resolvePbrPostProcessOverrides(value: PbrPostProcessOverrides | undefined,
  features: Pick<PbrRendererFeatures, "ambientOcclusion" | "screenSpaceReflection" | "bloom">): Readonly<{
    ambientOcclusion: boolean; screenSpaceReflection: boolean; bloom: boolean; authorBloom?: PbrAuthorBloomOptions }> {
  validatePbrPostProcessOverrides(value);
  for (const key of ["ambientOcclusion", "screenSpaceReflection", "bloom"] as const) {
    if (value?.[key] === true && !features[key]) throw new Error(`PBR postProcess ${key} was not allocated by renderer features.`);
  }
  const bloom = value?.bloom ?? features.bloom;
  if (value?.authorBloom && !bloom) throw new Error("Author bloom profile requires enabled, allocated bloom.");
  return { ambientOcclusion: value?.ambientOcclusion ?? features.ambientOcclusion,
    screenSpaceReflection: value?.screenSpaceReflection ?? features.screenSpaceReflection, bloom,
    ...(value?.authorBloom ? { authorBloom: Object.freeze({ strength: value.authorBloom.strength,
      threshold: value.authorBloom.threshold }) } : {}) };
}
