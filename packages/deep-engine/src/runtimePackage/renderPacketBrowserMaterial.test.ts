import { expect, it } from "vitest";
import { materializeRuntimeRenderPacket, serializeBrowserRenderPacket, validateRuntimeRenderPacket } from "./renderPacket.js";
import { prepareMaterialTextures } from "../renderPacketMaterials.js";
import { packLayeredSurfaceBlock } from "../shader/materialLayeredSurface.js";
import type { RenderPacket } from "../renderPacketTypes.js";

function packet(): RenderPacket {
  return { geometries: [{ id: "g", revision: 0,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), uv0: new Float32Array([0, 0, 1, 0, 0, 1]), uv1: new Float32Array([1, 0, 0, 0, 1, 1]) }],
    materials: [{ id: "m", baseColor: [.2, .3, .4], metallic: .1, roughness: .8,
      extendedParameters: { clearcoat: { factor: .25, roughness: .4 } },
      layered: { layers: [{ coverage: .65, mode: "replace", params: { anisotropy: { strength: .2, rotation: .3 } },
        surface: { baseColor: [.8, .3, .1], metallic: .4, roughness: .6,
          baseColorTexture: { texture: "color", texCoord: 1, offset: [.13, .04], scale: [.75, .8], rotation: .2 },
          metallicRoughnessTexture: { texture: "mr", texCoord: 0 } } },
        { coverage: .4, mode: "overlay", surface: { baseColor: [.1, .6, .8] } }] } }],
    textures: ["color", "mr"].map(id => ({ id, revision: 0, semantic: id === "color" ? "baseColor" : "metallicRoughness",
      width: 1, height: 1, data: new Uint8Array([240, 128, 70, 128]) })),
    instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
}
function block(input: RenderPacket) {
  const material = input.materials[0]!, prepared = prepareMaterialTextures(new Map([[material.id, material]]),
    new Map(input.textures!.map(texture => [texture.id, texture.semantic]))).get(material.id)!.layered!;
  return { bytes: new Uint8Array(packLayeredSurfaceBlock(prepared.parameters, prepared.textures.map(layer => ({
    ...(layer.baseColor ? { baseColor: { slot: layer.baseColor, arrayLayer: 0 } } : {}),
    ...(layer.metallicRoughness ? { metallicRoughness: { slot: layer.metallicRoughness, arrayLayer: 0 } } : {}),
  }))).buffer), prepared };
}
it("roundtrips Browser layer uniforms byte-for-byte with inherited extensions, alpha bytes and UV0/UV1", () => {
  const original = packet(), restored = materializeRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(original)), "$.packet");
  expect(block(restored).bytes).toHaveLength(304);
  expect(block(restored).bytes).toEqual(block(original).bytes);
  expect(block(restored).prepared.parameters.base.clearcoat.factor).toBe(.25);
  expect(restored.textures![0]!.data).toEqual(original.textures![0]!.data);
  expect(block(restored).prepared.textures[0]).toMatchObject({ baseColor: { texture: "color", texCoord: 1 }, metallicRoughness: { texture: "mr", texCoord: 0 } });
});
it("owns restored parameter, color and UV arrays independently of the caller JSON", () => {
  const input = JSON.parse(serializeBrowserRenderPacket(packet())), restored = materializeRuntimeRenderPacket(input, "$.packet");
  const before = block(restored).bytes.slice();
  input.materials[0].layered.layers[0].surface.baseColor[0] = 0;
  input.materials[0].layered.layers[0].surface.baseColorTexture.offset[0] = .9;
  input.materials[0].extendedParameters.clearcoat.factor = 1;
  expect(block(restored).bytes).toEqual(before);
  expect(block(restored).prepared.parameters.base.clearcoat.factor).toBe(.25);
});
it("keeps Native publish strict for Browser-only extendedParameters", () => {
  const input = JSON.parse(serializeBrowserRenderPacket(packet()));
  delete input.materials[0].layered;
  expect(() => validateRuntimeRenderPacket(input, "$.packet")).toThrow("$.packet.materials[0].extendedParameters: Unknown field");
});
it("admits layered materials into the Native publish profile with the same closed validation", () => {
  // I-C23:Native 生产消费接通后,native profile 放行 layered(同一 fail-closed
  // 校验路径),材质带着规范化层栈通过 native 包校验。
  const input = JSON.parse(serializeBrowserRenderPacket(packet()));
  delete input.materials[0].extendedParameters;
  expect(() => validateRuntimeRenderPacket(input, "$.packet")).not.toThrow();
  const restored = materializeRuntimeRenderPacket(input, "$.packet");
  expect(block(restored).bytes).toHaveLength(304);
  expect(block(restored).prepared.parameters.layers).toHaveLength(2);
});
it.each([
  (input: any) => { input.materials[0].layered.layers[0].coverage = 1.5; },
  (input: any) => { input.materials[0].layered.layers.push({ coverage: 0.5 }); },
  (input: any) => { input.materials[0].layered.layers[0].mode = "screen"; },
  (input: any) => { input.materials[0].layered.layers[0].surface.metallic = 2; },
  (input: any) => { input.materials[0].layered.layers[0].surface.baseColorTexture.texture = "missing"; },
])("keeps the Native layered profile fail-closed", mutate => {
  const input = JSON.parse(serializeBrowserRenderPacket(packet()));
  delete input.materials[0].extendedParameters;
  mutate(input);
  expect(() => validateRuntimeRenderPacket(input, "$.packet")).toThrow();
});
it.each([
  (input: any) => { input.materials[0].layered.layers[0].params.anisotropy.strength = NaN; },
  (input: any) => { input.materials[0].layered.layers[0].surface.baseColorTexture.unknown = 1; },
  (input: any) => { input.materials[0].layered.layers[0].surface.baseColorTexture.offset = ["0", 0]; },
  (input: any) => { input.materials[0].layered.layers[0].surface.baseColor = ["1", 0, 0]; },
  (input: any) => { input.materials[0].extendedParameters.clearcoat.factor = null; },
  (input: any) => { input.materials[0].extendedParameters.unknown = 1; },
  (input: any) => { input.materials[0].layered.layers[0].params = { unknown: 1 }; },
])("rejects invalid or unknown nested Browser material fields", mutate => {
  const input = JSON.parse(serializeBrowserRenderPacket(packet())); mutate(input);
  expect(() => materializeRuntimeRenderPacket(input, "$.packet")).toThrow();
});
