import { describe, expect, it } from "vitest";
import { prepareRenderPacket, type RenderPacket } from "@bim-studio/deep-engine";
import { materialModesPacket, uvSetsPacket } from "./modelPacket.js";

const source: RenderPacket = {
  geometries: [{ id: "g", revision: 0,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
  textures: [{ id: "color", revision: 0, semantic: "baseColor", width: 2, height: 1,
    data: new Uint8Array([255, 128, 64, 255, 32, 64, 128, 255]) }],
  materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1, baseColorTexture: { texture: "color" } }],
  instances: [{ id: "i", geometry: "g", material: "m",
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
};

describe("Lab material modes contract fixture", () => {
  it("constructs independent emissive, MASK and BLEND resources without mutating the decoded source", () => {
    const result = materialModesPacket(source), prepared = prepareRenderPacket(result);
    expect(source.textures![0]!.data[3]).toBe(255);
    expect(result.textures).toMatchObject([{ semantic: "emissive" }, { semantic: "baseColor" }]);
    expect([...result.textures![1]!.data.filter((_value, index) => index % 4 === 3)]).toEqual([0, 255]);
    expect(prepared.textures.map(texture => texture.format)).toEqual(["rgba8unorm-srgb", "rgba8unorm-srgb"]);
    expect(prepared.batches.map(batch => batch.alphaMode).sort()).toEqual(["BLEND", "MASK", "OPAQUE"]);
    expect(prepared.batches.find(batch => batch.alphaMode === "BLEND")).toMatchObject({ count: 1 });
    expect(prepared.batches.find(batch => batch.alphaMode === "BLEND")?.sortCenter).toBeUndefined();
  });

  it("constructs an independent UV1 AO fixture without mutating UV0 or the source texture", () => {
    const beforeUv0 = source.geometries[0]!.uv0!.slice(), beforePixels = source.textures![0]!.data.slice();
    const result = uvSetsPacket(source), geometry = result.geometries[0]!, prepared = prepareRenderPacket(result);
    expect(geometry.uv1).toEqual(new Float32Array([0, 1, 0, 0, 1, 1]));
    expect(geometry.uv0).toBe(source.geometries[0]!.uv0);
    expect(source.geometries[0]!.uv0).toEqual(beforeUv0);
    expect(source.textures![0]!.data).toEqual(beforePixels);
    expect(result.materials[0]!.baseColorTexture?.texCoord).toBeUndefined();
    expect(result.materials[0]!.occlusionTexture).toMatchObject({ texture: "UvSets/ao", texCoord: 1, strength: 0.82 });
    expect(prepared.batches[0]!.textures?.baseColor?.texCoord).toBe(0);
    expect(prepared.batches[0]!.textures?.occlusion?.texCoord).toBe(1);
  });
});
