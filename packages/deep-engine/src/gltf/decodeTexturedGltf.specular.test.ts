import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { prepareTextures } from "../textures/decodedTexture.js";
import { decodeTexturedGltf } from "./decodeTexturedGltf.js";
import { parseGlb } from "./parseGlb.js";
import { materializeRuntimeRenderPacket, serializeBrowserRenderPacket, validateRuntimeRenderPacket } from "../runtimePackage/renderPacket.js";
import type { GltfImageDecoder } from "./textureTypes.js";

function fixture(extension: Record<string, unknown>, onlySpecular = false) {
  const parsed = parseGlb(readFileSync(new URL("../../lab/assets/BoxTextured.glb", import.meta.url)));
  const json = structuredClone(parsed.json) as any;
  json.extensionsUsed = ["KHR_materials_specular"];
  json.materials[0].extensions = { KHR_materials_specular: extension };
  if (onlySpecular) delete json.materials[0].pbrMetallicRoughness.baseColorTexture;
  return { json, buffers: parsed.buffers };
}
const decoder = (): GltfImageDecoder => ({ decode: vi.fn(async () => ({
  width: 2, height: 1, data: new Uint8Array([32, 64, 128, 16, 255, 128, 64, 200]),
})) });
const decode = (source: ReturnType<typeof fixture>, options = {}) =>
  decodeTexturedGltf(source.json, source.buffers, decoder(), { advancedMaterials: true, ...options });

describe("KHR_materials_specular source material contract", () => {
  it("keeps the default profile fallback and requires explicit renderer capability", async () => {
    const source = fixture({ specularColorTexture: { index: 0 } });
    const packet = await decode(source, { advancedMaterials: false });
    expect(packet.materials[0]!.specularColorTexture).toBeUndefined();
    expect(packet.materialLosses).toContainEqual(expect.objectContaining({ assetPath: "materials[0].extensions.KHR_materials_specular" }));
    expect(packet.textures).toHaveLength(1);
  });

  it("retains both independent texture channels, factors, UV and encoded pixels", async () => {
    const source = fixture({ specularFactor: .5, specularColorFactor: [2, .25, .75],
      specularTexture: { index: 0 }, specularColorTexture: { index: 0 } }, true);
    const host = decoder(), original = JSON.stringify(source.json);
    const packet = await decodeTexturedGltf(source.json, source.buffers, host, { advancedMaterials: true });
    expect(JSON.stringify(source.json)).toBe(original);
    expect(packet.materialLosses ?? []).toEqual([]);
    expect(packet.materials[0]).toMatchObject({ specularFactor: .5, specularColorFactor: [2, .25, .75],
      specularTexture: { texture: "gltf/texture/0/specular" }, specularColorTexture: { texture: "gltf/texture/0/specularColor" } });
    expect(packet.geometries[0]!.uv0).toBeDefined();
    expect(host.decode).toHaveBeenCalledTimes(1);
    expect(packet.textures).toHaveLength(2);
    expect(packet.textures![0]!.data).toEqual(packet.textures![1]!.data);
    const prepared = prepareRenderPacket(packet);
    expect(prepared.textures.map(texture => texture.id)).toEqual(packet.textures!.map(texture => texture.id));
    expect(prepared.batches[0]!.textures).toMatchObject({ specularFactor: .5, specularColorFactor: [2, .25, .75],
      specular: { texCoord: 0 }, specularColor: { texCoord: 0 } });
    expect(prepareTextures(packet.textures!).map(texture => texture.format)).toEqual(["rgba8unorm", "rgba8unorm-srgb"]);
  });

  it("uses UV1 and the authored independent texture transform", async () => {
    const source = fixture({ specularColorTexture: { index: 0, texCoord: 1,
      extensions: { KHR_texture_transform: { offset: [.2, .3], scale: [2, 3], rotation: .5 } } } }, true);
    source.json.extensionsUsed.push("KHR_texture_transform");
    for (const mesh of source.json.meshes) for (const primitive of mesh.primitives) {
      primitive.attributes.TEXCOORD_1 = primitive.attributes.TEXCOORD_0;
    }
    const packet = await decode(source), material = packet.materials[0]!;
    expect(material.specularColorTexture).toMatchObject({ texCoord: 1, offset: [.2, .3], scale: [2, 3], rotation: .5 });
    expect(packet.geometries[0]!.uv1).toBeDefined();
    expect(prepareRenderPacket(packet).batches[0]!.textures!.specularColor!.texCoord).toBe(1);
    expect(() => prepareRenderPacket({ ...packet, geometries: packet.geometries.map(geometry => ({ ...geometry, uv1: undefined })) }))
      .toThrow("requires UV1");
  });

  it("keeps neutral untextured defaults on the stock path", async () => {
    const source = fixture({}, true), packet = await decode(source);
    expect(packet.materials[0]).not.toHaveProperty("specularFactor");
    expect(packet.materials[0]).not.toHaveProperty("specularColorFactor");
    expect(packet.materialLosses ?? []).toEqual([]);
    expect(prepareRenderPacket(packet).batches[0]!.textures).toBeUndefined();
  });

  it("retains scalar-only nonneutral reflectance without requiring core textures", async () => {
    const packet = await decode(fixture({ specularFactor: 0, specularColorFactor: [2, .5, 1] }, true));
    expect(prepareRenderPacket(packet).batches[0]!.textures).toMatchObject({ specularFactor: 0, specularColorFactor: [2, .5, 1] });
  });

  it.each([{ specularFactor: -1 }, { specularFactor: 1.01 }, { specularColorFactor: [-1, 1, 1] },
    { specularColorFactor: [1e40, 1, 1] }, { specularColorFactor: [1, 1] }, { extraProperty: 1 },
    { specularColorTexture: { index: 50 } }])("rejects invalid extension %j", async extension => {
    await expect(decode(fixture(extension))).rejects.toThrow();
  });

  it("keeps required specular fail-closed without the capability", async () => {
    const source = fixture({}), input = source.json;
    input.extensionsRequired = ["KHR_materials_specular"];
    await expect(decode(source, { advancedMaterials: false })).rejects.toThrow();
    await expect(decode(source)).resolves.toBeDefined();
  });

  it("validates the packet factor/color even when no textures are present", async () => {
    const packet = await decode(fixture({}, true));
    for (const fields of [{ specularFactor: 2 }, { specularColorFactor: [NaN, 1, 1] }, { specularColorFactor: [-1, 1, 1] }]) {
      expect(() => prepareRenderPacket({ ...packet, materials: packet.materials.map(material => ({ ...material, ...fields })) } as any)).toThrow(/specular/);
    }
  });

  it("roundtrips Browser and Native specular packets while rejecting invalid factors and unknown semantics", async () => {
    const packet = await decode(fixture({ specularFactor: .5, specularColorFactor: [.2, .4, 2],
      specularTexture: { index: 0 }, specularColorTexture: { index: 0 } }, true));
    const encoded = JSON.parse(serializeBrowserRenderPacket(packet));
    const restored = materializeRuntimeRenderPacket(encoded, "packet");
    expect(restored.materials[0]).toMatchObject(packet.materials[0]!);
    expect(restored.textures![0]!.data).toEqual(packet.textures![0]!.data);
    encoded.materials[0].specularColorFactor[0] = 0;
    expect(restored.materials[0]!.specularColorFactor![0]).toBe(Math.fround(.2));
    const nativePacket = JSON.parse(serializeBrowserRenderPacket(packet));
    expect(() => validateRuntimeRenderPacket(nativePacket, "packet")).not.toThrow();
    const nativeRestored = materializeRuntimeRenderPacket(nativePacket, "packet");
    expect(nativeRestored.materials[0]).toMatchObject(packet.materials[0]!);
    expect(nativeRestored.textures).toEqual(packet.textures);
    const invalidFactor = JSON.parse(serializeBrowserRenderPacket(packet));
    invalidFactor.materials[0].specularFactor = 2;
    expect(() => validateRuntimeRenderPacket(invalidFactor, "packet")).toThrow(/specularFactor/);
    const onlyUnknownTexture = JSON.parse(serializeBrowserRenderPacket(packet));
    for (const field of ["specularFactor", "specularColorFactor", "specularTexture", "specularColorTexture"]) delete onlyUnknownTexture.materials[0][field];
    onlyUnknownTexture.textures[0].semantic = "unimplemented-specular-profile";
    expect(() => validateRuntimeRenderPacket(onlyUnknownTexture, "packet")).toThrow(/semantic/);
  });
});
