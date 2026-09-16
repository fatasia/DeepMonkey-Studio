import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meshletFixture, meshletPacket } from "./packetMeshlet.testUtils.js";
import { authorView } from "./authorLod.testUtils.js";
beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("formal packet meshlet consumer", () => {
  it("builds in the validated stage, draws expanded indirect ranges, and reuses unchanged views", async () => {
    const f = meshletFixture(); await f.cache.setValidated(meshletPacket());
    expect(f.writes.filter(write => write.label === "Deep packet meshlet descriptors")).toHaveLength(1);
    const uploads = f.writes.length, stats = f.cache.encodeLod(f.encoder, authorView);
    expect(stats).toMatchObject({ meshletPasses: 2, meshletDispatches: 5 });
    expect(f.writes.slice(uploads).some(write => write.label === "Deep packet meshlet descriptors")).toBe(false);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toEqual({ drawCalls: 64, triangles: 1344 });
    expect(f.pass.drawIndexedIndirect).toHaveBeenCalledTimes(64);
    expect(f.pass.setIndexBuffer.mock.calls.at(-1)![0].label).toBe("Deep meshlet preserve indices");
    f.cache.commitLodFrame();
    expect(f.cache.encodeLod(f.encoder, authorView).meshletPasses ?? 0).toBe(0);
    f.cache.cancelLodFrame(); f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame();
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("keeps a complete fallback draw when the per-view task budget is exceeded", () => {
    const f = meshletFixture(), packet = meshletPacket(), instance = packet.instances[0]!;
    f.cache.set({ ...packet, instances: Array.from({ length: 33 }, (_, index) => ({ ...instance, id: `author-${index}` })) });
    const stats = f.cache.encodeLod(f.encoder, authorView);
    expect(stats.meshletFallbackReasons).toContain("view-capacity");
    expect(stats.authorFrustumPasses).toBe(1);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque").triangles).toBe(33 * 1344);
    f.cache.cancelLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("rolls back all static meshlet buffers on candidate cancellation", async () => {
    const f = meshletFixture(); let finish!: (value: GPUError | null) => void;
    f.device.popErrorScope.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.cache.setValidated(meshletPacket()); const rejected = expect(pending).rejects.toThrow();
    f.cache.cancelPendingPacketStage(); finish(null); await rejected;
    expect(f.owned.size).toBe(0); f.cache.dispose();
  });
});
