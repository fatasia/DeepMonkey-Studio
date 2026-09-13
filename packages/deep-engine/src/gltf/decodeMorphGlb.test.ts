import { describe, expect, it } from "vitest";
import { blendMorphTargetDeltas, sampleMorphWeightTrack } from "../morph/runtime.js";
import { decodeAnimatedGlb } from "./decodeAnimatedGlb.js";
import { decodeAnimatedMorphGlb } from "./decodeAnimatedMorphGlb.js";
import { decodeMorphGlb } from "./decodeMorphGlb.js";
import { decodeSkinnedGlb } from "./decodeSkinnedGlb.js";
import { GltfImportError, type JsonObject } from "./validation.js";

describe("decodeMorphGlb", () => {
  it("decodes owned POSITION/NORMAL/TANGENT targets, names, initial weights, and weight animation", () => {
    const source = fixture("LINEAR"); morphOnly(source.document);
    const bytes = glb(source.document, source.bin);
    const decoded = decodeMorphGlb(bytes, { resourcePrefix: "face", clipPrefix: "motion", mapNodeId: (index) => `node:${index}` });
    expect(decoded).toMatchObject({ abiVersion: 1, sceneIndex: 0, decodedBytes: 136 });
    expect(decoded.primitives).toHaveLength(1);
    expect(decoded.primitives[0]!.targets.map(({ name }) => name)).toEqual(["Smile", "Blink"]);
    expect(decoded.bindings.map(({ nodeId, initialWeights }) => [nodeId, [...initialWeights]])).toEqual([
      ["node:0", [expect.closeTo(0.3), expect.closeTo(0.4)]],
      ["node:1", [expect.closeTo(0.1), expect.closeTo(0.2)]],
    ]);
    const clip = decoded.morphClips[0]!, sampled = sampleMorphWeightTrack(clip.tracks[0]!, 0.5, { wrapMode: "clamp" });
    expect(clip.id).toBe("motion/morph-animation/0");
    expect([...sampled]).toEqual([0.5, 0.25]);
    const blended = blendMorphTargetDeltas(decoded.primitives[0]!, sampled);
    expect([...blended.positionDeltas!.subarray(0, 3)]).toEqual([0.5, 0.5, 0]);
    expect([...blended.normalDeltas!.subarray(0, 3)]).toEqual([0, 0.5, 0]);
    expect([...blended.tangentDeltas!.subarray(0, 3)]).toEqual([0, 0, 0.5]);
    for (const values of [decoded.primitives[0]!.targets[0]!.positionDeltas!, decoded.bindings[0]!.initialWeights,
      clip.tracks[0]!.times, clip.tracks[0]!.values]) expect(values.buffer).not.toBe(bytes.buffer);
    bytes.fill(0);
    expect(decoded.primitives[0]!.targets[0]!.positionDeltas![0]).toBe(1);
    const step = fixture("STEP"); morphOnly(step.document);
    expect(decodeMorphGlb(glb(step.document, step.bin)).morphClips[0]!.tracks[0]!.interpolation).toBe("STEP");
  });

  it("combines transform and morph animation with one parse and one stable node mapping", () => {
    const source = fixture("CUBICSPLINE"); let mappings = 0;
    const decoded = decodeAnimatedMorphGlb(source.bytes, {
      mapNodeId: (index) => { mappings += 1; return `shared:${index}`; },
      animation: { clipPrefix: "trs" }, morph: { clipPrefix: "shape", resourcePrefix: "mesh" },
    });
    expect(mappings).toBe(2);
    expect(decoded.transformClips).toHaveLength(1);
    expect(decoded.transformClips[0]!.tracks.map(({ path }) => path)).toEqual(["translation"]);
    expect(decoded.morphClips[0]!.tracks[0]).toMatchObject({ nodeId: "shared:0", targetCount: 2, interpolation: "CUBICSPLINE" });
    expect([...sampleMorphWeightTrack(decoded.morphClips[0]!.tracks[0]!, 0.5, { wrapMode: "clamp" })]).toEqual([0.5, 0.25]);
    expect(decoded).toMatchObject({ transformAnimationDecodedBytes: 32, morphDecodedBytes: 168, decodedBytes: 200 });
  });

  it("strictly validates target accessors, semantics, base attributes, and target consistency", () => {
    const cases: Array<readonly [string, (source: Fixture) => void, string, string]> = [
      ["type", ({ document }) => { (document.accessors as JsonObject[])[3]!.type = "VEC4"; }, "invalid", "FLOAT VEC3"],
      ["count", ({ document }) => { (document.accessors as JsonObject[])[3]!.count = 1; }, "invalid", "counts must match"],
      ["stride", ({ document }) => { (document.bufferViews as JsonObject[])[3]!.byteStride = 10; }, "invalid", "multiple of four"],
      ["target", ({ document }) => { (document.bufferViews as JsonObject[])[3]!.target = 34963; }, "invalid", "conflicts"],
      ["non-finite", ({ bin, offsets }) => { new DataView(bin.buffer).setFloat32(offsets.target0Position, Number.NaN, true); }, "invalid", "non-finite"],
      ["reference", (source) => { targets(source)[0]!.POSITION = 999; }, "invalid", "out of range"],
      ["semantic", (source) => { targets(source)[0]!.COLOR_0 = 3; }, "unsupported", "semantic COLOR_0"],
      ["base normal", (source) => { delete attributes(source).NORMAL; }, "invalid", "base NORMAL"],
      ["mesh weights", ({ document }) => { (document.meshes as JsonObject[])[0]!.weights = [0]; }, "invalid", "finite float32"],
      ["node weights", ({ document }) => { (document.nodes as JsonObject[])[0]!.weights = [0]; }, "invalid", "finite float32"],
      ["names", ({ document }) => { ((document.meshes as JsonObject[])[0]!.extras as JsonObject).targetNames = ["same", "same"]; }, "invalid", "unique"],
    ];
    for (const [, mutate, code, message] of cases) {
      const source = fixture("LINEAR"); morphOnly(source.document); mutate(source);
      expectError(() => decodeMorphGlb(glb(source.document, source.bin)), code, message);
    }
    const inconsistent = fixture("LINEAR"); morphOnly(inconsistent.document);
    const mesh = (inconsistent.document.meshes as JsonObject[])[0]!, primitive = (mesh.primitives as JsonObject[])[0]!;
    (mesh.primitives as JsonObject[]).push({ ...primitive, targets: [targets(inconsistent)[0]] });
    expectError(() => decodeMorphGlb(glb(inconsistent.document, inconsistent.bin)), "invalid", "consistent nonzero target count");
  });

  it("strictly validates morph animation layout, target binding, duplicates, and interpolation", () => {
    const output = fixture("LINEAR"); morphOnly(output.document); (output.document.accessors as JsonObject[])[8]!.count = 3;
    expectError(() => decodeMorphGlb(glb(output.document, output.bin)), "invalid", "output count");
    const duplicate = fixture("LINEAR"); morphOnly(duplicate.document);
    const animation = (duplicate.document.animations as JsonObject[])[0]!, channel = (animation.channels as JsonObject[])[0]!;
    (animation.channels as JsonObject[]).push({ ...channel });
    expectError(() => decodeMorphGlb(glb(duplicate.document, duplicate.bin)), "invalid", "duplicate weights channel");
    const unbound = fixture("LINEAR"); morphOnly(unbound.document);
    delete (unbound.document.nodes as JsonObject[])[1]!.mesh;
    ((unbound.document.animations as JsonObject[])[0]!.channels as JsonObject[])[0]!.target = { node: 1, path: "weights" };
    expectError(() => decodeMorphGlb(glb(unbound.document, unbound.bin)), "invalid", "no morph binding");
    const interpolation = fixture("LINEAR"); morphOnly(interpolation.document);
    ((interpolation.document.animations as JsonObject[])[0]!.samplers as JsonObject[])[0]!.interpolation = "CATMULLROMSPLINE";
    expectError(() => decodeMorphGlb(glb(interpolation.document, interpolation.bin)), "unsupported", "CATMULLROMSPLINE");
  });

  it("keeps legacy decoders fail-closed and explicitly rejects unsupported standalone channels and morph sets", () => {
    const source = fixture("LINEAR");
    expectError(() => decodeMorphGlb(source.bytes), "unsupported", "transform animation");
    expectError(() => decodeAnimatedGlb(source.bytes), "unsupported", "morph weights");
    expectError(() => decodeSkinnedGlb(source.bytes), "unsupported", "morph weights");
    const unsupported = fixture("LINEAR"); morphOnly(unsupported.document); targets(unsupported)[0]!.POSITION_1 = 3;
    expectError(() => decodeMorphGlb(glb(unsupported.document, unsupported.bin)), "unsupported", "POSITION_1");
  });

  it("enforces morph target, vertex, primitive, key, and decoded-byte budgets", () => {
    const source = fixture("LINEAR"); morphOnly(source.document);
    for (const [options, message] of [
      [{ maxTargetsPerPrimitive: 1 }, "targets"], [{ maxVerticesPerPrimitive: 1 }, "count"],
      [{ maxKeysPerTrack: 1 }, "count"], [{ maxDecodedBytes: 8 }, "decodedBytes"],
    ] as const) expectError(() => decodeMorphGlb(glb(source.document, source.bin), options), "limit", message);
    const primitives = fixture("LINEAR"); morphOnly(primitives.document);
    const mesh = (primitives.document.meshes as JsonObject[])[0]!, primitive = (mesh.primitives as JsonObject[])[0]!;
    (mesh.primitives as JsonObject[]).push({ ...primitive });
    expectError(() => decodeMorphGlb(glb(primitives.document, primitives.bin), { maxPrimitives: 1 }), "limit", "morphPrimitives");
  });
});

type Interpolation = "LINEAR" | "STEP" | "CUBICSPLINE";
interface Fixture { document: JsonObject; bin: Uint8Array; bytes: Uint8Array; offsets: { target0Position: number } }
function fixture(interpolation: Interpolation): Fixture {
  const morphValues = interpolation === "CUBICSPLINE"
    ? [0, 0, 0, 0, 0, 0, 0, 0, 1, 0.5, 0, 0]
    : [0, 0, 1, 0.5];
  const chunks = [
    floats([0, 0, 0, 1, 0, 0]), floats([0, 1, 0, 0, 1, 0]), floats([1, 0, 0, 1, 1, 0, 1, 0]),
    floats([1, 0, 0, 1, 0, 0]), floats([0, 1, 0, 0, 1, 0]), floats([0, 0, 1, 0, 0, 1]),
    floats([0, 2, 0, 0, 2, 0]), floats([0, 1]), floats(morphValues), floats([0, 0, 0, 1, 0, 0]),
  ];
  const { bin, offsets } = join(chunks);
  const document: JsonObject = {
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: chunks.map((bytes, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: bytes.length,
      ...(index <= 6 ? { target: 34962 } : {}) })),
    accessors: [
      accessor(0, 2, "VEC3"), accessor(1, 2, "VEC3"), accessor(2, 2, "VEC4"), accessor(3, 2, "VEC3"),
      accessor(4, 2, "VEC3"), accessor(5, 2, "VEC3"), accessor(6, 2, "VEC3"),
      { ...accessor(7, 2, "SCALAR"), min: [0], max: [1] }, accessor(8, morphValues.length, "SCALAR"), accessor(9, 2, "VEC3"),
    ],
    meshes: [{ weights: [0.1, 0.2], extras: { targetNames: ["Smile", "Blink"] }, primitives: [{
      attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2 },
      targets: [{ POSITION: 3, NORMAL: 4, TANGENT: 5 }, { POSITION: 6 }],
    }] }],
    nodes: [{ mesh: 0, weights: [0.3, 0.4], children: [1] }, { mesh: 0 }], scenes: [{ nodes: [0] }],
    animations: [{ samplers: [{ input: 7, output: 8, interpolation }, { input: 7, output: 9 }],
      channels: [{ sampler: 0, target: { node: 0, path: "weights" } }, { sampler: 1, target: { node: 0, path: "translation" } }] }],
  };
  return { document, bin, bytes: glb(document, bin), offsets: { target0Position: offsets[3]! } };
}
function accessor(bufferView: number, count: number, type: string): JsonObject { return { bufferView, componentType: 5126, count, type }; }
function morphOnly(document: JsonObject): void {
  const animation = (document.animations as JsonObject[])[0]!;
  animation.samplers = [(animation.samplers as JsonObject[])[0]!]; animation.channels = [(animation.channels as JsonObject[])[0]!];
}
function targets(source: Fixture): JsonObject[] { return (((source.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.targets as JsonObject[]); }
function attributes(source: Fixture): JsonObject { return (((source.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.attributes as JsonObject); }
function floats(values: readonly number[]): Uint8Array { return new Uint8Array(new Float32Array(values).buffer); }
function join(chunks: readonly Uint8Array[]): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [], total = chunks.reduce((sum, bytes) => { offsets.push(sum); return sum + bytes.length; }, 0), bin = new Uint8Array(total);
  chunks.forEach((bytes, index) => bin.set(bytes, offsets[index])); return { bin, offsets };
}
function glb(document: JsonObject, bin: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(document)), jsonLength = (encoded.length + 3) & ~3, total = 28 + jsonLength + bin.length;
  const output = new Uint8Array(total), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + jsonLength); output.set(encoded, 20);
  const cursor = 20 + jsonLength; view.setUint32(cursor, bin.length, true); view.setUint32(cursor + 4, 0x004e4942, true); output.set(bin, cursor + 8); return output;
}
function expectError(run: () => unknown, code: string, message: string): void {
  try { run(); throw new Error("Expected morph import to fail."); }
  catch (error) { expect(error).toBeInstanceOf(GltfImportError); expect((error as GltfImportError).code).toBe(code); expect((error as Error).message).toContain(message); }
}
