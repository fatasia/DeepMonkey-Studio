import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import { encodePbrDisplayColor } from "./pbrDisplayColor.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";

/** Selects the lossless one-pass presentation path when no effect needs HDR color history. */
export function pbrDirectDisplayClear(view: PbrFrameUniformView, features: PbrRendererFeatures,
  hasTransparent: boolean): readonly [number, number, number] | undefined {
  if (view.authorColorEffects?.vignette || view.authorColorEffects?.colorGrading
    || view.fog || view.panoramaBackground || hasTransparent || features.ambientOcclusion || features.temporalAa || features.spatialAa || features.occlusionCulling
    || features.bloom || (features.vignette && view.authorColorEffects === undefined)) return undefined;
  return encodePbrDisplayColor(view.background, { exposure: view.exposure,
    toneMapping: features.toneMapping,
    ...(view.colorGrading === undefined ? {} : { colorGrading: view.colorGrading }) });
}
