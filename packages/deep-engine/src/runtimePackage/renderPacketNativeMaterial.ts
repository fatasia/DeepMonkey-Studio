import type { LayeredSurfaceOverrides } from "../shader/materialLayeredSurface.js";
import type { NormalizedAdvancedMaterialParameters } from "../shader/materialAdvancedParameters.js";
import type { ExtendedMaterialParameters } from "../shader/materialParameters.js";
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

/**
 * C9/native stock 扩展与 advanced 保守子集守卫(与 Rust contract::validate
 * validate_stock_extensions 逐词同构;缺省字段不进此函数=扩展带全零=stock 逐位不变):
 * - extendedParameters:IOR, clearcoat and stock opaque-scene transmission are consumed;
 *   nonzero anisotropy remains unsupported. Layered transmission keeps its separate guard.
 * - advancedParameters:保守子集只放行 sheen(直射 Charlie lobe + 直/间接能量补偿);
 *   iridescence.factor/volume.thickness 非零 fail-closed 拒绝,其余如实登记未接。
 * unlit 拒绝由共享 prepareRenderPacket 的 validateMaterial 承担,此处不重复。
 */
export function assertNativeStockMaterialExtensionsSupported(
  extended: ExtendedMaterialParameters | undefined,
  advanced: NormalizedAdvancedMaterialParameters | undefined,
  path: string,
): void {
  if (extended !== undefined) {
    requireValue(extended.anisotropy.strength === 0, `${path}.extendedParameters.anisotropy.strength`,
      "Native materials do not support nonzero anisotropy.strength.");
  }
  if (advanced !== undefined) {
    requireValue(advanced.iridescence.factor === 0, `${path}.advancedParameters.iridescence.factor`,
      "Native advanced subset does not support nonzero iridescence.factor.");
    requireValue(advanced.volume.thickness === 0, `${path}.advancedParameters.volume.thickness`,
      "Native advanced subset does not support nonzero volume.thickness.");
  }
}
