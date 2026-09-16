import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import { PacketBuffers } from "./packetBuffers.js";
import { deformationPacket } from "../renderPacketDeformation.testUtils.js";
import { DeformationDrawBindings } from "./deformationDrawBindings.js";
import type { CachedPacketBatch } from "./packetBufferTypes.js";
import type { MaterialBinding } from "./materialBindings.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16, INDEX: 32 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const owned = new Set<GPUBuffer>();
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ ...descriptor, mapState: "unmapped", destroy: vi.fn() })),
  };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } } as unknown as DeviceSession;
  const pipelines = { deformationPlainLayout: {}, materialLayout: { material: {} } } as unknown as Pipelines;
  const cache = new PacketBuffers(session, undefined, pipelines);
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { beginComputePass: () => pass, copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
  return { cache, device, encoder, owned };
}

function changed(weight: number, move = 0) {
  const packet = deformationPacket("morph");
  return { materials: packet.materials,
    instances: packet.instances.map(instance => ({ ...instance,
      transform: Float64Array.from(instance.transform, (value, index) => index === 12 ? move : value) })),
    poses: packet.deformation.poses.map(pose => ({ ...pose, revision: 2,
      morphWeights: { revision: 2, values: new Float32Array([weight]) } })),
  };
}

describe("deformation transaction audit counterexamples", () => {
  it("requires rebuild after a failed GPU pose upload instead of poisoning author revisions", () => {
    const f = fixture(); f.cache.set(deformationPacket("morph"));
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("pose upload failed"); });
    expect(() => f.cache.updateInstances(changed(0.2))).toThrow("pose upload failed");
    // 作者未 acknowledge，下一采样仍 revision 2；不允许保留部分上传的 GPU 状态。
    expect(f.owned.size).toBe(0);
    expect(() => f.cache.updateInstances(changed(0.3))).toThrow("not ready");
    f.cache.dispose();
  });

  it("requires rebuild when object history fails after submitted deformation history", () => {
    const f = fixture(); f.cache.set(deformationPacket("morph"));
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    f.cache.updateInstances(changed(0.5, 3)); f.cache.encodeDeformation(f.encoder);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("object history upload failed"); });
    expect(() => f.cache.commitFrame()).toThrow("object history upload failed");
    expect(f.owned.size).toBe(0);
    expect(() => f.cache.updateInstances(changed(0.3))).toThrow("not ready");
    f.cache.dispose();
  });

  it("keeps the active packet drawable after a pre-upload invalid pose", () => {
    const f = fixture(); f.cache.set(deformationPacket("morph"));
    const retained = f.owned.size;
    expect(() => f.cache.updateInstances(changed(Number.NaN))).toThrow();
    expect(f.owned.size).toBe(retained);
    expect(() => f.cache.encodeDeformation(f.encoder)).not.toThrow();
    f.cache.commitFrame(); f.cache.dispose();
  });

  it("cancels a pending full stage before publishing a newer pose-only update", async () => {
    const f = fixture(), packet = deformationPacket("morph"); f.cache.set(packet);
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    const activeCount = f.owned.size;
    let resolve!: (value: GPUError | null) => void;
    const checked = new Promise<GPUError | null>(done => { resolve = done; });
    f.device.popErrorScope.mockReturnValue(checked);
    const pending = f.cache.setValidated({ ...packet,
      materials: packet.materials.map(material => ({ ...material, roughness: 0.7 })) });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    f.cache.updateInstances(changed(0.2));
    await rejected;
    expect(f.owned.size).toBe(activeCount);
    resolve(null); await Promise.resolve(); await Promise.resolve();
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    const state = f.cache as unknown as { deformation: { snapshot: { poses: { revision: number }[] } } };
    expect(state.deformation.snapshot.poses[0]!.revision).toBe(2);
    f.cache.dispose();
  });

  it("fails closed when retirement throws after the new pose was uploaded", () => {
    const f = fixture(); f.cache.set(deformationPacket("morph"));
    const batches = (f.cache as unknown as { batches: Map<string, CachedPacketBatch> }).batches;
    vi.mocked([...batches.values()][0]!.buffer.destroy).mockImplementationOnce(() => { throw new Error("retirement failed"); });
    const update = changed(0.2);
    expect(() => f.cache.updateInstances({ ...update,
      materials: update.materials.map(material => ({ ...material, alphaMode: "BLEND", baseColorAlpha: 0.5 })) })).toThrow();
    expect(f.owned.size).toBe(0);
    expect(() => f.cache.updateInstances(changed(0.3))).toThrow("not ready");
    f.cache.dispose();
  });

  it("prunes borrowed material identities at each encoded batch publication", () => {
    const retain = vi.spyOn(DeformationDrawBindings.prototype, "retain");
    const f = fixture(); f.cache.set(deformationPacket("morph"));
    const batches = (f.cache as unknown as { batches: Map<string, CachedPacketBatch> }).batches;
    const [key, initial] = [...batches][0]!;
    const previous = { key: "previous" } as MaterialBinding, current = { key: "current" } as MaterialBinding;
    batches.set(key, { ...initial, material: previous });
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    batches.set(key, { ...initial, material: current });
    f.cache.encodeDeformation(f.encoder);
    const active = retain.mock.calls.at(-1)![0];
    const retained = active.get(initial.source.pose!);
    expect(retained?.has(current)).toBe(true);
    expect(retained?.has(previous)).toBe(false);
    f.cache.cancelDeformationFrame();
    batches.set(key, initial); f.cache.dispose();
  });
});
