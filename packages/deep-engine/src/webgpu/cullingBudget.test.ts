import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { authorFixture, authorPacket, authorView } from "./authorLod.testUtils.js";
import { AuthorSelectedLodResources } from "./authorSelectedLodResources.js";
import { DeviceResourceBudgetError, DeviceResourceMemory } from "./deviceResourceMemory.js";
import { createGpuCullingPipelineContext } from "./gpuFrustumCulling.js";
import { PacketCullingResources } from "./packetCulling.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture(budget: number) {
  const f = authorFixture(), memory = new DeviceResourceMemory(budget);
  const own = f.session.own.bind(f.session), release = f.session.release.bind(f.session);
  f.session.assertResourceAdmission = descriptor => memory.assertCanAdd(descriptor);
  f.session.own = resource => { memory.add(resource); return own(resource); };
  f.session.release = resource => { memory.remove(resource); release(resource); };
  return { ...f, memory };
}

describe("production frustum allocation admission", () => {
  it("does not double-destroy registered buffers when the session is released before the context", () => {
    const f = fixture(600), context = createGpuCullingPipelineContext(f.session.device, f.session);
    const inputs = context.createSharedInputs(1); inputs.createPhase();
    const resources = [...f.owned];
    expect(f.memory.snapshot).toMatchObject({ estimatedBytes: 536, resourceCount: 9 });
    for (const resource of resources) f.session.release(resource);
    context.dispose(); inputs.dispose(); context.dispose();
    expect(f.memory.snapshot).toMatchObject({ estimatedBytes: 0, resourceCount: 0 });
    for (const resource of resources) expect(resource.destroy).toHaveBeenCalledOnce();
  });
  it("rolls back partial shared inputs before publication and counts buffers only once", () => {
    const f = fixture(200), context = createGpuCullingPipelineContext(f.session.device, f.session);
    expect(() => context.createSharedInputs(1)).toThrow(DeviceResourceBudgetError);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(2);
    expect(f.memory.snapshot).toMatchObject({ estimatedBytes: 0, peakEstimatedBytes: 192, resourceCount: 0, unknownResources: 0 });
    for (const result of f.device.createBuffer.mock.results) expect(result.value.destroy).toHaveBeenCalledOnce();
    context.dispose(); context.dispose(); expect(f.owned.size).toBe(0);
  });

  it.each(["grow", "phase"] as const)("keeps the old packet resources after %s candidate refusal", mode => {
    const f = fixture(mode === "grow" ? 46000 : 35000), owner = new PacketCullingResources(f.session);
    const makeBatch = (count: number) => ({ source: { key: "batch", geometry: "mesh", count,
      alphaMode: "OPAQUE", data: new Float32Array(count * 36) }, previousTransforms: new Float32Array(count * 12) } as CachedPacketBatch);
    const batch = makeBatch(64), geometry = { source: { revision: 0 }, center: [0, 0, 0], radius: 1,
      mesh: { indexCount: 3 } } as CachedPacketGeometry;
    const run = (value = batch, mesh = geometry) => owner.encode(f.encoder, authorView.frustum, "opaque",
      new Map([["batch", value]]), new Map([["mesh", mesh]]));
    run(); const previous = owner.phase("batch", "opaque")!, resources = [...f.owned];
    expect(f.memory.snapshot).toMatchObject({ estimatedBytes: 25736, resourceCount: 9, unknownResources: 0 });
    expect(() => mode === "grow" ? run(makeBatch(128)) : run(batch, { ...geometry, mesh: { ...geometry.mesh, indexCount: 6 } }))
      .toThrow(DeviceResourceBudgetError);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(10);
    expect(f.device.createBuffer.mock.results.at(-1)!.value.destroy).toHaveBeenCalledOnce();
    expect(f.memory.snapshot.estimatedBytes).toBe(25736);
    for (const resource of resources) expect(resource.destroy).not.toHaveBeenCalled();
    run(); expect(owner.phase("batch", "opaque")!.compacted).toBe(previous.compacted);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(10);
    owner.dispose(); owner.dispose(); expect(f.memory.snapshot.estimatedBytes).toBe(0);
    expect(f.owned.size).toBe(0);
  });

  it("counts author LOD shared/phase buffers without charging the CPU owner and retains current inputs", () => {
    const f = fixture(1300), owner = new AuthorSelectedLodResources(f.session), prepared = prepareRenderPacket(authorPacket([0]));
    const batch = { source: prepared.batches[0]!, previousTransforms: new Float32Array(12) } as CachedPacketBatch;
    const geometries = new Map([...prepared.geometries].map(([key, source]) => [key, { source, center: [0, 0, 0], radius: 1,
      mesh: { indexCount: source.indices.length } } as CachedPacketGeometry]));
    const run = (value = batch) => owner.encode(f.encoder, authorView.frustum, [value], geometries);
    run(); const first = owner.draws(batch.source.key)![0]!, resources = [...f.owned]; owner.commitFrame();
    expect(f.memory.snapshot).toMatchObject({ estimatedBytes: 1072, resourceCount: 18, unknownResources: 0 });
    const changed = { ...batch, source: { ...batch.source, data: batch.source.data.slice() } }; changed.source.data[3] = 10;
    expect(() => run(changed)).toThrow(DeviceResourceBudgetError);
    expect(f.memory.snapshot).toMatchObject({ estimatedBytes: 1072, peakEstimatedBytes: 1296, resourceCount: 18 });
    for (const resource of resources) expect(resource.destroy).not.toHaveBeenCalled();
    expect(f.device.createBuffer).toHaveBeenCalledTimes(22);
    run(); expect(owner.draws(batch.source.key)![0]!.instances).toBe(first.instances); owner.commitFrame();
    expect(f.device.createBuffer).toHaveBeenCalledTimes(22);
    owner.dispose(); owner.dispose(); expect(f.memory.snapshot.estimatedBytes).toBe(0); expect(f.owned.size).toBe(0);
  });
});
