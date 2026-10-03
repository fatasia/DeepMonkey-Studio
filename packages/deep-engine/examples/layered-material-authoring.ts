import type { RenderPacket } from "@bim-studio/deep-engine";
import { normalizeLayeredSurfaceParameters } from "@bim-studio/deep-engine/shader";
import { buildDeepRuntimePackage, serializeDeepRuntimePackage,
  type BuildDeepRuntimePackageInput } from "@bim-studio/deep-engine/runtime-package";

/** Set two layers on one material, replacing its layer rows and preserving its
 * existing layered base. Geometry, instances and the source packet stay intact. */
export function withCoatMetalLayers(packet: RenderPacket, materialId: string): RenderPacket {
  const normalized = normalizeLayeredSurfaceParameters({ layers: [
    { coverage: .6, mode: "replace", params: { clearcoat: { factor: .7, roughness: .4 } },
      surface: { baseColor: [.8, .6, .4], metallic: 0, roughness: .7 } },
    { coverage: .7, mode: "overlay", responseModel: "microfacet-metal-reflection",
      params: { anisotropy: { strength: .8, rotation: .4 } },
      surface: { baseColor: [.9, .5, .2], metallic: 1, roughness: .6 } },
  ] });
  const layered = { layers: normalized.layers.map((layer, index) => ({
    ...layer, surface: normalized.surfaces[index]!,
  })) };
  let matches = 0;
  const materials = packet.materials.map(material => {
    if (material.id !== materialId) return material;
    matches++;
    return { ...material, layered: { ...layered,
      ...(material.layered?.base === undefined ? {} : { base: material.layered.base }),
    } };
  });
  if (matches !== 1) throw new RangeError("Expected exactly one existing material id.");
  return { ...packet, materials };
}

/** The existing package builder validates and snapshots the complete native-compatible packet.
 * The caller supplies package identity and the new render-packet revision. */
export function serializeCoatMetalPackage(input: BuildDeepRuntimePackageInput, materialId: string): string {
  return serializeDeepRuntimePackage(buildDeepRuntimePackage({ ...input, renderPacket: {
    ...input.renderPacket, value: withCoatMetalLayers(input.renderPacket.value, materialId),
  } }));
}
