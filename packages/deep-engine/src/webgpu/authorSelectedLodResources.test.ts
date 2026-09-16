import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import { authorFixture, authorPacket, authorView } from "./authorLod.testUtils.js";
import { snapshotPreparedLod } from "./snapshotPreparedLod.js";
import { AuthorSelectedLodResources } from "./authorSelectedLodResources.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("author-selected LOD consumer", () => {
  it("rejects a selected nonresident geometry before allocation instead of falling back", () => {
    const f = authorFixture(), owner = new AuthorSelectedLodResources(f.session), prepared = prepareRenderPacket(authorPacket([1]));
    const batch = { source: prepared.batches[0]!, buffer: {}, previousBuffer: {} } as CachedPacketBatch;
    const source = prepared.geometries.get("high")!;
    const geometries = new Map([["high", { source, mesh: { indexCount: source.indices.length } } as CachedPacketGeometry]]);
    const allocated = f.device.createBuffer.mock.calls.length;
    expect(() => owner.encode(f.encoder, authorView.frustum, [batch], geometries)).toThrow("not resident: low");
    expect(owner.draws(batch.source.key)).toBeUndefined(); expect(f.device.createBuffer).toHaveBeenCalledTimes(allocated); owner.dispose(); f.cache.dispose();
  });
  it("rolls back failed indirect upload and retries without replacing prior geometry or instances", () => {
    const f = authorFixture(); f.cache.set(authorPacket([0])); f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame();
    const next = authorPacket([1], 2); f.cache.updateInstances({ materials: next.materials, instances: next.instances });
    const owned = f.owned.size; f.device.queue.writeBuffer.mockImplementationOnce(() => { throw Error("indirect upload failed"); });
    expect(() => f.cache.encodeLod(f.encoder, authorView)).toThrow("indirect upload failed"); expect(f.owned.size).toBe(owned);
    f.cache.encodeLod(f.encoder, authorView); expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(1);
    f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it.each([[[]], [[0]], [[1]], [[0, 1]]])("draws exactly selected levels %j in main and all shadow views", selected => {
    const f = authorFixture(); f.cache.set(authorPacket(selected));
    const stats = f.cache.encodeLod(f.encoder, authorView); expect(stats.indirectDraws).toBe(selected.length);
    const triangles = selected.reduce((sum, index) => sum + (index ? 1 : 2), 0);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toEqual({ drawCalls: selected.length, triangles });
    const plan = planCascadedShadows({ eye: [0, 0, 0], target: [0, 0, 1], near: .1, far: 100, verticalFovRadians: Math.PI / 2, aspect: 1 },
      [0, -1, 0], { cascadeCount: 3, shadowMapSize: 64 });
    expect(f.cache.encodeShadowLod(f.encoder, plan).indirectDraws).toBe(selected.length * 3);
    for (let cascade = 0; cascade < 3; cascade++) expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "shadow", undefined, false, cascade))
      .toEqual({ drawCalls: selected.length, triangles });
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(selected.length * 4);
    const args = f.writes.filter(write => write.label === "Deep culling indirect arguments");
    if (!selected.length) expect(args).toHaveLength(0);
    else expect(args.map(write => [...new Uint32Array(write.bytes)])).toEqual(Array.from({ length: 4 }, () => selected.map(index => [index ? 3 : 6, 0, 0, 0, 0])).flat());
    f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("ignores camera and shadow selection heuristics, reusing arguments at unchanged revision", () => {
    const f = authorFixture(); f.cache.set(authorPacket()); f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame();
    const writes = f.writes.length;
    f.cache.encodeLod(f.encoder, { ...authorView, viewport: { width: 1, height: 1 }, cameraJump: true,
      camera: { ...authorView.camera, position: [0, 0, -10000] } });
    expect(f.writes.slice(writes).map(write => write.label)).toEqual(["Deep culling frustum", "Deep culling counter", "Deep culling indirect arguments"]);
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(2);
    f.cache.cancelLodFrame(); expect(() => f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toThrow("not encoded");
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("fails closed on explicit budgets without overwriting previously drawable selection", () => {
    const f = authorFixture(); f.cache.set(authorPacket()); f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame(); const writes = f.writes.length;
    for (const budget of [{ maxObjects: 0 }, { maxTriangles: 1000 }]) expect(() => f.cache.encodeLod(f.encoder, { ...authorView, budget })).toThrow("explicit global budgets");
    expect(f.writes).toHaveLength(writes);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(1); f.cache.dispose();
  });
  it("owns selectedLevels across residency snapshot boundaries", () => {
    const profile = prepareRenderPacket(authorPacket([0, 1])).batches[0]!.lod!, copied = snapshotPreparedLod(profile);
    expect(copied).toEqual(profile); if (copied.strategy !== "author-selected" || profile.strategy !== "author-selected") throw Error("profile");
    expect(copied.selectedLevels).not.toBe(profile.selectedLevels); expect(Object.isFrozen(copied.selectedLevels)).toBe(true);
  });
});
