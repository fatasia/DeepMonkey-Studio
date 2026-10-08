import { describe, expect, it } from "vitest";
import { decodeDeformablePacketGlb, inspectGltfDeformationFeatures } from "./decodeDeformablePacketGlb.js";
import { prepareRenderPacket } from "../renderPacket.js";
import { parseGlb } from "./parseGlb.js";
import type { JsonObject } from "./validation.js";

describe("decodeDeformablePacketGlb", () => {
  it("keeps deformation-free assets on the static path", async () => {
    const decoded = await decodeDeformablePacketGlb(staticFixture(), undefined, { resourcePrefix: "plain", liveDeformation: true });
    expect(decoded.mode).toBe("static");
    expect(decoded.features).toEqual([]);
    expect(decoded.packet.deformation).toBeUndefined();
    expect(decoded.packet.instances.every(instance => instance.pose === undefined)).toBe(true);
  });

  it("attaches skin and morph sources with bind poses when the host drives deformation", async () => {
    const decoded = await decodeDeformablePacketGlb(deformedFixture(), undefined, { resourcePrefix: "character", liveDeformation: true });
    expect(decoded.mode).toBe("live");
    expect(decoded.features).toEqual(["animations", "skins", "morphTargets"]);
    const { deformation, instances } = decoded.packet;
    expect(deformation?.sources).toMatchObject([{ id: "character/mesh/0/primitive/0/deform", kind: "morph-skin",
      geometry: "character/mesh/0/primitive/0", semantics: "three-r185" }]);
    expect(instances[0]!.pose).toBe("character/node/3/primitive/0");
    const pose = deformation!.poses[0]!;
    expect(pose.palette!.matrices).toHaveLength(2 * 16);
    expect(Array.from(pose.palette!.matrices.slice(0, 16))).toEqual(identity());
    expect(pose.morphWeights!.values[0]).toBeCloseTo(0.2);
    // 既有包校验(顶点序、实例姿态引用)必须接受该包。
    const prepared = prepareRenderPacket(decoded.packet);
    expect(prepared.deformation?.poses).toHaveLength(1);
  });

  it("degrades to a static bind pose without failing when the host cannot drive poses", async () => {
    const decoded = await decodeDeformablePacketGlb(deformedFixture(), undefined, { resourcePrefix: "character" });
    expect(decoded.mode).toBe("bind-pose");
    expect(decoded.features).toEqual(["animations", "skins", "morphTargets"]);
    expect(decoded.packet.deformation).toBeUndefined();
    expect(decoded.packet.instances).toHaveLength(1);
    expect(() => prepareRenderPacket(decoded.packet)).not.toThrow();
  });

  it("rejects a pose it cannot decode instead of publishing undeformed geometry", async () => {
    await expect(decodeDeformablePacketGlb(deformedFixture(el => { el.skins = [{ joints: [1, 2], skeleton: 1, inverseBindMatrices: 3,
      extensions: { VENDOR_unknown: {} } }]; }), undefined, { resourcePrefix: "character", liveDeformation: true }))
      .rejects.toMatchObject({ code: "unsupported" });
  });

  it("classifies glTF documents from JSON only", () => {
    expect(inspectGltfDeformationFeatures(parseGlb(deformedFixture()).json)).toEqual(["animations", "skins", "morphTargets"]);
    expect(inspectGltfDeformationFeatures(parseGlb(staticFixture()).json)).toEqual([]);
  });
});

function staticFixture(): Uint8Array {
  const { bin, offsets } = joinAligned([floats([0, 0, 0, 1, 0, 0, 0, 1, 0])]);
  return glb({ asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: offsets[0], byteLength: 36, target: 34962 }],
    accessors: [{ ...accessor(0, 3, "VEC3"), min: [0, 0, 0], max: [1, 1, 0] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }, bin);
}

function deformedFixture(edit?: (document: JsonObject) => void): Uint8Array {
  const chunks = [
    floats([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]),
    floats([1, 0, 0, 0, 0.25, 0.75, 0, 0, 0.5, 0.5, 0, 0]),
    floats([...identity(), ...identity()]),
    floats([0, 1]),
    floats([0, 0, 0, 1, 0, 0]),
    floats([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    floats([0, 1]),
  ];
  const { bin, offsets } = joinAligned(chunks);
  const document: JsonObject = {
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: chunks.map((bytes, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: bytes.length,
      ...([0, 1, 2, 6].includes(index) ? { target: 34962 } : {}) })),
    accessors: [
      accessor(0, 3, "VEC3"),
      { bufferView: 1, componentType: 5121, count: 3, type: "VEC4" },
      accessor(2, 3, "VEC4"), accessor(3, 2, "MAT4"),
      { ...accessor(4, 2, "SCALAR"), min: [0], max: [1] },
      accessor(5, 2, "VEC3"), accessor(6, 3, "VEC3"), accessor(7, 2, "SCALAR"),
    ],
    nodes: [{ children: [1, 3] }, { children: [2] }, {}, { mesh: 0, skin: 0, weights: [0.2] }],
    scenes: [{ nodes: [0] }], scene: 0,
    skins: [{ joints: [1, 2], skeleton: 1, inverseBindMatrices: 3 }],
    meshes: [{ weights: [0.1], extras: { targetNames: ["Smile"] }, primitives: [{
      attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, targets: [{ POSITION: 6 }],
    }] }],
    animations: [{ samplers: [{ input: 4, output: 5 }, { input: 4, output: 7 }], channels: [
      { sampler: 0, target: { node: 1, path: "translation" } },
      { sampler: 1, target: { node: 3, path: "weights" } },
    ] }],
  };
  edit?.(document);
  return glb(document, bin);
}

function accessor(bufferView: number, count: number, type: string): JsonObject {
  return { bufferView, componentType: 5126, count, type };
}
function identity(): number[] { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function floats(values: readonly number[]): Uint8Array { return new Uint8Array(new Float32Array(values).buffer); }
function joinAligned(chunks: readonly Uint8Array[]): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [], total = chunks.reduce((sum, bytes) => { const offset = (sum + 3) & ~3; offsets.push(offset); return offset + bytes.length; }, 0);
  const bin = new Uint8Array((total + 3) & ~3); chunks.forEach((bytes, index) => bin.set(bytes, offsets[index])); return { bin, offsets };
}
function glb(document: JsonObject, bin: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(document)), jsonLength = (encoded.length + 3) & ~3;
  const binLength = (bin.length + 3) & ~3, total = 28 + jsonLength + binLength;
  const output = new Uint8Array(total), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + jsonLength); output.set(encoded, 20);
  const cursor = 20 + jsonLength; view.setUint32(cursor, binLength, true); view.setUint32(cursor + 4, 0x004e4942, true); output.set(bin, cursor + 8);
  return output;
}
