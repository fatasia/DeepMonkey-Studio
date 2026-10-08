import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decodeDeformablePacketGlb, GltfImportError } from "@bim-studio/deep-engine/gltf";
import { createAuthorModelWorkerDecoder, type AuthorModelWorkerHost, type AuthorModelWorkerReply,
  type AuthorModelWorkerRequest } from "./authorModelWorkerClient";
import { decodeAuthorModel, isAuthorModelNormalizationFailure, markAuthorModelNormalizationFailure,
  type AuthorModelDecodeOptions, type AuthorModelDecoder } from "./authorModelDecode";
import { authorModelTransferBuffers, copyAuthorModelBytes } from "./authorModelTransfer";
import { compileSceneRenderPacket } from "./compileSceneRenderPacket";
import type { SceneSnapshot } from "@bim-studio/contracts";

const bytes = new Uint8Array(readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url)));
const options: AuthorModelDecodeOptions = { resourcePrefix: "asset", modelId: "one", maxDecodedBytes: 128 * 1024 * 1024,
  liveDeformation: true, preserveTexCoords: true, textureBudgetBytes: 112 * 1024 * 1024 };
class FakeWorker implements AuthorModelWorkerHost {
  onmessage: AuthorModelWorkerHost["onmessage"] = null;
  onerror: AuthorModelWorkerHost["onerror"] = null;
  onmessageerror: AuthorModelWorkerHost["onmessageerror"] = null;
  terminate = vi.fn();
  sent: AuthorModelWorkerRequest[] = [];
  postMessage(request: AuthorModelWorkerRequest, transfer: ArrayBuffer[]) { this.sent.push(structuredClone(request, { transfer })); }
  reply(reply: AuthorModelWorkerReply) { this.onmessage?.({ data: structuredClone(reply, { transfer: authorModelTransferBuffers(reply) }) }); }
}
const decoder = { decode: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) })) };
const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "project", name: "test", createdAt: "", updatedAt: "",
  camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } }, primitives: [], measurements: [],
  models: ["one", "two"].map(modelId => ({ modelId, assetModelId: "asset", name: modelId, visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } })) };

describe("author asset worker", () => {
  it("preserves original GLB ownership, decode options and exact transferred resources", async () => {
    const worker = new FakeWorker(), decode = createAuthorModelWorkerDecoder(() => worker);
    const source = bytes.slice(), pending = decode(source, options, new AbortController().signal);
    await Promise.resolve();
    expect(source.byteLength).toBe(bytes.byteLength); expect(source).toEqual(bytes);
    expect(worker.sent[0]!.options).toEqual(options);
    const decoded = await decodeDeformablePacketGlb(bytes, undefined, { resourcePrefix: "asset", preserveTexCoords: true });
    const expected = structuredClone(decoded);
    worker.reply({ id: worker.sent[0]!.id, result: { normalizedBytes: bytes.slice(), decoded } });
    expect((await pending).decoded).toEqual(expected);
  });

  it("restores GltfImportError identity, fields and unchanged message across realms", async () => {
    const worker = new FakeWorker(), decode = createAuthorModelWorkerDecoder(() => worker);
    const pending = decode(bytes, options, new AbortController().signal); await Promise.resolve();
    const expected = new GltfImportError("unsupported", "meshes[0]", "Unsupported feature.", "vendor");
    const rejected = expect(pending).rejects.toMatchObject({ name: expected.name, message: expected.message,
      code: "unsupported", path: "meshes[0]", feature: "vendor" });
    worker.reply({ id: worker.sent[0]!.id, error: { message: expected.message,
      gltf: { code: expected.code, path: expected.path, feature: expected.feature! } } });
    await rejected;
    await expect(pending).rejects.toBeInstanceOf(GltfImportError);
  });

  it("terminates cancelled work and rejects stale output before a fresh worker is used", async () => {
    const workers = [new FakeWorker(), new FakeWorker()]; let cursor = 0;
    const decode = createAuthorModelWorkerDecoder(() => workers[cursor++]!);
    const controller = new AbortController(), pending = decode(bytes, options, controller.signal); await Promise.resolve();
    const reason = new Error("superseded"), rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason); await rejected; expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const next = decode(bytes, options, new AbortController().signal); await Promise.resolve();
    workers[0]!.reply({ id: 1, error: { message: "stale" } });
    const decoded = await decodeDeformablePacketGlb(bytes, undefined);
    workers[1]!.reply({ id: workers[1]!.sent[0]!.id, result: { normalizedBytes: bytes.slice(), decoded } });
    expect((await next).decoded.mode).toBe("static");
  });

  it("retains the fatal normalization phase on reconstructed glTF errors", async () => {
    const worker = new FakeWorker(), decode = createAuthorModelWorkerDecoder(() => worker);
    const pending = decode(bytes, options, new AbortController().signal); await Promise.resolve();
    const error = pending.catch(reason => reason);
    worker.reply({ id: worker.sent[0]!.id, error: { message: "glb: malformed header", normalization: true,
      gltf: { code: "invalid", path: "glb" } } });
    const received = await error;
    expect(received).toBeInstanceOf(GltfImportError); expect(isAuthorModelNormalizationFailure(received)).toBe(true);
  });

  it("deduplicates backing stores and preserves typed-array aliases through transfer", () => {
    const store = new ArrayBuffer(64), first = new Float32Array(store, 0, 4), second = new Uint8Array(store, 8, 12);
    first[2] = 1.25;
    const value = { first, nested: { second, again: first } }, transfers = authorModelTransferBuffers(value);
    expect(transfers).toEqual([store]);
    const received = structuredClone(value, { transfer: transfers });
    expect(received.first.buffer).toBe(received.nested.second.buffer);
    expect(received.first).toBe(received.nested.again); expect(received.first[2]).toBe(1.25); expect(store.byteLength).toBe(0);
  });

  it("stops a chunked input copy at cancellation without detaching source", async () => {
    const source = new Uint8Array(9 * 1024 * 1024), controller = new AbortController();
    const pending = copyAuthorModelBytes(source, controller.signal), reason = new Error("cancel copy");
    const rejected = expect(pending).rejects.toBe(reason); controller.abort(reason); await rejected;
    expect(source.byteLength).toBe(9 * 1024 * 1024);
  });

  it("checks normalized byte budget before decoding and preserves normalization failure classification", async () => {
    await expect(decodeAuthorModel(bytes, { ...options, maxDecodedBytes: 1 }, new AbortController().signal,
      async source => source, decoder)).rejects.toThrow("对象 one 的解压模型超过场景预算");
    expect(decoder.decode).not.toHaveBeenCalled();
    const failure = new GltfImportError("invalid", "glb", "bad header");
    await expect(decodeAuthorModel(bytes, options, new AbortController().signal,
      async () => { throw failure; }, decoder)).rejects.toBe(failure);
    expect(isAuthorModelNormalizationFailure(failure)).toBe(true);
  });

  it("compiles shared assets only once and retains default compiler packet semantics", async () => {
    const expected = await compileSceneRenderPacket(scene, { loadModel: async () => bytes });
    const decodeModel = vi.fn(async (...[source, settings, signal]: Parameters<AuthorModelDecoder>) =>
      decodeAuthorModel(source, settings, signal, async value => value, decoder));
    const actual = await compileSceneRenderPacket(scene, { loadModel: async () => bytes, decodeModel,
      normalizeModel: async () => { throw new Error("main normalization must be skipped"); } });
    expect(actual).toEqual(expected); expect(decodeModel).toHaveBeenCalledOnce();
  });

  it("keeps normalization failures fatal instead of silently hiding a model", async () => {
    const failure = new GltfImportError("invalid", "glb", "bad header"); markAuthorModelNormalizationFailure(failure);
    await expect(compileSceneRenderPacket(scene, { loadModel: async () => bytes, skipUndecodableModels: true,
      decodeModel: async () => { throw failure; } })).rejects.toBe(failure);
  });
});
