import type { RenderView } from "./pbrRendererTypes.js";
import { resolvePbrColorGrading } from "./pbrColorGrading.js";
import { resolvePbrEnvironmentIntensity } from "./pbrEnvironmentIntensity.js";
import { validatePanoramaBackground } from "./pbrPanoramaBackground.js";
import { validatePbrFog } from "./pbrFog.js";
import { packPbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";
import { validatePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";

export function validatePbrRenderView(view: RenderView): void {
  if (![...view.eye, ...view.target, ...(view.up ?? []), ...view.background, ...view.floor,
    view.extent, view.exposure, view.roughness].every(Number.isFinite)
    || view.extent <= 0 || view.exposure <= 0 || view.roughness <= 0) {
    throw new Error("Invalid render view.");
  }
  resolvePbrColorGrading(view.colorGrading);
  packPbrAuthorColorEffects(view.authorColorEffects);
  validatePbrPostProcessOverrides(view.postProcess);
  if (view.authorColorEffects !== undefined && view.colorGrading !== undefined) {
    throw new Error("Author color effects cannot be combined with legacy HDR grading.");
  }
  resolvePbrEnvironmentIntensity(view.environmentIntensity);
  if (view.panoramaBackground !== undefined) validatePanoramaBackground(view.panoramaBackground);
  if (view.fog !== undefined) validatePbrFog(view.fog);
}
