import { describe, expect, it } from "vitest";
import { decodeAnimatedSkinnedGlb } from "./decodeAnimatedSkinnedGlb.js";
import { decodeSkinnedGlb } from "./decodeSkinnedGlb.js";
import { GltfImportError, type JsonObject } from "./validation.js";

describe("decodeSkinnedGlb", () => {
  it("decodes stable owned skin palettes, primitive streams, bindings, and inverse bind matrices", () => {
    const source = fixture(), decoded = decodeSkinnedGlb(source.bytes, {
      resourcePrefix: "robot", mapNodeId: (index) => `node:${index}`,
    });
    expect(decoded).toMatchObject({ abiVersion: 1, sceneIndex: 0, decodedBytes: 184 });
    expect(decoded.nodes.map(({ id }) => id)).toEqual(["node:0", "node:1", "node:2", "node:3"]);
    expect(decoded.skins[0]).toMatchObject({
      id: "robot/skin/0", sourceJointIndices: new Uint32Array([1, 2]),
      joints: ["node:1", "node:2"], sourceSkeletonIndex: 1, skeleton: "node:1",
    });
    expect(decoded.skins[0]!.inverseBindMatrices.length).toBe(32);
    expect(decoded.primitives[0]).toMatchObject({
      id: "robot/mesh/0/primitive/0", vertexCount: 2,
      joints: new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0, 0.25, 0.75, 0, 0]),
    });
    expect(decoded.bindings).toEqual([{
      sourceNodeIndex: 3, nodeId: "node:3", sourceSkinIndex: 0, skinId: "robot/skin/0",
      sourceMeshIndex: 0, primitiveIds: ["robot/mesh/0/primitive/0"],
    }]);
    for (const values of [decoded.skins[0]!.sourceJointIndices, decoded.skins[0]!.inverseBindMatrices,
      decoded.primitives[0]!.joints, decoded.primitives[0]!.weights]) expect(values.buffer).not.toBe(source.bytes.buffer);
    source.bytes.fill(0);
    expect(decoded.primitives[0]!.weights[5]).toBe(0.75);
  });

  it("decodes normalized U8/U16 weights, widens U16 joints, and normalizes output", () => {
    for (const component of ["u8", "u16"] as const) {
      const source = fixture(component, "u16"), views = source.document.bufferViews as JsonObject[];
      views[1]!.byteStride = 8;
      views[2]!.byteStride = component === "u8" ? 4 : 8;
      const decoded = decodeSkinnedGlb(glb(source.document, source.bin)), primitive = decoded.primitives[0]!;
      expect(primitive.joints).toBeInstanceOf(Uint16Array);
      expect([...primitive.joints]).toEqual([0, 1, 0, 0, 1, 0, 0, 0]);
      expect(primitive.weights[4]).toBeCloseTo(component === "u8" ? 64 / 255 : 16_384 / 65_535, 6);
      expect(primitive.weights[4]! + primitive.weights[5]! + primitive.weights[6]! + primitive.weights[7]!).toBeCloseTo(1, 7);
      expect(decodeAnimatedSkinnedGlb(glb(source.document, source.bin)).clips).toHaveLength(1);
    }
  });

  it("uses identity inverse binds when omitted and maps nodes once in the combined decoder", () => {
    const source = fixture();
    delete (source.document.skins as JsonObject[])[0]!.inverseBindMatrices;
    let mappings = 0;
    const decoded = decodeAnimatedSkinnedGlb(glb(source.document, source.bin), {
      mapNodeId: (index) => { mappings += 1; return `shared:${index}`; },
      animation: { clipPrefix: "motion" }, skinning: { resourcePrefix: "rig" },
    });
    expect(mappings).toBe(4);
    expect(decoded.clips).toHaveLength(1);
    expect(decoded.clips[0]!.id).toBe("motion/animation/0");
    expect(decoded.skins[0]!.joints).toEqual(["shared:1", "shared:2"]);
    expect(decoded.skins[0]!.inverseBindMatrices).toEqual(new Float32Array([...identity(), ...identity()]));
    expect(decoded).toMatchObject({ animationDecodedBytes: 32, skinningDecodedBytes: 184, decodedBytes: 216 });
  });

  it("rejects invalid influence attributes, counts, normalization, ranges, and buffer usage", () => {
    const cases: Array<readonly [string, (source: Fixture) => void, string]> = [
      ["joint component", ({ document }) => { (document.accessors as JsonObject[])[1]!.componentType = 5126; }, "JOINTS_0"],
      ["weight normalization", ({ document }) => { (document.accessors as JsonObject[])[2]!.normalized = true; }, "must not be normalized"],
      ["count", ({ document }) => { (document.accessors as JsonObject[])[2]!.count = 1; }, "counts must match"],
      ["alignment", ({ document }) => { (document.accessors as JsonObject[])[1]!.byteOffset = 1; }, "alignment"],
      ["stride", ({ document }) => { (document.bufferViews as JsonObject[])[1]!.byteStride = 6; }, "multiple of four"],
      ["matrix target", ({ document }) => { (document.bufferViews as JsonObject[])[3]!.target = 34962; }, "cannot declare"],
      ["matrix count", ({ document }) => { (document.accessors as JsonObject[])[3]!.count = 1; }, "count must equal"],
      ["joint range", ({ bin, offsets }) => { bin[offsets.joints] = 2; }, "exceeds the bound skin"],
      ["weight sum", ({ bin, offsets }) => { new DataView(bin.buffer).setFloat32(offsets.weights, 0.5, true); }, "normalized per vertex"],
    ];
    for (const [, mutate, message] of cases) {
      const source = fixture(); mutate(source);
      expectError(() => decodeSkinnedGlb(glb(source.document, source.bin)), "invalid", message);
    }
  });

  it("rejects duplicate or unreachable joints, invalid bindings, cycles, extra influences, and morphs", () => {
    const duplicate = fixture(); (duplicate.document.skins as JsonObject[])[0]!.joints = [1, 1];
    expectError(() => decodeSkinnedGlb(glb(duplicate.document, duplicate.bin)), "invalid", "unique");
    const unreachable = fixture();
    (unreachable.document.nodes as JsonObject[]).push({});
    (unreachable.document.skins as JsonObject[])[0]!.joints = [1, 4];
    expectError(() => decodeSkinnedGlb(glb(unreachable.document, unreachable.bin)), "invalid", "reachable");
    const noMesh = fixture(); delete (noMesh.document.nodes as JsonObject[])[3]!.mesh;
    expectError(() => decodeSkinnedGlb(glb(noMesh.document, noMesh.bin)), "invalid", "must reference a mesh");
    const cycle = fixture(); (cycle.document.nodes as JsonObject[])[2]!.children = [0];
    expectError(() => decodeSkinnedGlb(glb(cycle.document, cycle.bin)), "invalid", "cycle");
    const extra = fixture(); attributes(extra).JOINTS_1 = 1;
    expectError(() => decodeSkinnedGlb(glb(extra.document, extra.bin)), "unsupported", "four skin influences");
    const morph = fixture(); ((morph.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.targets = [{}];
    expectError(() => decodeSkinnedGlb(glb(morph.document, morph.bin)), "unsupported", "morph targets");
  });

  it("enforces skin, joint, primitive, vertex, and decoded-byte budgets and rejects external buffers", () => {
    const source = fixture();
    for (const [options, message] of [
      [{ maxJointsPerSkin: 1 }, "joints"],
      [{ maxVerticesPerPrimitive: 1 }, "count"],
      [{ maxDecodedBytes: 8 }, "decodedBytes"],
    ] as const) expectError(() => decodeSkinnedGlb(source.bytes, options), "limit", message);
    const skins = fixture(); (skins.document.skins as JsonObject[]).push({ joints: [1] });
    expectError(() => decodeSkinnedGlb(glb(skins.document, skins.bin), { maxSkins: 1 }), "limit", "skins");
    const primitives = fixture(), mesh = (primitives.document.meshes as JsonObject[])[0]!;
    (mesh.primitives as JsonObject[]).push((mesh.primitives as JsonObject[])[0]!);
    expectError(() => decodeSkinnedGlb(glb(primitives.document, primitives.bin), { maxPrimitives: 1 }), "limit", "skinPrimitives");
    const external = glb({ asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "skin.bin" }], nodes: [], scenes: [{}] });
    expectError(() => decodeSkinnedGlb(external), "unsupported", "external GLB buffers");
  });
});

type WeightComponent = "float" | "u8" | "u16";
interface Fixture {
  document: JsonObject; bin: Uint8Array; bytes: Uint8Array;
  offsets: { joints: number; weights: number };
}

function fixture(weights: WeightComponent = "float", joints: "u8" | "u16" = "u8"): Fixture {
  const weightValues = weights === "float" ? floats([1, 0, 0, 0, 0.25, 0.75, 0, 0])
    : weights === "u8" ? new Uint8Array([255, 0, 0, 0, 64, 191, 0, 0])
      : ushorts([65_535, 0, 0, 0, 16_384, 49_151, 0, 0]);
  const chunks = [floats([0, 0, 0, 1, 0, 0]), joints === "u8"
    ? new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0]) : ushorts([0, 1, 0, 0, 1, 0, 0, 0]),
  weightValues, floats([...identity(), ...identity()]), floats([0, 1]), floats([0, 0, 0, 1, 0, 0])];
  const { bin, offsets } = joinAligned(chunks);
  const document: JsonObject = {
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: chunks.map((bytes, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: bytes.length,
      ...(index < 3 ? { target: 34962 } : {}) })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 1, componentType: joints === "u8" ? 5121 : 5123, count: 2, type: "VEC4" },
      { bufferView: 2, componentType: weights === "float" ? 5126 : weights === "u8" ? 5121 : 5123,
        count: 2, type: "VEC4", ...(weights === "float" ? {} : { normalized: true }) },
      { bufferView: 3, componentType: 5126, count: 2, type: "MAT4" },
      { bufferView: 4, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 5, componentType: 5126, count: 2, type: "VEC3" },
    ],
    nodes: [{ children: [1, 3] }, { name: "RootJoint", children: [2] }, { name: "TipJoint" }, { mesh: 0, skin: 0 }],
    scenes: [{ nodes: [0] }], scene: 0,
    skins: [{ joints: [1, 2], skeleton: 1, inverseBindMatrices: 3 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    animations: [{ samplers: [{ input: 4, output: 5 }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }],
  };
  return { document, bin, bytes: glb(document, bin), offsets: { joints: offsets[1]!, weights: offsets[2]! } };
}

function attributes(source: Fixture): JsonObject {
  return (((source.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.attributes as JsonObject);
}
function identity(): number[] { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function floats(values: readonly number[]): Uint8Array { return new Uint8Array(new Float32Array(values).buffer); }
function ushorts(values: readonly number[]): Uint8Array { return new Uint8Array(new Uint16Array(values).buffer); }
function joinAligned(chunks: readonly Uint8Array[]): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [], total = chunks.reduce((sum, bytes) => { const offset = (sum + 3) & ~3; offsets.push(offset); return offset + bytes.length; }, 0);
  const bin = new Uint8Array((total + 3) & ~3); chunks.forEach((bytes, index) => bin.set(bytes, offsets[index]));
  return { bin, offsets };
}
function glb(document: JsonObject, bin?: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(document)), jsonLength = (encoded.length + 3) & ~3;
  const binLength = bin ? (bin.length + 3) & ~3 : 0, total = 20 + jsonLength + (bin ? 8 + binLength : 0);
  const output = new Uint8Array(total), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + jsonLength); output.set(encoded, 20);
  if (bin) { const cursor = 20 + jsonLength; view.setUint32(cursor, binLength, true); view.setUint32(cursor + 4, 0x004e4942, true); output.set(bin, cursor + 8); }
  return output;
}
function expectError(run: () => unknown, code: string, message: string): void {
  try { run(); throw new Error("Expected skin import to fail."); }
  catch (error) { expect(error).toBeInstanceOf(GltfImportError); expect((error as GltfImportError).code).toBe(code); expect((error as Error).message).toContain(message); }
}
