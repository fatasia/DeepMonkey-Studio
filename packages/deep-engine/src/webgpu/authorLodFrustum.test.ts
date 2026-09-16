import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorFixture, authorPacket, authorView } from "./authorLod.testUtils.js";
beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("author LOD GPU frustum inputs", () => {
  it.each([false, true])("closes a failed compute pass and retains the trigger when cleanup fails=%s", cleanupFails => {
    const f = authorFixture(); f.cache.set(authorPacket([0]));
    const trigger = Error("dispatch failed"), cleanup = Error("end failed");
    const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() { throw trigger; },
      end: vi.fn(() => { if (cleanupFails) throw cleanup; }) };
    const encoder = { beginComputePass: () => pass } as unknown as GPUCommandEncoder;
    let failure: unknown;
    try { f.cache.encodeLod(encoder, authorView); } catch (error) { failure = error; }
    expect(pass.end).toHaveBeenCalledTimes(1);
    if (cleanupFails) expect((failure as AggregateError).errors[0]).toBe(trigger); else expect(failure).toBe(trigger);
    expect(() => f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toThrow("not encoded");
    const raw = f.device.createBuffer.mock.results.map(result => result.value as { label: string; destroy: ReturnType<typeof vi.fn> });
    for (const buffer of raw.filter(buffer => buffer.label.startsWith("Deep culling"))) expect(buffer.destroy).toHaveBeenCalledTimes(1);
    f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("uploads each actual geometry's bounds and never substitutes level zero", () => {
    const f = authorFixture(), packet = authorPacket([0, 1]);
    for (let index = 0; index < packet.geometries[1]!.vertices.length; index += 6) packet.geometries[1]!.vertices[index]! += 20;
    f.cache.set(packet); f.cache.encodeLod(f.encoder, authorView);
    const bounds = f.writes.filter(write => write.label === "Deep culling bounds").map(write => [...new Float32Array(write.bytes)]);
    expect(bounds).toHaveLength(2); expect(bounds[1]![0]! - bounds[0]![0]!).toBeCloseTo(20);
    expect(bounds[1]!.slice(1)).toEqual(bounds[0]!.slice(1));
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(2);
    f.cache.cancelLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("dispatches shared geometry once while retaining both author draws", () => {
    const f = authorFixture(), packet = authorPacket([0, 1]), instance = packet.instances[0]!;
    f.cache.set({ ...packet, instances: [{ ...instance, lod: { strategy: "author-selected", revision: 1, selectedLevels: [0, 1],
      levels: [{ geometry: "high", distance: 0, hysteresis: 0 }, { geometry: "high", distance: 10, hysteresis: 0 }] } }] });
    const stats = f.cache.encodeLod(f.encoder, authorView); expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ authorFrustumPasses: 1, authorFrustumDispatches: 2 });
    expect(f.writes.filter(write => write.label === "Deep culling input")).toHaveLength(1);
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toEqual({ drawCalls: 2, triangles: 4 });
    f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("isolates transformed candidate inputs and previous identity across cancellation", () => {
    const f = authorFixture(), packet = authorPacket([0]); f.cache.set(packet);
    f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame(); const owned = f.owned.size, start = f.writes.length;
    const instance = packet.instances[0]!, transform = [...instance.transform]; transform[12] = 8;
    f.cache.updateInstances({ materials: packet.materials, instances: [{ ...instance, transform }] });
    f.cache.encodeLod(f.encoder, authorView);
    const writes = f.writes.slice(start), current = writes.filter(write => write.label === "Deep culling input"), previous = writes.filter(write => write.label === "Deep culling previous transforms");
    expect(current).toHaveLength(2); expect(previous).toHaveLength(2);
    for (const write of current) expect(new Float32Array(write.bytes)[3]).toBe(8);
    for (const write of previous) expect(new Float32Array(write.bytes)[3]).toBe(0);
    f.cache.cancelLodFrame(); expect(f.owned.size).toBe(owned);
    expect(() => f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque")).toThrow("not encoded");
    f.cache.encodeLod(f.encoder, authorView); f.cache.commitLodFrame(); expect(f.owned.size).toBe(owned);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
});
