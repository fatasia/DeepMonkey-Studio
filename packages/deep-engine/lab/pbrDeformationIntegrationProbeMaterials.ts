import type { RenderPacket, PbrMaterial } from "../src/renderPacket.js";
import type { DecodedTexture } from "../src/textures/decodedTexture.js";
import { integrationFixture, type IntegrationKind } from "./pbrDeformationIntegrationProbeFixture.js";

export function integrationMaterialFixture(kind: IntegrationKind) {
  const base = integrationFixture(kind), original = base.packet;
  const skinning = original.deformation!.sources[0]!.skinning;
  if (skinning) Object.assign(skinning, { tangents: original.geometries[0]!.tangents!.slice() });
  const texture = (id: string, semantic: DecodedTexture["semantic"], data: number[], width = 1, height = 1): DecodedTexture => ({
    id, revision: 1, semantic, width, height, data: new Uint8Array(data),
    sampler: { minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest" } });
  const textures = [texture("white", "baseColor", [255, 255, 255, 255]),
    texture("mask", "baseColor", [255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255], 2, 2),
    texture("normal", "normal", [128, 128, 255, 255]),
    texture("mr", "metallicRoughness", [255, 192, 0, 255]),
    texture("ao", "occlusion", [192, 192, 192, 255]),
    texture("emission", "emissive", [255, 255, 255, 255])];
  const materials: PbrMaterial[] = original.materials.map((material, index) => ({
    id: material.id, baseColor: material.baseColor, metallic: 0.1, roughness: 0.7, doubleSided: true,
    baseColorTexture: { texture: index === 0 ? "mask" : "white" },
    normalTexture: { texture: "normal", normalScale: 1 }, metallicRoughnessTexture: { texture: "mr" },
    occlusionTexture: { texture: "ao", strength: 0.5 }, emissiveTexture: { texture: "emission", texCoord: 1 },
    emissiveFactor: material.baseColor, emissiveStrength: 1,
    alphaMode: index === 0 ? "MASK" : index === 1 ? "BLEND" : "OPAQUE", alphaCutoff: 0.5,
    baseColorAlpha: index === 1 ? 0.8 : 1,
  }));
  const geometry = { ...original.geometries[0]!, uv0: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    uv1: new Float32Array([1, 0, 0, 0, 0.5, 1]) };
  const instances = [...original.instances, ...original.instances.slice(0, 64).map((instance, index) => ({ ...instance, id: `extra-${index}` }))];
  const packet: RenderPacket = { ...original, geometries: [geometry], materials, instances, textures };
  return { packet, moved: { ...base.moved, materials, instances } };
}
