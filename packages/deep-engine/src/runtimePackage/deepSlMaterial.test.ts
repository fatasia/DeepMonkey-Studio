import { describe, expect, it } from "vitest";
import { adaptDeepSlStandardToShaderPackage } from "../shaderAuthoring/packageAdapter.js";
import { ALL_TEXTURES, OPAQUE, packageRequest } from "../shaderAuthoring/packageAdapter.testFixture.js";
import { createRuntimeDeepSlMaterial } from "./deepSlMaterial.js";
import { normalizeRuntimeRenderPacket } from "./renderPacket.js";

const refs = { baseColor: "color", metallicRoughness: "mr", normal: "normal", occlusion: "ao", emissive: "emission" } as const;
function compile(source: string, targetAbi = "deep.pbr.mesh.v2") {
  return adaptDeepSlStandardToShaderPackage({ ...packageRequest(source), targetAbi });
}
function parameterized(source: string): string {
  return source.replace("\n}", `
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 8;
}`);
}

describe("DeepSL material defaults in runtime packages", () => {
  it("preserves five slots, second UVs, transforms and authored scalar parameters", () => {
    const source = parameterized(ALL_TEXTURES).replace("\n}", `
  baseColorTextureTransform texCoord 1 offset [0.25, -0.5] scale [2, 3] rotation 0.3;
  normalScale -0.75;
  occlusionStrength 0.35;
}`);
    const value = createRuntimeDeepSlMaterial("custom", compile(source), refs);
    expect(value.binding).toEqual({ materialId: "custom", packageId: "deep.package", techniqueId: "webgpu" });
    expect(value.material).toMatchObject({ baseColor: [0.12, 0.42, 0.9], metallic: 0.65, roughness: 0.24,
      baseColorTexture: { texture: "color", texCoord: 1, offset: [0.25, -0.5], scale: [2, 3], rotation: 0.3 },
      metallicRoughnessTexture: { texture: "mr" }, normalTexture: { texture: "normal", normalScale: -0.75 },
      occlusionTexture: { texture: "ao", strength: 0.35 }, emissiveTexture: { texture: "emission" },
      emissiveFactor: [0.1, 0.2, 0.3], emissiveStrength: 8,
    });
    expect(Object.isFrozen(value.material.baseColorTexture?.offset)).toBe(true);
  });

  it("applies emissive gain exactly once in plain and textured native exports", () => {
    for (const [source, references] of [[OPAQUE, {}], [ALL_TEXTURES, refs]] as const) {
      const authored = createRuntimeDeepSlMaterial("surface", compile(parameterized(source)), references);
      const packet = { materials: [JSON.parse(JSON.stringify(authored.material))] };
      normalizeRuntimeRenderPacket(packet);
      expect(packet.materials[0].emissiveFactor).toEqual([0.8, 1.6, 2.4]);
      expect(packet.materials[0]).not.toHaveProperty("emissiveStrength");
    }
  });

  it.each(["mask", "blend"])("preserves %s alpha and double-sided flags", mode => {
    const source = OPAQUE.replace("alpha opaque", `alpha ${mode}`).replace("doubleSided false", "doubleSided true");
    expect(createRuntimeDeepSlMaterial("surface", compile(source)).material).toMatchObject({
      alphaMode: mode.toUpperCase(), baseColorAlpha: 0.8, doubleSided: true, alphaCutoff: 0.5,
    });
  });

  it("refuses missing or disabled texture references and rejected compilations", () => {
    expect(() => createRuntimeDeepSlMaterial("surface", compile(ALL_TEXTURES), { baseColor: "color" })).toThrow("resolved resource reference");
    expect(() => createRuntimeDeepSlMaterial("surface", compile(OPAQUE), { normal: "normal" })).toThrow("not enabled");
    expect(() => createRuntimeDeepSlMaterial("surface", compile("invalid source"))).toThrow("rejected DeepSL");
    expect(() => createRuntimeDeepSlMaterial("surface", compile(OPAQUE, "deep.pbr.mesh.v1"))).toThrow("CSM shader ABI");
  });
});
