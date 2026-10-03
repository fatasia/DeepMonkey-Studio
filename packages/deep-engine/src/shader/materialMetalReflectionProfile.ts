import type { MaterialLayerOverrideInput } from "./materialLayeredParameters.js";
import type { MaterialLayerSurfaceOverride } from "./materialLayeredSurface.js";

/** Explicit single-scattering conductor model. Absence preserves the legacy model. */
export function assertMetalReflectionLayer(layer: MaterialLayerOverrideInput & { readonly surface?: MaterialLayerSurfaceOverride }): void {
  if (layer.responseModel !== "microfacet-metal-reflection" || (layer.coverage ?? 0) === 0) return;
  if (layer.surface?.metallic !== 1 || layer.surface.metallicRoughnessTexture !== undefined) {
    throw new RangeError("microfacet-metal-reflection requires explicit surface.metallic=1 and no metallicRoughnessTexture.");
  }
  if ((layer.params?.clearcoat?.factor ?? 0) !== 0 || (layer.params?.transmission?.factor ?? 0) !== 0) {
    throw new RangeError("microfacet-metal-reflection does not support clearcoat or transmission.");
  }
  const rotation = layer.params?.anisotropy?.rotation ?? 0;
  if (!Number.isFinite(rotation) || Math.abs(rotation) > Math.fround(Math.PI)) {
    throw new RangeError("microfacet-metal-reflection rotation must be in [-pi, pi].");
  }
}
