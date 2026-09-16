import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GltfRenderAnimationBridge } from "./renderAnimationBridge.js";
import { decodeAnimatedMorphSkinnedGlb } from "./decodeAnimatedMorphSkinnedGlb.js";
import { decodeSkinnedGlb } from "./decodeSkinnedGlb.js";
import { decodeRuntimeGlb, decodeRuntimeGltf } from "./decodeRuntimeGlb.js";
import { RuntimeDecodeTelemetryWindow, type RuntimeDecodeTelemetrySample } from "./runtimeDecodeTelemetry.js";
import { decodeTexturedGlb } from "./decodeTexturedGlb.js";
import { parseGlb } from "./parseGlb.js";
import { GltfImportError, type JsonObject } from "./validation.js";

describe("decodeAnimatedMorphSkinnedGlb", () => {
  it("decodes one shared character identity space and feeds the render animation bridge", () => {
    const source = fixture(); let mappings = 0;
    const decoded = decodeAnimatedMorphSkinnedGlb(source.bytes, {
      mapNodeId: (index) => { mappings += 1; return `node:${index}`; },
      animation: { clipPrefix: "motion" }, morph: { clipPrefix: "shape", resourcePrefix: "character" },
      skinning: { resourcePrefix: "character" },
    });
    expect(mappings).toBe(4);
    expect(decoded.animation.clips[0]).toMatchObject({ id: "motion/animation/0", tracks: [{ nodeId: "node:1" }] });
    expect(decoded.morph.morphClips[0]).toMatchObject({ id: "shape/morph-animation/0", tracks: [{ nodeId: "node:3" }] });
    expect(decoded.skinning.bindings[0]).toMatchObject({ nodeId: "node:3", primitiveIds: ["character/mesh/0/primitive/0"] });
    expect(decoded.morph.bindings[0]).toMatchObject({ nodeId: "node:3", primitiveIds: ["character/mesh/0/primitive/0"] });
    expect(decoded.decodedBytes).toBe(decoded.animation.decodedBytes + decoded.morph.decodedBytes + decoded.skinning.decodedBytes);

    const bridge = new GltfRenderAnimationBridge({ animation: decoded.animation, morph: decoded.morph, skinning: decoded.skinning }, {
      selection: { transformClipId: "motion/animation/0", morphClipId: "shape/morph-animation/0", wrapMode: "clamp" },
    });
    const frame = bridge.seek(0.5);
    expect(frame.skinPalettes).toHaveLength(1);
    expect(frame.morphWeights).toHaveLength(1);
    expect(frame.morphWeights[0]!.weights.values[0]).toBeCloseTo(0.5);
    expect(frame.morphSkinning).toMatchObject([{ primitiveId: "character/mesh/0/primitive/0" }]);
  });

  it("keeps standalone skin import strict and enforces one aggregate output budget", () => {
    const source = fixture(), decoded = decodeAnimatedMorphSkinnedGlb(source.bytes);
    expect(() => decodeSkinnedGlb(source.bytes)).toThrow(expect.objectContaining({
      code: "unsupported", feature: "morph weights",
    }));
    expect(() => decodeAnimatedMorphSkinnedGlb(source.bytes, { maxDecodedBytes: decoded.decodedBytes - 1 }))
      .toThrow(expect.objectContaining({ code: "limit" }));
    expect(() => decodeAnimatedMorphSkinnedGlb(source.bytes, { maxDecodedBytes: 0 }))
      .toThrow(expect.objectContaining({ code: "invalid", path: "options.maxDecodedBytes" }));
  });

  it("cancels before parse and between shared-node selection and accessor expansion", () => {
    const source = fixture(), before = new AbortController(); before.abort(new Error("cancel-before"));
    expect(() => decodeAnimatedMorphSkinnedGlb(source.bytes, { signal: before.signal })).toThrow("cancel-before");
    const during = new AbortController();
    expect(() => decodeAnimatedMorphSkinnedGlb(source.bytes, {
      signal: during.signal,
      mapNodeId: (index) => { if (index === 0) during.abort(new Error("cancel-during")); return index; },
    })).toThrow("cancel-during");
    expect(() => decodeAnimatedMorphSkinnedGlb(source.bytes, { signal: {} as never }))
      .toThrow(expect.objectContaining({ code: "invalid", path: "options.signal" }));
  });

  it("publishes one runtime packet with matching transform, morph, and skin resource identities", async () => {
    const source = fixture();
    const decoded = await decodeRuntimeGlb(source.bytes, undefined, { resourcePrefix: "character" });
    expect(decoded.packet).toMatchObject({
      geometries: [{ id: "character/mesh/0/primitive/0" }],
      instances: [{ geometry: "character/mesh/0/primitive/0" }],
      textures: [],
    });
    expect(decoded.morph.primitives[0]!.id).toBe(decoded.packet.geometries[0]!.id);
    expect(decoded.skinning.primitives[0]!.id).toBe(decoded.packet.geometries[0]!.id);
    expect(decoded.instanceProjection.bindings).toEqual([{
      nodeId: 3, id: "character/node/3/primitive/0", geometry: "character/mesh/0/primitive/0",
      material: "character/material/default",
    }]);
    const bridge = new GltfRenderAnimationBridge(decoded, { instances: decoded.instanceProjection,
      selection: { transformClipId: "gltf/animation/0", morphClipId: "gltf/morph-animation/0" } });
    expect(bridge.update(0.5).instanceUpdate?.instances[0]!.id).toBe("character/node/3/primitive/0");
    const parsed = parseGlb(source.bytes);
    const fromDocument = await decodeRuntimeGltf(parsed.json, parsed.buffers, undefined, { resourcePrefix: "document" });
    expect(fromDocument.packet.instances[0]!.id).toBe("document/node/3/primitive/0");
    expect(fromDocument.skinning.primitives[0]!.weights.buffer).not.toBe(source.bytes.buffer);
    await expect(decodeTexturedGlb(source.bytes, undefined)).rejects.toMatchObject({ code: "unsupported" });
    await expect(decodeRuntimeGlb(source.bytes, undefined, {
      resourcePrefix: "character", morph: { resourcePrefix: "other" },
    })).rejects.toMatchObject({ code: "invalid", path: "options.morph.resourcePrefix" });
  });

  it("imports the fixed textured GLB through the same runtime entry with empty deformation sources", async () => {
    const bytes = readFileSync(new URL("../../lab/assets/BoxTextured.glb", import.meta.url));
    const samples: RuntimeDecodeTelemetrySample[] = []; let time = 0;
    const imageDecoder = { decode: vi.fn(async () => ({
      width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]),
    })) };
    const decoded = await decodeRuntimeGlb(bytes, imageDecoder, { resourcePrefix: "box", telemetry: {
      clock: { now: () => ++time }, recorder: { record: sample => samples.push(sample) },
    } });
    expect(decoded.packet).toMatchObject({ geometries: [{ id: "box/mesh/0/primitive/0" }] });
    expect(decoded.packet.textures).toHaveLength(1);
    expect(imageDecoder.decode).toHaveBeenCalledOnce();
    expect(samples[0]).toMatchObject({ outcome: "success" });
    expect(samples[0]!.stagesMs.texturedImageDecode).toBeGreaterThan(0);
    expect(samples[0]!.decodedBytes).toBeGreaterThan(decoded.decodedBytes + 4);
    expect(decoded.animation.clips).toEqual([]);
    expect(decoded.morph.primitives).toEqual([]);
    expect(decoded.skinning.skins).toEqual([]);
  });

  it("records real unified decode stages only when explicit telemetry hooks are supplied", async () => {
    const source = fixture(), clock = { now: vi.fn() }; let time = 0;
    clock.now.mockImplementation(() => ++time);
    const baseline = await decodeRuntimeGlb(source.bytes, undefined, { resourcePrefix: "measured" });
    expect(clock.now).not.toHaveBeenCalled();

    const window = new RuntimeDecodeTelemetryWindow(4), telemetry = { clock, recorder: window };
    const decoded = await decodeRuntimeGlb(source.bytes, undefined, { resourcePrefix: "measured", telemetry });
    expect(decoded).toEqual(baseline);
    const parsed = parseGlb(source.bytes);
    await decodeRuntimeGltf(parsed.json, parsed.buffers, undefined, { resourcePrefix: "warm", telemetry });
    const snapshot = window.snapshot(), cold = snapshot.coldFirst!;
    const geometryBytes = decoded.packet.geometries.reduce((sum, geometry) => sum + geometry.vertices.byteLength
      + geometry.indices.byteLength + (geometry.uv0?.byteLength ?? 0) + (geometry.uv1?.byteLength ?? 0)
      + (geometry.tangents?.byteLength ?? 0), 0);
    expect(cold).toMatchObject({ invocation: "glb", outcome: "success",
      decodedBytes: decoded.decodedBytes + geometryBytes });
    expect(Object.values(cold.stagesMs).every(value => value !== null && value > 0)).toBe(true);
    expect(snapshot).toMatchObject({ totalSamples: 2, retainedSamples: 2,
      outcomes: { success: 2, aborted: 0, failure: 0 }, warm: { successfulSamples: 1 } });
    expect(snapshot.warm.stagesMs.total).toEqual({ p50: 9, p95: 9, p99: 9 });
  });

  it("diagnoses parse failures and pre-start cancellation without DOM globals", async () => {
    const samples: RuntimeDecodeTelemetrySample[] = []; let time = 0;
    const telemetry = { clock: { now: () => ++time }, recorder: { record: (sample: RuntimeDecodeTelemetrySample) => samples.push(sample) } };
    await expect(decodeRuntimeGlb(new Uint8Array(), undefined, { telemetry })).rejects.toBeInstanceOf(Error);
    expect(samples[0]).toMatchObject({ invocation: "glb", outcome: "failure", decodedBytes: 0,
      stagesMs: { deformation: null, texturedImageDecode: null, projection: null } });
    expect(samples[0]!.stagesMs.parse).toBeGreaterThan(0);
    const controller = new AbortController(); const reason = new Error("cancelled"); reason.name = "AbortError";
    controller.abort(reason);
    await expect(decodeRuntimeGltf({}, [], undefined, { signal: controller.signal, telemetry })).rejects.toBe(reason);
    expect(samples[1]).toMatchObject({ invocation: "gltf", outcome: "aborted", decodedBytes: 0,
      stagesMs: { parse: null, deformation: null, texturedImageDecode: null, projection: null } });
    expect(samples[1]!.stagesMs.total).toBeGreaterThan(0);
  });
});

function fixture(): { bytes: Uint8Array } {
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
  return { bytes: glb(document, bin) };
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
