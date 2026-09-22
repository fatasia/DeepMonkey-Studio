import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";

/** Verified production blockers. Keep this explicit so later ABI work can fail closed again. */
export const TEXTURE_ARRAY_PRODUCTION_BLOCKERS = Object.freeze([] as const);

export function assertTextureArrayProductionReady(features: PbrRendererFeatures): void {
  if (!features.textureArrays) return;
  if (TEXTURE_ARRAY_PRODUCTION_BLOCKERS.length) {
    throw new Error(`PBR texture arrays are not production-ready: ${TEXTURE_ARRAY_PRODUCTION_BLOCKERS.join(", ")}.`);
  }
}
