import type { LayeredSurfaceOverrides } from "../shader/materialLayeredSurface.js";
import type { MaterialParameterOverrides } from "../shader/materialParameters.js";
import { requireValue } from "./primitives.js";

function supportedLobes(params: MaterialParameterOverrides | undefined, path: string, layerClearcoat = false): void {
  requireValue(layerClearcoat || (params?.clearcoat?.factor ?? 0) === 0, `${path}.clearcoat.factor`,
    "Native layered materials do not support nonzero clearcoat.factor.");
  requireValue((params?.anisotropy?.strength ?? 0) === 0, `${path}.anisotropy.strength`,
    "Native layered materials do not support nonzero anisotropy.strength.");
  requireValue((params?.transmission?.factor ?? 0) === 0, `${path}.transmission.factor`,
    "Native layered materials do not support nonzero transmission.factor.");
}

/** Native consumes layer IOR, surface, textures and main-light clearcoat. Pass the
 * normalized layeredMaterialExtension result; its schema/numeric validation
 * runs for every row, including pruned rows. This guard only checks support. */
export function assertNativeLayeredMaterialSupported(layered: LayeredSurfaceOverrides | undefined, path: string): void {
  const layers = layered?.layers ?? [];
  if (!layers.some(layer => (layer.coverage ?? 0) > 0)) return;
  supportedLobes(layered?.base, `${path}.base`);
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]!;
    if ((layer.coverage ?? 0) > 0 && layer.responseModel !== "microfacet-metal-reflection") {
      supportedLobes(layer.params, `${path}.layers[${index}].params`, true);
    }
  }
}

