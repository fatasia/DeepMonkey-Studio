import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRuntimePackage } from "../delivery/compileSceneRuntimePackage";
import { StudioWasmTransformCache } from "./StudioWasmTransformCache";

const glb = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
const options = { binaryTransport: true, packageId: "test.transforms", packageVersion: "1.0.0", loadModel: async () => glb };
function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "scene", projectId: "project", name: "test", createdAt: "", updatedAt: "", primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1_000_004, y: 3, z: 4 }, target: { x: 1_000_000, y: 0, z: 0 } },
    models: [{ modelId: "instance", assetModelId: "asset", name: "Box", visible: true, opacity: 1,
      transform: { position: { x: 1_000_001, y: 2, z: 0 }, rotation: { x: 0.2, y: 0.1, z: 0.3 }, scale: { x: 1, y: 2, z: 1 } } }] };
}
function unpack(bytes: Uint8Array) {
  const offset = 12 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  return { header: JSON.parse(new TextDecoder().decode(bytes.subarray(12, offset))), body: bytes.slice(offset) };
}

describe("compressed WASM transform baseline", () => {
  it("matches full compilation under rotation, scaling and large coordinates without rewriting resource planes", async () => {
    const before = scene(), full = await compileSceneRuntimePackage(before, options), original = unpack(full.packageBytes);
    const cache = new StudioWasmTransformCache(); cache.remember(before, [], { bytes: full.packageBytes });
    const after = structuredClone(before);
    after.models[0]!.transform = { position: { x: 1_000_020, y: 7, z: -8 }, rotation: { x: 0.5, y: -0.7, z: 1.2 }, scale: { x: 2, y: 1, z: 0.5 } };
    const patched = await cache.compile(after, [], new AbortController().signal);
    expect(patched).toBeDefined();
    const actual = unpack(patched!.bytes), expected = unpack((await compileSceneRuntimePackage(after, options)).packageBytes);
    expect(actual.body).toEqual(original.body);
    const envelope = actual.header.envelope, renderId = envelope.entrypoints.renderPacket;
    const instances = envelope.payloads[renderId].instances, wanted = expected.header.envelope.payloads[renderId].instances;
    for (let index = 0; index < instances.length; index++) for (let axis = 0; axis < 16; axis++) {
      expect(instances[index].transform[axis]).toBeCloseTo(wanted[index].transform[axis], 5);
    }
    expect(envelope.resources.find((entry: { id: string }) => entry.id === renderId).contentHash.value)
      .toBe(runtimeContentSha256({ metadata: envelope.payloads[renderId], sections: actual.header.sections }));
    const { packageHash, ...core } = envelope; expect(packageHash.value).toBe(runtimeContentSha256(core));
    // Caller mutation and repeated updates cannot alter the owned original baseline.
    full.packageBytes.fill(0); before.models[0]!.transform.position.x = 0;
    expect((await cache.compile(after, [], new AbortController().signal))!.bytes).toEqual(patched!.bytes);
    cache.clear(); expect(await cache.compile(after, [], new AbortController().signal)).toBeUndefined();
  });

  it("falls back for appearance, asset or scene changes, and propagates cancellation", async () => {
    const before = scene(), full = await compileSceneRuntimePackage(before, options);
    const cache = new StudioWasmTransformCache(); cache.remember(before, [], { bytes: full.packageBytes });
    const appearance = structuredClone(before); appearance.models[0]!.opacity = 0.5;
    expect(await cache.compile(appearance, [], new AbortController().signal)).toBeUndefined();
    const asset = structuredClone(before); asset.models[0]!.assetModelId = "new-asset";
    expect(await cache.compile(asset, [], new AbortController().signal)).toBeUndefined();
    expect(await cache.compile({ ...before, id: "other" }, [], new AbortController().signal)).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    await expect(cache.compile(before, [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
