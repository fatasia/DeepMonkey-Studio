import { describe, expect, it } from "vitest";
import { firstFramePipelineMainKeys, packetFirstFrameRendererOptions, projectionFirstFrameMainKeys } from "./firstFramePipelineKeys.js";
import type { RenderPacket } from "../renderPacket.js";
import { normalizeExtendedMaterialParameters } from "../shader/materialParameters.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mirrored = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

function packet(materials: RenderPacket["materials"], instances: RenderPacket["instances"]): RenderPacket {
  return { geometries: [], materials, instances } as unknown as RenderPacket;
}

describe("first-frame pipeline key derivation", () => {
  it.each([{ specularFactor: .5 }, { specularColorFactor: [.5,1,1] as const },
    { specularTexture: { texture:"strength",texCoord:0 as const } },
    { specularColorTexture: { texture:"color",texCoord:0 as const } }])("includes specular-only material variants in the critical subset", fields => {
    const source = packet([{ id:"m",baseColor:[1,1,1],roughness:1,metallic:0,...fields }],
      [{ id:"i",geometry:"g",material:"m",transform:identity }]);
    expect(firstFramePipelineMainKeys(source,"all",true)).toEqual(["material/depth/ccw"]);
  });
  it("keeps explicit neutral specular factors in the stock plain critical subset", () => {
    const source = packet([{ id:"m",baseColor:[1,1,1],roughness:1,metallic:0,specularFactor:1,specularColorFactor:[1,1,1] }],
      [{ id:"i",geometry:"g",material:"m",transform:identity }]);
    expect(firstFramePipelineMainKeys(source,"all",true)).toEqual(["plain/depth/ccw"]);
  });
  it("routes opaque transmission to the advanced blend key without mutating authored alpha", () => {
    const material = { id: "glass", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 0,
      alphaMode: "OPAQUE" as const, baseColorAlpha: 1,
      extendedParameters: normalizeExtendedMaterialParameters({ transmission: { factor: 1 } }) };
    const source = packet([material], [{ id: "glass", geometry: "g", material: "glass", transform: identity }]);
    expect(packetFirstFrameRendererOptions({ advancedMaterials: true }, source).pipelines!.firstFrameMainKeys).toEqual(["material/blend/ccw"]);
    expect(packetFirstFrameRendererOptions({}, source).pipelines!.firstFrameMainKeys).toEqual(["material/depth/ccw"]);
    const projection = { project: () => ({ ok: true, packet: source }) };
    expect(projectionFirstFrameMainKeys(projection as never, {} as never, 1, undefined, true)).toEqual(["material/blend/ccw"]);
    expect(projectionFirstFrameMainKeys(projection as never, {} as never, 1)).toEqual(["material/depth/ccw"]);
    expect(material.alphaMode).toBe("OPAQUE"); expect(material.baseColorAlpha).toBe(1);
  });
  it("separates static and pose keys and starts known poses in the bootstrap scope", () => {
    const source = packet([
      { id: "static", baseColor: [1, 1, 1], metallic: 0, roughness: 1 },
      { id: "pose", baseColor: [1, 1, 1], metallic: 0, roughness: 1, alphaMode: "BLEND", doubleSided: true },
    ], [
      { id: "a", geometry: "g", material: "static", transform: identity },
      { id: "b", geometry: "g", material: "pose", transform: identity, pose: "p" },
    ]);
    const options = packetFirstFrameRendererOptions({ deformation: true, pipelines: { deferDeformation: true } }, source);
    expect(options.pipelines).toMatchObject({ firstFrameMainKeys: ["plain/depth/ccw"],
      deformationFirstFrameMainKeys: ["plain/blend/double"], deferDeformation: false });
    expect(Object.isFrozen(options.pipelines!.deformationFirstFrameMainKeys)).toBe(true);
    const full = { deformation: true, pipelines: { firstFrameSubset: false, deferDeformation: true } };
    expect(packetFirstFrameRendererOptions(full, source)).toBe(full);
    expect(firstFramePipelineMainKeys({ ...source, instances: [source.instances[1]!] }, "static")).toEqual([]);
  });
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

  it("carries the a2c suffix for alpha-to-coverage materials (renderPacketBatches key parity)", () => {
    const keys = firstFramePipelineMainKeys(packet([
      { id: "a2c", baseColor: [1, 1, 1], metallic: 0, roughness: 1, alphaToCoverage: true },
      { id: "a2c-blend", baseColor: [1, 1, 1], metallic: 0, roughness: 1, alphaToCoverage: true, alphaMode: "BLEND" },
    ], [
      { id: "i", geometry: "g", material: "a2c", transform: identity },
      { id: "j", geometry: "g", material: "a2c-blend", transform: identity },
    ]));
    // BLEND+a2c 是 renderPacketBatches 拒绝的非法组合,这里不产生该键
    // (无纹理 BLEND 材质走 plain 模式)。
    expect(keys.sort()).toEqual(["plain/blend/ccw", "plain/depth/ccw/a2c"]);
  });
});
