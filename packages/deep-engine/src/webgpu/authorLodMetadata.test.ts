import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorFixture, authorPacket, authorView } from "./authorLod.testUtils.js";
beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("author LOD incremental metadata transaction", () => {
  it("advances a revision-only update once and rejects revision rollback without writes", () => {
    const f = authorFixture(); f.cache.set(authorPacket([0], 3));
    const writes = f.writes.length, revision = f.cache.visibilityRevision;
    const next = authorPacket([0], 4), stale = authorPacket([0], 2);
    expect(f.cache.updateInstances({ materials: next.materials, instances: next.instances })).toBe(true);
    expect(f.cache.visibilityRevision).toBe(revision + 1);
    expect(f.cache.updateInstances({ materials: next.materials, instances: next.instances })).toBe(false);
    expect(() => f.cache.updateInstances({ materials: stale.materials, instances: stale.instances })).toThrow("newer revision");
    expect(f.writes).toHaveLength(writes); expect(f.cache.visibilityRevision).toBe(revision + 1);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });

  it("does not publish one object's metadata when another object's upload fails", () => {
    const f = authorFixture(), initial = authorPacket([0]);
    const other = { ...initial.instances[0]!, id: "other" };
    f.cache.set({ ...initial, instances: [...initial.instances, other] });
    f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame();
    const revision = f.cache.visibilityRevision, next = authorPacket([1], 2);
    const moved = { ...other, transform: [...other.transform] }; moved.transform[12] = 5;
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw Error("injected upload failure"); });
    const update = { materials: next.materials, instances: [...next.instances, moved] };
    expect(() => f.cache.updateInstances(update)).toThrow("injected upload failure");
    expect(f.cache.visibilityRevision).toBe(revision);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(4);
    expect(f.cache.updateInstances(update)).toBe(true);
    f.cache.encodeLod(f.encoder, authorView);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(3);
    f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });

  it("changes selection without uploading geometry or batch instances, and advances visibility", () => {
    const f = authorFixture(); f.cache.set(authorPacket([0])); f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame();
    const oldRevision = f.cache.visibilityRevision, writes = f.writes.length, allocations = f.device.createBuffer.mock.calls.length;
    const next = authorPacket([1], 2);
    expect(f.cache.updateInstances({ materials: next.materials, instances: next.instances })).toBe(true);
    expect(f.cache.visibilityRevision).toBe(oldRevision + 1); expect(f.writes).toHaveLength(writes); expect(f.device.createBuffer).toHaveBeenCalledTimes(allocations);
    f.cache.encodeLod(f.encoder, authorView);
    expect(f.writes.slice(writes).map(write => write.label)).toEqual(["Deep culling frustum", "Deep culling counter", "Deep culling indirect arguments"]);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(1);
    f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("full validated metadata update also reuses instance and geometry buffers", async () => {
    const f = authorFixture(); await f.cache.setValidated(authorPacket([0])); const revision = f.cache.visibilityRevision, writes = f.writes.length;
    await f.cache.setValidated(authorPacket([], 2)); expect(f.writes).toHaveLength(writes); expect(f.cache.visibilityRevision).toBe(revision + 1);
    f.cache.encodeLod(f.encoder, authorView); expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toEqual({ drawCalls: 0, triangles: 0 });
    f.cache.commitLodFrame(); f.cache.dispose();
  });
  it("same revision selection changes reject before writes and leave the old selection drawable", () => {
    const f = authorFixture(); f.cache.set(authorPacket([0])); f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame();
    const writes = f.writes.length, revision = f.cache.visibilityRevision, invalid = authorPacket([1]);
    expect(() => f.cache.updateInstances({ materials: invalid.materials, instances: invalid.instances })).toThrow("newer revision");
    expect(f.writes).toHaveLength(writes); expect(f.cache.visibilityRevision).toBe(revision);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(2); f.cache.dispose();
  });
  it.each(["cancel", "validation"])("does not publish candidate selection on %s failure", async mode => {
    const f = authorFixture(); await f.cache.setValidated(authorPacket([0]));
    f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame(); const revision = f.cache.visibilityRevision;
    let finish!: (error: GPUError | null) => void;
    f.device.popErrorScope.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.cache.setValidated(authorPacket([1], 2)); const rejected = expect(pending).rejects.toThrow();
    if (mode === "cancel") { f.cache.cancelPendingPacketStage(); finish(null); }
    else finish({ message: "GPU rejected" } as GPUError);
    await rejected; expect(f.cache.visibilityRevision).toBe(revision);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(2);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
});
