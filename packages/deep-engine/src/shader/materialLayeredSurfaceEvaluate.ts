import { evaluateExtendedMaterialDirect, STOCK_DIRECT_RADIANCE, type MaterialEvaluationGeometry,
  type MaterialEvaluationResult, type StandardSurfaceInputs, type Vec3 } from "./materialEvaluate.js";
import { evaluateMetalReflectionDirect } from "./materialMetalReflectionEvaluate.js";
import { normalizeLayeredSurfaceParameters, resolveLayerSurface, type LayeredSurfaceOverrides } from "./materialLayeredSurface.js";

/** Direct-response reference with per-layer surfaces and explicit metal reflection.
 * Resolve texture samples into surface values before calling. This represents
 * direct light only; stock/C8, IBL, local lights and emission are not included. */
export function evaluateLayeredSurfaceDirect(surface: StandardSurfaceInputs,
  layered: LayeredSurfaceOverrides, geometry: MaterialEvaluationGeometry,
  radiance: Vec3 = STOCK_DIRECT_RADIANCE): MaterialEvaluationResult {
  const params = normalizeLayeredSurfaceParameters(layered);
  let result = evaluateExtendedMaterialDirect(surface, params.base, geometry, radiance);
  for (let i = 0; i < params.layers.length; i++) {
    const layer = params.layers[i]!;
    if (layer.coverage === 0) continue;
    const row = params.surfaces[i];
    if (row?.baseColorTexture || row?.metallicRoughnessTexture) {
      throw new RangeError("Resolve layer texture samples before direct-response CPU evaluation.");
    }
    const resolved = resolveLayerSurface(surface, row);
    const parent = layer.responseModel === "microfacet-metal-reflection"
      ? evaluateMetalReflectionDirect(resolved, layer.params, geometry, radiance)
      : evaluateExtendedMaterialDirect(resolved, layer.params, geometry, radiance);
    const weights = parent.rgb.map(value => layer.coverage
      * (layer.mode === "replace" ? 1 : Math.max(0, Math.min(1, value))));
    const blend = (a: Vec3, b: Vec3): Vec3 => [0, 1, 2].map(channel =>
      (1 - weights[channel]!) * a[channel]! + weights[channel]! * b[channel]!) as unknown as Vec3;
    result = { rgb: Object.freeze(blend(result.rgb, parent.rgb)), components: Object.freeze({
      diffuse: Object.freeze(blend(result.components.diffuse, parent.components.diffuse)),
      specular: Object.freeze(blend(result.components.specular, parent.components.specular)),
      clearcoat: Object.freeze(blend(result.components.clearcoat, parent.components.clearcoat)),
      transmission: Object.freeze(blend(result.components.transmission, parent.components.transmission)),
    }) };
  }
  return result;
}
