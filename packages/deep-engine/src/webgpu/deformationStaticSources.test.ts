import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import { PacketBuffers } from "./packetBuffers.js";
import { PacketDeformationResources } from "./packetDeformationResources.js";
import { DeformationStaticSources } from "./deformationStaticSources.js";
import { GpuSkinner } from "./gpuSkinning.js";
import { deformationPacket } from "../renderPacketDeformation.testUtils.js";
beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16, INDEX: 32 });
});
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const owned = new Set<GPUBuffer>();
  const device = { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ ...descriptor, mapState: "unmapped", destroy: vi.fn() })) };
  const raw = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  const session = raw as unknown as DeviceSession, pipelines = { deformationPlainLayout: {}, materialLayout: { material: {} } } as unknown as Pipelines;
  const encoder = { beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }), copyBufferToBuffer() {} } as unknown as GPUCommandEncoder;
  return { owned, device, session, raw, encoder, cache: new PacketBuffers(session, undefined, pipelines) };
}
const staticLabels = ["Deep skinning source", "Deep morph source", "Deep morph targets", "Deep fused morph vertices", "Deep fused morph targets", "Deep fused skin influences"];
const staticWrites = (f: ReturnType<typeof fixture>) => f.device.queue.writeBuffer.mock.calls.filter(call => staticLabels.includes((call[0] as GPUBuffer).label));

describe("immutable deformation source leases", () => {
  it.each(["skin", "morph", "morph-skin"] as const)("shares one %s static upload across two independent poses", kind => {
    const f = fixture(), packet = deformationPacket(kind), pose = packet.deformation.poses[0]!;
    const owner = new PacketDeformationResources(f.session);
    owner.prepare({ sources: packet.deformation.sources, poses: [pose, { ...structuredClone(pose), id: "other-pose" }] });
    expect(staticWrites(f)).toHaveLength(kind === "skin" ? 1 : kind === "morph" ? 2 : 3);
    owner.encode(f.encoder);
    expect(owner.drawStreams(pose.id)!.current).not.toBe(owner.drawStreams("other-pose")!.current);
    owner.commitFrame(); const writes = staticWrites(f).length;
    owner.updatePoses([pose, { ...structuredClone(pose), id: "other-pose" }]);
    expect(staticWrites(f)).toHaveLength(writes); owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it("borrows validated full-packet sources and retains them across old-packet retirement", async () => {
    const f = fixture(); await f.cache.setValidated(deformationPacket("morph"));
    const oldStatic = staticWrites(f).map(call => call[0] as GPUBuffer);
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    await f.cache.setValidated(deformationPacket("morph"));
    expect(staticWrites(f)).toHaveLength(2);
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame();
    for (const buffer of oldStatic) expect(buffer.destroy).not.toHaveBeenCalled();
    f.cache.dispose(); for (const buffer of oldStatic) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(0);
  });
  it("does not expose synchronous unvalidated packet resources to later candidates", async () => {
    const f = fixture(); f.cache.set(deformationPacket("morph"));
    await f.cache.setValidated(deformationPacket("morph")); expect(staticWrites(f)).toHaveLength(4);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("does not share provisional sources when validation is cancelled or superseded", async () => {
    const f = fixture(); let finish!: (error: GPUError | null) => void;
    f.device.popErrorScope.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.cache.setValidated(deformationPacket("morph")); const rejected = expect(first).rejects.toThrow("cancelled");
    await f.cache.setValidated(deformationPacket("morph")); await rejected;
    expect(staticWrites(f)).toHaveLength(4); finish(null);
    await Promise.resolve(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("failed GPU validation cannot poison the ready cache", async () => {
    const f = fixture(); f.device.popErrorScope.mockResolvedValueOnce({ message: "injected GPU failure" } as GPUError);
    await expect(f.cache.setValidated(deformationPacket("morph"))).rejects.toThrow("injected GPU failure");
    expect(f.owned.size).toBe(0);
    await f.cache.setValidated(deformationPacket("morph")); expect(staticWrites(f)).toHaveLength(4);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("borrowed ready source survives candidate allocation failure", async () => {
    const f = fixture(); await f.cache.setValidated(deformationPacket("morph"));
    const count = f.owned.size, shared = staticWrites(f).map(call => call[0] as GPUBuffer);
    f.device.createBuffer.mockImplementationOnce(() => { throw Error("output failed"); });
    await expect(f.cache.setValidated(deformationPacket("morph"))).rejects.toThrow("output failed");
    expect(f.owned.size).toBe(count); shared.forEach(buffer => expect(buffer.destroy).not.toHaveBeenCalled());
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("cleans all provisional inputs when the second static upload fails", () => {
    const f = fixture(), owner = new PacketDeformationResources(f.session);
    f.device.queue.writeBuffer.mockImplementation((_buffer: GPUBuffer) => {
      if (_buffer.label === "Deep morph targets") throw Error("static upload failed");
    });
    expect(() => owner.prepare(deformationPacket("morph").deformation)).toThrow("static upload failed");
    expect(f.owned.size).toBe(0); owner.dispose();
  });
  it("cancelled borrower does not release the active validated source", async () => {
    const f = fixture(); await f.cache.setValidated(deformationPacket("morph")); const count = f.owned.size;
    let finish!: (error: GPUError | null) => void;
    f.device.popErrorScope.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.cache.setValidated(deformationPacket("morph")), rejected = expect(pending).rejects.toThrow("cancelled");
    f.cache.cancelPendingPacketStage(); await rejected; expect(f.owned.size).toBe(count);
    expect(staticWrites(f)).toHaveLength(2); finish(null); await Promise.resolve();
    f.cache.encodeDeformation(f.encoder); f.cache.commitFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("rejects same-version content changes, but uploads a legitimately revised source", async () => {
    const f = fixture(); await f.cache.setValidated(deformationPacket("morph"));
    const bad = deformationPacket("morph"); bad.deformation.sources[0]!.morph!.primitive.targets[0]!.positionDeltas![0] = .8;
    await expect(f.cache.setValidated(bad)).rejects.toThrow("without a revision");
    const next = structuredClone(bad); next.deformation.sources[0]!.revision++; next.deformation.sources[0]!.morph!.revision++;
    await f.cache.setValidated(next); expect(staticWrites(f)).toHaveLength(4); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("isolates packet owners and device epochs, and rejects lost-device leases", () => {
    const a = fixture(), b = fixture(), source = deformationPacket("skin").deformation.sources[0]!;
    const poolA = new DeformationStaticSources(a.session), poolB = new DeformationStaticSources(b.session);
    const stageA = poolA.stage(), stageB = poolB.stage();
    expect(() => new GpuSkinner(b.session, stageA.source(source, 1))).toThrow("another device epoch");
    const first = stageA.source(source, 1).upload("source", new Uint8Array(4)); stageA.publishValidated();
    const second = stageB.source(source, 1).upload("source", new Uint8Array(4)); expect(second).not.toBe(first);
    a.raw.state = "lost"; expect(() => poolA.stage().source(source, 1)).toThrow("not ready");
    stageA.dispose(); stageB.dispose(); expect(a.owned.size + b.owned.size).toBe(0);
  });
});
