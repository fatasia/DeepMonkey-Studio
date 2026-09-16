import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { materializeRuntimeRenderPacket, validateRuntimeRenderPacket } from "./renderPacket.js";

function encodedPacket() {
  return {
    geometries: [{ id: "triangle", revision: 7,
      vertices: { 0: -1, 1: -1, 2: 0, 3: 0, 4: 0, 5: 1,
        6: 1, 7: -1, 8: 0, 9: 0, 10: 0, 11: 1,
        12: 0, 13: 1, 14: 0, 15: 0, 16: 0, 17: 1 },
      indices: { 0: 0, 1: 1, 2: 2 },
      uv0: { 0: 0, 1: 0, 2: 1, 3: 0, 4: .5, 5: 1 },
      uv1: { 0: .1, 1: .2, 2: .8, 3: .2, 4: .5, 5: .9 },
      tangents: { 0: 1, 1: 0, 2: 0, 3: 1, 4: 1, 5: 0, 6: 0, 7: 1,
        8: 1, 9: 0, 10: 0, 11: 1 } }],
    materials: [{ id: "surface", baseColor: [.25, .5, .75], metallic: .2, roughness: .7,
      emissiveFactor: [2, 4, 8] }],
    instances: [{ id: "subject", geometry: "triangle", material: "surface",
      transform: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 0, 7: 0,
        8: 0, 9: 0, 10: 1, 11: 0, 12: 0, 13: 0, 14: 0, 15: 1 } }],
    textures: [{ id: "pixel", revision: 3, semantic: "baseColor", width: 2, height: 2,
      data: { 0: 7, 1: 111, 2: 201, 3: 255, 4: 7, 5: 111, 6: 201, 7: 255,
        8: 7, 9: 111, 10: 201, 11: 255, 12: 7, 13: 111, 14: 201, 15: 255 }, mipmaps: [
        { width: 1, height: 1, data: { 0: 9, 1: 10, 2: 11, 3: 255 } },
      ] }],
  };
}

describe("runtime RenderPacket materialization", () => {
  it("rehydrates dense typed-array objects without losing geometry, transforms, UVs, tangents or mips", () => {
    const input = encodedPacket();
    const packet = materializeRuntimeRenderPacket(input, "$.packet");

    expect(packet.geometries[0]).toMatchObject({ revision: 7,
      vertices: expect.any(Float32Array), indices: expect.any(Uint32Array),
      uv0: expect.any(Float32Array), uv1: expect.any(Float32Array), tangents: expect.any(Float32Array) });
    expect(packet.geometries[0]!.vertices).toHaveLength(18);
    expect(packet.geometries[0]!.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(packet.instances[0]!.transform).toBeInstanceOf(Float32Array);
    expect(packet.textures?.[0]!.data).toHaveLength(16);
    expect(packet.textures?.[0]!.mipmaps?.[0]!.data).toEqual(new Uint8Array([9, 10, 11, 255]));
  });

  it("re-splits normalized HDR emission while preserving the rendered linear value", () => {
    const packet = materializeRuntimeRenderPacket(encodedPacket(), "$.packet");
    expect(packet.materials[0]).toMatchObject({ emissiveFactor: [.25, .5, 1], emissiveStrength: 8 });
    const batch = prepareRenderPacket(packet).batches[0]!;
    expect(Array.from(batch.data.slice(32, 35))).toEqual([2, 4, 8]);
  });

  it("rejects runtime emission outside the shared HDR limit", () => {
    const input = encodedPacket();
    input.materials[0]!.emissiveFactor = [2, 4, 257];
    expect(() => validateRuntimeRenderPacket(input, "$.packet")).toThrow(/HDR limit/);
  });
});
