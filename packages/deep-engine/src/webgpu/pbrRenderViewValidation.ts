import type { RenderView } from "./pbrRendererTypes.js";
import { resolvePbrColorGrading } from "./pbrColorGrading.js";
import { resolvePbrEnvironmentIntensity } from "./pbrEnvironmentIntensity.js";
import { resolvePbrGlobalIlluminationIntensity } from "./pbrGlobalIlluminationIntensity.js";
import { validatePanoramaBackground } from "./pbrPanoramaBackground.js";
import { validatePbrFog } from "./pbrFog.js";
import { packPbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";
import { validatePbrPostProcessOverrides, resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";

export function validatePbrRenderView(view: RenderView, features?: PbrRendererFeatures): void {
  if (![...view.eye, ...view.target, ...(view.up ?? []), ...view.background, ...view.floor,
    view.extent, view.exposure, view.roughness].every(Number.isFinite)
    || view.extent <= 0 || view.exposure <= 0 || view.roughness <= 0) {
    throw new Error("Invalid render view.");
  }
  resolvePbrColorGrading(view.colorGrading);
  packPbrAuthorColorEffects(view.authorColorEffects);
  validatePbrPostProcessOverrides(view.postProcess);
  if (view.authorDirectDisplay !== undefined && typeof view.authorDirectDisplay !== "boolean") {
    throw new TypeError("Author direct display must be boolean.");
  }
  const effects = view.authorDirectDisplay && features
    ? resolvePbrPostProcessOverrides(view.postProcess, features) : view.postProcess;
  if (view.authorDirectDisplay && (view.authorColorEffects?.vignette || view.authorColorEffects?.colorGrading
    || view.colorGrading !== undefined || effects?.ambientOcclusion || effects?.bloom
    || effects?.screenSpaceReflection || effects?.volumetricFog)) {
    throw new Error("Author direct display cannot be combined with HDR post-processing.");
  }
  if (view.authorColorEffects !== undefined && view.colorGrading !== undefined) {
    throw new Error("Author color effects cannot be combined with legacy HDR grading.");
  }
  resolvePbrEnvironmentIntensity(view.environmentIntensity);
  resolvePbrGlobalIlluminationIntensity(view.globalIlluminationIntensity);
  if (view.panoramaBackground !== undefined) validatePanoramaBackground(view.panoramaBackground);
  if (view.fog !== undefined) validatePbrFog(view.fog);
}
