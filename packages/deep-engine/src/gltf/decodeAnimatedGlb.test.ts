import { describe, expect, it } from "vitest";
import { SceneAnimationMixer } from "../animation/SceneAnimationMixer.js";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import { decodeAnimatedGlb } from "./decodeAnimatedGlb.js";
import { GltfImportError, type JsonObject } from "./validation.js";

describe("decodeAnimatedGlb", () => {
  it("decodes owned STEP/LINEAR/CUBICSPLINE tracks and applies them to selected scene nodes", () => {
    const source = fixture();
    const decoded = decodeAnimatedGlb(source.bytes, { clipPrefix: "factory", mapNodeId: (index) => `node:${index}` });
    expect(decoded).toMatchObject({ sceneIndex: 0, decodedBytes: 152 });
    expect(decoded.nodes).toEqual([
      expect.objectContaining({ sourceNodeIndex: 0, id: "node:0", parent: null, name: "Root" }),
      expect.objectContaining({ sourceNodeIndex: 1, id: "node:1", parent: "node:0", name: "Arm" }),
    ]);
    const clip = decoded.clips[0]!;
    expect(clip.id).toBe("factory/animation/0");
    expect(clip.tracks.map(({ path, interpolation }) => [path, interpolation])).toEqual([
      ["translation", "LINEAR"], ["rotation", "STEP"], ["scale", "CUBICSPLINE"],
    ]);
    for (const track of clip.tracks) {
      expect(track.times).toBeInstanceOf(Float32Array);
      expect(track.values).toBeInstanceOf(Float32Array);
      expect(track.times.buffer).not.toBe(source.bytes.buffer);
      expect(track.values.buffer).not.toBe(source.bytes.buffer);
    }

    const graph = new SceneTransformGraph<string>();
    graph.transaction((draft) => { for (const node of decoded.nodes) draft.create({ id: node.id, parent: node.parent, localTransform: node.localTransform }); });
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(clip);
    mixer.play({ id: "play", clipId: clip.id, time: 1, wrapMode: "clamp" });
    mixer.sampleAndApply(graph, 0);
    expect(graph.getNode("node:0")?.localMatrix[12]).toBe(10);
    const arm = graph.getNode("node:1")!;
    expect(arm.localTransform.kind === "trs" && arm.localTransform.scale).toEqual([2, 2, 2]);
    source.bytes.fill(0);
    expect(clip.tracks[0]?.values[3]).toBe(10);
  });

  it("uses source node indices by default and maps only the selected scene", () => {
    const source = fixture();
    source.document.nodes = [...source.document.nodes as unknown[], { name: "Other" }];
    source.document.scenes = [{ nodes: [0] }, { nodes: [2] }];
    source.document.animations = [];
    const decoded = decodeAnimatedGlb(glb(source.document, source.bin), { sceneIndex: 1 });
    expect(decoded.nodes.map(({ id }) => id)).toEqual([2]);
    expect(decoded.clips).toEqual([]);
  });

  it("rejects channels outside the selected scene, matrix targets, weights, and duplicates", () => {
    const outside = fixture();
    outside.document.nodes = [...outside.document.nodes as unknown[], {}];
    (outside.document.animations as JsonObject[])[0]!.channels = [{ sampler: 0, target: { node: 2, path: "translation" } }];
    expectError(() => decodeAnimatedGlb(glb(outside.document, outside.bin)), "invalid", "outside the selected scene");

    const matrix = fixture();
    (matrix.document.nodes as JsonObject[])[0] = { matrix: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], children: [1] };
    expectError(() => decodeAnimatedGlb(glb(matrix.document, matrix.bin)), "invalid", "defined by matrix");

    const weights = fixture();
    ((weights.document.animations as JsonObject[])[0]!.channels as JsonObject[])[0]!.target = { node: 0, path: "weights" };
    expectError(() => decodeAnimatedGlb(glb(weights.document, weights.bin)), "unsupported", "morph target weight");

    const duplicate = fixture();
    const channels = (duplicate.document.animations as JsonObject[])[0]!.channels as JsonObject[];
    channels.push({ sampler: 0, target: { node: 0, path: "translation" } });
    expectError(() => decodeAnimatedGlb(glb(duplicate.document, duplicate.bin)), "invalid", "duplicate channel");
  });

  it("strictly validates accessor type, count, alignment, target, time, and quaternion values", () => {
    const cases: Array<readonly [string, (source: Fixture) => void, string]> = [
      ["component", ({ document }) => { (document.accessors as JsonObject[])[0]!.componentType = 5123; }, "FLOAT SCALAR"],
      ["type", ({ document }) => { (document.accessors as JsonObject[])[1]!.type = "VEC4"; }, "FLOAT VEC3"],
      ["count", ({ document }) => { (document.accessors as JsonObject[])[1]!.count = 1; }, "counts do not match"],
      ["alignment", ({ document }) => { (document.accessors as JsonObject[])[0]!.byteOffset = 2; }, "alignment"],
      ["target", ({ document }) => { (document.bufferViews as JsonObject[])[0]!.target = 34962; }, "cannot declare"],
      ["time", ({ bin }) => { new DataView(bin.buffer).setFloat32(4, 0, true); }, "strictly increasing"],
      ["quaternion", ({ bin, offsets }) => { new DataView(bin.buffer).setFloat32(offsets.rotation + 16, 2, true); }, "normalized quaternion"],
    ];
    for (const [, mutate, message] of cases) {
      const source = fixture(); mutate(source);
      expectError(() => decodeAnimatedGlb(glb(source.document, source.bin)), "invalid", message);
    }
  });

  it("enforces importer budgets and rejects unused samplers or ambiguous mapped ids", () => {
    const channels = fixture();
    expectError(() => decodeAnimatedGlb(channels.bytes, { maxChannelsPerAnimation: 2 }), "limit", "channels");
    const bytes = fixture();
    expectError(() => decodeAnimatedGlb(bytes.bytes, { maxDecodedBytes: 4 }), "limit", "decodedBytes");
    const unused = fixture();
    const animation = (unused.document.animations as JsonObject[])[0]!;
    (animation.samplers as JsonObject[]).push({ input: 0, output: 1 });
    expectError(() => decodeAnimatedGlb(glb(unused.document, unused.bin)), "invalid", "unused sampler");
    const mapped = fixture();
    expectError(() => decodeAnimatedGlb(mapped.bytes, { mapNodeId: () => "same" }), "invalid", "must be unique");
  });

  it("explicitly rejects external buffers and malformed node animation features", () => {
    const external = glb({ asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "motion.bin" }], nodes: [], scenes: [{}] });
    expectError(() => decodeAnimatedGlb(external), "unsupported", "external GLB buffers");
    const morph = fixture();
    (morph.document.nodes as JsonObject[])[0]!.weights = [0];
    expectError(() => decodeAnimatedGlb(glb(morph.document, morph.bin)), "unsupported", "morph weights");
  });
});

interface Fixture { document: JsonObject; bin: Uint8Array; bytes: Uint8Array; offsets: { rotation: number } }

function fixture(): Fixture {
  const chunks = [
    floats([0, 1]),
    floats([0, 0, 0, 10, 0, 0]),
    floats([0, 0, 0, 1, 0, 1, 0, 0]),
    floats([0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0]),
  ];
  const offsets: number[] = [], total = chunks.reduce((sum, bytes) => { offsets.push(sum); return sum + bytes.length; }, 0);
  const bin = new Uint8Array(total);
  chunks.forEach((bytes, index) => bin.set(bytes, offsets[index]));
  const document: JsonObject = {
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: chunks.map((bytes, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: bytes.length })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 6, type: "VEC3" },
    ],
    nodes: [{ name: "Root", children: [1] }, { name: "Arm", translation: [1, 0, 0] }], scenes: [{ nodes: [0] }], scene: 0,
    animations: [{ name: "Action", samplers: [
      { input: 0, output: 1, interpolation: "LINEAR" },
      { input: 0, output: 2, interpolation: "STEP" },
      { input: 0, output: 3, interpolation: "CUBICSPLINE" },
    ], channels: [
      { sampler: 0, target: { node: 0, path: "translation" } },
      { sampler: 1, target: { node: 1, path: "rotation" } },
      { sampler: 2, target: { node: 1, path: "scale" } },
    ] }],
  };
  return { document, bin, bytes: glb(document, bin), offsets: { rotation: offsets[2]! } };
}

function floats(values: readonly number[]): Uint8Array { return new Uint8Array(new Float32Array(values).buffer); }
function glb(document: JsonObject, bin?: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = (encoded.length + 3) & ~3, binLength = bin ? (bin.length + 3) & ~3 : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0), output = new Uint8Array(total), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + jsonLength); output.set(encoded, 20);
  if (bin) { const cursor = 20 + jsonLength; view.setUint32(cursor, binLength, true); view.setUint32(cursor + 4, 0x004e4942, true); output.set(bin, cursor + 8); }
  return output;
}
function expectError(run: () => unknown, code: string, message: string): void {
  try { run(); throw new Error("Expected glTF animation import to fail."); }
  catch (error) { expect(error).toBeInstanceOf(GltfImportError); expect((error as GltfImportError).code).toBe(code); expect((error as Error).message).toContain(message); }
}
