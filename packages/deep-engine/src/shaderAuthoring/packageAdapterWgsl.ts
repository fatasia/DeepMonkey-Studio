import type { CompiledShaderPass, DeepShaderAsset, DeepWgslModuleDescriptor } from "../shader/types.js";
import { matchesGeneratedInterface, matchesVertexStreams, validOptions,
  type StandardPlainWgslAdapterOptions } from "./packageAdapterWgslContract.js";
import { adaptFragment } from "./packageAdapterWgslFragment.js";
import { MATERIAL_DECLARATIONS, SHADOW_ENTRY, SHADOW_MASK_ENTRY, SHADOW_MASK_TEXTURE_ENTRY } from "./packageAdapterWgslFragments.js";

export type { StandardPlainWgslAdapterOptions } from "./packageAdapterWgslContract.js";

const DEFAULT_OPTIONS: StandardPlainWgslAdapterOptions = Object.freeze({
  alphaMode: "opaque", doubleSided: false, materialMode: "plain", normalMapped: false,
});

/**
 * Converts the core compiler's internal entry names to ABI names and adds the
 * fixed instance-material coverage/raster behavior. New lines are emitted only
 * after graph node declarations, so generated node source-map lines stay stable.
 */
export function adaptStandardPlainWgsl(
  pass: CompiledShaderPass,
  asset: DeepShaderAsset,
  options: StandardPlainWgslAdapterOptions = DEFAULT_OPTIONS,
): DeepWgslModuleDescriptor | undefined {
  const vertex = "@vertex fn deepVertex(";
  const textured = options.materialMode === "base-color-texture";
  const normalMapped = options.normalMapped === true;
  if (!validOptions(options) || !matchesVertexStreams(asset, textured, normalMapped)
    || !matchesGeneratedInterface(pass, asset, options)) return undefined;
  const fragment = adaptFragment(pass.module.code, options);
  if (!fragment) return undefined;
  const shadow = options.alphaMode === "opaque" ? SHADOW_ENTRY
    : options.alphaMode === "mask" ? textured ? SHADOW_MASK_TEXTURE_ENTRY : SHADOW_MASK_ENTRY : "";
  const code = (textured ? MATERIAL_DECLARATIONS : "")
    + fragment.replace(vertex, normalMapped ? "@vertex fn vertexNormalMapped(" : "@vertex fn vertexMain(") + shadow;
  return Object.freeze({ label: `${pass.module.label}/deep-pbr-mesh-v1`, code });
}
