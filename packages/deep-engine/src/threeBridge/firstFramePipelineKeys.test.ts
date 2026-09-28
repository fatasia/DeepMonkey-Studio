import { describe, expect, it } from "vitest";
import { firstFramePipelineMainKeys } from "./firstFramePipelineKeys.js";
import type { RenderPacket } from "../renderPacket.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mirrored = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

function packet(materials: RenderPacket["materials"], instances: RenderPacket["instances"]): RenderPacket {
  return { geometries: [], materials, instances } as unknown as RenderPacket;
}

describe("first-frame pipeline key derivation", () => {
  it("maps textured opaque instances to the material depth pipeline", () => {
    const keys = firstFramePipelineMainKeys(packet([
      { id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
        baseColorTexture: { texture: "t", texCoord: 0, uvTransform: [0, 0, 0, 0, 0, 0] } },
    ], [{ id: "i", geometry: "g", material: "m", transform: identity }]));
    expect(keys).toEqual(["material/depth/ccw"]);
  });

  it("keeps normal mapping and blend/double-sided variants distinct", () => {
    const keys = firstFramePipelineMainKeys(packet([
      { id: "plain", baseColor: [1, 1, 1], metallic: 0, roughness: 1, alphaMode: "BLEND", doubleSided: true },
      { id: "normal", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
        normalTexture: { texture: "n", texCoord: 0, uvTransform: [0, 0, 0, 0, 0, 0], scale: 1 } },
    ], [
      { id: "a", geometry: "g", material: "plain", transform: identity },
      { id: "b", geometry: "g", material: "normal", transform: mirrored },
    ]));
    expect(keys.sort()).toEqual(["normal/depth/cw", "plain/blend/double"]);
  });

  it("returns plain/depth/ccw for untextured materials and stays empty for empty packets", () => {
    expect(firstFramePipelineMainKeys(packet([
      { id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1 },
    ], [{ id: "i", geometry: "g", material: "m", transform: identity }]))).toEqual(["plain/depth/ccw"]);
    expect(firstFramePipelineMainKeys(packet([], []))).toEqual([]);
  });

  it("skips instances whose material is missing instead of guessing a key", () => {
    expect(firstFramePipelineMainKeys(packet([], [
      { id: "i", geometry: "g", material: "ghost", transform: identity },
    ]))).toEqual([]);
  });
});
