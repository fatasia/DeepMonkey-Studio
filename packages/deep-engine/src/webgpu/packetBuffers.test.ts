import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js"; import { PacketBuffers } from "./packetBuffers.js"; import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";
function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: GPUBuffer[] = [];
  const contents = new Map<GPUBuffer, number[]>();
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024 },
    createBuffer: vi.fn(({ label }: { label?: string }) => { const buffer = { label, destroy: vi.fn() } as unknown as GPUBuffer; allocated.push(buffer); return buffer; }),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    queue: { writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: Float32Array | Uint32Array) => { contents.set(buffer, Array.from(data)); }) } };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  const cache = new PacketBuffers(session as unknown as DeviceSession);
  const pass = { setPipeline: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const mainPipelines = new Map<string, GPURenderPipeline>([
    [mainPipelineKey("plain", false, "ccw"), "main" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", false, "cw"), "mirror" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", false, "double"), "double" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", true, "ccw"), "blend" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", true, "cw"), "blendMirror" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", true, "double"), "blendDouble" as unknown as GPURenderPipeline],
  ]);
  const shadowPipelines = new Map<string, GPURenderPipeline>([
    [shadowPipelineKey("solid", "ccw"), "shadow" as unknown as GPURenderPipeline],
    [shadowPipelineKey("solid", "cw"), "shadowMirror" as unknown as GPURenderPipeline],
    [shadowPipelineKey("solid", "double"), "shadowDouble" as unknown as GPURenderPipeline],
    [shadowPipelineKey("maskPlain", "ccw"), "shadowMask" as unknown as GPURenderPipeline],
    [shadowPipelineKey("maskPlain", "double"), "shadowMaskDouble" as unknown as GPURenderPipeline],
  ]);
  const pipelines = { main: "main", shadow: "shadow", mainPipelines, shadowPipelines } as unknown as Pipelines;
  const draw = (shadow = false) => cache.draw(pass as unknown as GPURenderPassEncoder, pipelines, shadow ? "shadow" : "opaque");
  const byLabel = (label: string) => allocated.filter(buffer =>
    (buffer as GPUBuffer & { label?: string }).label === label);
  return { cache, device, session, owned, allocated, contents, pass, draw, byLabel };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function packet(revision = 0): RenderPacket {
  return { geometries: [{ id: "g", revision, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0, roughness: 0.5 }],
    instances: [{ id: "i", geometry: "g", material: "m", transform }] };
}
beforeEach(() => { vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4, INDIRECT: 256 });
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("packet GPU resource ownership", () => {
  it("reuses unchanged uploads and only replaces the resource that changed", () => {
    const f = fixture(); expect(f.cache.set(packet())).toBe(true);
    expect(f.owned).toEqual(new Set([
      f.byLabel("Deep vertices")[0], f.byLabel("Deep indices")[0],
      f.byLabel("Deep packet instances")[0], f.byLabel("Deep packet previous transforms")[0],
    ]));
    const firstInstances = f.byLabel("Deep packet instances")[0]!;
    const firstPrevious = f.byLabel("Deep packet previous transforms")[0]!;
    expect(f.cache.set(packet())).toBe(false); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(4);
    expect(f.cache.set(packet(1))).toBe(true); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(6);
    expect(f.owned.has(firstInstances)).toBe(true); expect(f.owned.has(firstPrevious)).toBe(true);
    const p = packet(1); f.cache.set({ ...p, materials: [{ ...p.materials[0]!, metallic: 1 }] });
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(8); expect(f.owned.size).toBe(4);
    expect(firstInstances.destroy).toHaveBeenCalledOnce(); expect(firstPrevious.destroy).toHaveBeenCalledOnce();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
  });
  it("rejects stale or silently mutated revisions without replacing the active geometry", () => {
    const f = fixture(); f.cache.set(packet(2));
    expect(() => f.cache.set(packet(1))).toThrow("Stale");
    const mutated = packet(2); mutated.geometries[0]!.vertices[0] = 2;
    expect(() => f.cache.set(mutated)).toThrow("without a revision");
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 }); expect(f.owned.size).toBe(4);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(4);
  });
  it("rolls back partial uploads and preserves the last drawable packet on synchronous failure", () => {
    const f = fixture(); f.cache.set(packet());
    f.device.queue.writeBuffer.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("upload failed"); });
    expect(() => f.cache.set(packet(1))).toThrow("upload failed");
    expect(f.owned.size).toBe(4); expect(f.allocated).toHaveLength(6);
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    f.cache.dispose(); f.cache.dispose();
    expect(f.owned.size).toBe(0);
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
  it("rolls back earlier new geometry when a later instance upload fails", () => {
    const f = fixture(); f.cache.set(packet());
    const p = packet(1);
    f.device.queue.writeBuffer.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("instances failed"); });
    expect(() => f.cache.set({ ...p, materials: [{ ...p.materials[0]!, roughness: 1 }] })).toThrow("instances failed");
    expect(f.owned.size).toBe(4); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
  it("attempts every candidate cleanup when one rollback destroy fails", () => {
    const f = fixture(); f.cache.set(packet());
    const create = f.device.createBuffer.getMockImplementation()!; let candidate = 0;
    f.device.createBuffer.mockImplementation(descriptor => {
      const buffer = create(descriptor);
      if (candidate++ === 0) vi.mocked(buffer.destroy).mockImplementationOnce(() => { throw new Error("bad rollback destroy"); });
      return buffer;
    });
    f.device.queue.writeBuffer.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("instance upload failed"); });
    const p = packet(1);
    expect(() => f.cache.set({ ...p, materials: [{ ...p.materials[0]!, metallic: 1 }] }))
      .toThrow("Packet buffer staging failed");
    expect(f.allocated.slice(4).every(buffer => vi.mocked(buffer.destroy).mock.calls.length === 1)).toBe(true);
    expect(f.owned.size).toBe(4); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
  });
  it("settles validated cancellation when candidate cleanup fails", async () => {
    const f = fixture(); f.cache.set(packet()); const pending = deferred<GPUError | null>();
    f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const controller = new AbortController(), p = packet(1);
    const update = f.cache.setValidated({ ...p,
      materials: [{ ...p.materials[0]!, metallic: 1 }] }, controller.signal);
    vi.mocked(f.allocated[4]!.destroy).mockImplementationOnce(() => { throw new Error("bad cancel destroy"); });
    controller.abort();
    await expect(update).rejects.toMatchObject({ message: "Packet cancellation cleanup failed." });
    expect(f.allocated.slice(4).every(buffer => vi.mocked(buffer.destroy).mock.calls.length === 1)).toBe(true);
    expect(f.owned.size).toBe(4); pending.resolve(null); await Promise.resolve(); f.cache.dispose();
  });
  it("frees orphan buffers on empty scene, rejects disposed/lost sessions and enforces device limits", () => {
    const f = fixture(); f.cache.set(packet());
    expect(f.cache.set({ geometries: [], materials: [], instances: [] })).toBe(true);
    expect(f.owned.size).toBe(0); expect(f.draw()).toEqual({ drawCalls: 0, triangles: 0 });
    f.device.limits.maxBufferSize = 64;
    expect(() => f.cache.set(packet())).toThrow("device buffer limit"); expect(f.owned.size).toBe(0);
    f.session.state = "lost"; expect(() => f.cache.set(packet())).toThrow("not ready");
    f.cache.dispose(); expect(() => f.draw()).toThrow("disposed");
  });
  it("checks the packed 40-byte geometry stream against the device limit before allocation", () => {
    const f = fixture(), p = packet();
    f.device.limits.maxBufferSize = 119;
    expect(() => f.cache.set(p)).toThrow("Geometry exceeds device buffer limit.");
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    f.device.limits.maxBufferSize = 144;
    expect(f.cache.set(p)).toBe(true);
    expect(f.byLabel("Deep vertices")).toHaveLength(1); expect(f.byLabel("Deep indices")).toHaveLength(1);
    expect(f.byLabel("Deep packet instances")).toHaveLength(1);
    expect(f.byLabel("Deep packet previous transforms")).toHaveLength(1);
  });
  it("updates transforms without scanning or copying resident geometry", () => {
    const f = fixture(), p = packet(), vertices = new Float32Array(6 * 256);
    for (let i = 0; i < vertices.length; i += 6) vertices[i + 5] = 1;
    f.cache.set({ ...p, geometries: [{ ...p.geometries[0]!, vertices }] });
    expect(f.cache.visibilityRevision).toBe(1);
    const every = vi.spyOn(Float32Array.prototype, "every"), slice = vi.spyOn(Float32Array.prototype, "slice");
    const moved = { ...p.instances[0]!, transform: [...transform.slice(0, 12), 5, 0, 0, 1] };
    expect(f.cache.updateInstances({ materials: p.materials, instances: [moved] })).toBe(true);
    expect(f.cache.visibilityRevision).toBe(2);
    expect(every.mock.contexts.every(array => array.length <= 36)).toBe(true);
    expect(slice).not.toHaveBeenCalled();
    const current = f.byLabel("Deep packet instances")[0]!;
    const previous = f.byLabel("Deep packet previous transforms")[0]!;
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(5);
    expect(f.contents.get(current)![3]).toBe(5); expect(f.contents.get(previous)![3]).toBe(0);
    expect(f.allocated[0]!.destroy).not.toHaveBeenCalled(); expect(f.allocated[1]!.destroy).not.toHaveBeenCalled();
    const movedAgain = { ...moved, transform: [...transform.slice(0, 12), 7, 0, 0, 1] };
    expect(f.cache.updateInstances({ materials: p.materials, instances: [movedAgain] })).toBe(true);
    expect(f.cache.visibilityRevision).toBe(3);
    expect(f.contents.get(current)![3]).toBe(7); expect(f.contents.get(previous)![3]).toBe(0);
    expect(f.cache.commitFrame()).toBe(true); expect(f.contents.get(previous)![3]).toBe(7);
    expect(f.cache.updateInstances({ materials: p.materials, instances: [movedAgain] })).toBe(false);
    expect(f.cache.visibilityRevision).toBe(3);
    expect(f.cache.commitFrame()).toBe(false);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(7);
  });
  it("uploads only current material words at the 16384-instance limit and preserves full-packet bytes", () => {
    const f = fixture(), p = packet();
    const large = { ...p, instances: Array.from({ length: 16_384 }, (_, index) => ({ ...p.instances[0]!, id: `i${index}` })) };
    f.cache.set(large);
    const history = f.byLabel("Deep packet previous transforms")[0]!;
    const before = f.contents.get(history);
    f.device.queue.writeBuffer.mockClear();
    const changed = { ...large, materials: [{ ...p.materials[0]!, metallic: 1 }] };
    expect(f.cache.updateInstances(changed)).toBe(true);
    const writes = f.device.queue.writeBuffer.mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe(f.byLabel("Deep packet instances")[0]);
    expect(writes[0]![2].byteLength).toBe(16_384 * 144);
    expect(f.contents.get(history)).toBe(before);
    expect(f.cache.commitFrame()).toBe(false);
    expect(f.cache.updateInstances(changed)).toBe(false);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
    const full = fixture(); full.cache.set(changed);
    expect(f.contents.get(writes[0]![0])).toEqual(full.contents.get(full.byLabel("Deep packet instances")[0]!));
    expect(f.contents.get(history)).toEqual(full.contents.get(full.byLabel("Deep packet previous transforms")[0]!));
    f.cache.dispose(); full.cache.dispose();
  });
  it("does no transform packing or allocation on a submitted static frame", () => {
    const f = fixture(); f.cache.set(packet());
    const subarray = vi.spyOn(Float32Array.prototype, "subarray");
    const allocations = vi.spyOn(globalThis, "Float32Array");
    expect(f.cache.commitFrame()).toBe(false);
    expect(subarray).not.toHaveBeenCalled(); expect(allocations).not.toHaveBeenCalled();
  });
  it("hides all instances while retaining geometry for reappearance, then evicts on a full empty packet", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    expect(f.cache.updateInstances({ materials: [], instances: [] })).toBe(true);
    expect(f.draw()).toEqual({ drawCalls: 0, triangles: 0 }); expect(f.owned.size).toBe(2);
    expect(f.cache.updateInstances({ materials: [], instances: [] })).toBe(false);
    expect(f.cache.updateInstances(p)).toBe(true); expect(f.owned.size).toBe(4);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(6);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    f.cache.set({ geometries: [], materials: [], instances: [] });
    expect(() => f.cache.updateInstances(p)).toThrow("Missing geometry"); expect(f.owned.size).toBe(0);
  });
  it("preserves active draws after invalid or partially uploaded instance updates", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    const current = f.byLabel("Deep packet instances")[0]!;
    const previous = f.byLabel("Deep packet previous transforms")[0]!;
    const oldCurrent = f.contents.get(current), oldPrevious = f.contents.get(previous);
    expect(() => f.cache.updateInstances({ materials: p.materials, instances: [{ ...p.instances[0]!, geometry: "missing" }] })).toThrow("Missing");
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("instance upload failed"); });
    expect(() => f.cache.updateInstances({ ...p, materials: [{ ...p.materials[0]!, metallic: 1 }] })).toThrow("instance upload failed");
    expect(f.owned.size).toBe(4); expect(f.allocated).toHaveLength(4);
    expect(f.contents.get(current)).toEqual(oldCurrent); expect(f.contents.get(previous)).toEqual(oldPrevious);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
  });
  it("restores a resident batch and releases its new peer if the later mirrored upload fails", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    const current = f.byLabel("Deep packet instances")[0]!;
    const previous = f.byLabel("Deep packet previous transforms")[0]!;
    const oldCurrent = f.contents.get(current), oldPrevious = f.contents.get(previous);
    const write = f.device.queue.writeBuffer.getMockImplementation()!; let calls = 0;
    f.device.queue.writeBuffer.mockImplementation((buffer, offset, data) => {
      write(buffer, offset, data); if (++calls === 3) throw new Error("second batch failed");
    });
    expect(() => f.cache.updateInstances({ materials: [{ ...p.materials[0]!, metallic: 1 }], instances: [p.instances[0]!,
      { ...p.instances[0]!, id: "mirrored", transform: [-1, ...transform.slice(1)] }] })).toThrow("second batch failed");
    expect(f.owned.size).toBe(4); expect(f.allocated).toHaveLength(6);
    expect(f.contents.get(current)).toEqual(oldCurrent); expect(f.contents.get(previous)).toEqual(oldPrevious);
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
  });
  it("reuses a steady instance allocation across 120 transform updates and allocates only when capacity grows", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    for (let frame = 1; frame <= 120; frame++) {
      const moved = { ...p.instances[0]!, transform: [...transform.slice(0, 12), frame * 0.1, 0, 0, 1] };
      expect(f.cache.updateInstances({ materials: p.materials, instances: [moved] })).toBe(true);
    }
    expect(f.device.createBuffer).toHaveBeenCalledTimes(4); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(124);
    for (const buffer of f.allocated) expect(buffer.destroy).not.toHaveBeenCalled();
    f.cache.updateInstances({ materials: p.materials, instances: [...p.instances, { ...p.instances[0]!, id: "second" }] });
    expect(f.byLabel("Deep packet instances")).toHaveLength(2);
    expect(f.byLabel("Deep packet previous transforms")).toHaveLength(2);
    expect(f.byLabel("Deep packet instances")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.byLabel("Deep packet previous transforms")[0]!.destroy).toHaveBeenCalledOnce();
    f.cache.updateInstances(p); expect(f.allocated).toHaveLength(6);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.contents.get(f.byLabel("Deep packet instances")[1]!)).toHaveLength(36);
  });
  it("validates later invalid instances before writing any earlier changed batch", () => {
    const f = fixture(), p = packet(); f.cache.set(p); f.device.queue.writeBuffer.mockClear();
    expect(() => f.cache.updateInstances({ materials: p.materials, instances: [
      { ...p.instances[0]!, transform: [...transform.slice(0, 12), 2, 0, 0, 1] },
      { ...p.instances[0]!, id: "late", transform: Array(16).fill(0) },
    ] })).toThrow("affine");
    expect(f.device.queue.writeBuffer).not.toHaveBeenCalled(); expect(f.allocated).toHaveLength(4);
  });
  it("restores all resident batch contents after a later write fails, including a partially written failing buffer", () => {
    const f = fixture(), p = packet();
    const update = { ...p, instances: [...p.instances, { ...p.instances[0]!, id: "mirror", transform: [-1, ...transform.slice(1)] }] };
    f.cache.set(update); const before = new Map(f.contents);
    const write = f.device.queue.writeBuffer.getMockImplementation()!; let calls = 0;
    f.device.queue.writeBuffer.mockImplementation((buffer, offset, data) => {
      write(buffer, offset, data); if (++calls === 2) throw new Error("late write");
    });
    expect(() => f.cache.updateInstances({ ...update, materials: [{ ...p.materials[0]!, metallic: 1 }] })).toThrow("late write");
    expect(f.contents).toEqual(before); expect(f.owned.size).toBe(6); expect(f.allocated).toHaveLength(6);
    expect(f.draw()).toEqual({ drawCalls: 2, triangles: 2 });
  });
  it("stops and releases the projection if failed writes cannot restore the previous contents", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    f.device.queue.writeBuffer.mockImplementation(() => { throw new Error("device write unavailable"); });
    expect(() => f.cache.updateInstances({ ...p, materials: [{ ...p.materials[0]!, metallic: 1 }] })).toThrow("rollback failed");
    expect(f.owned.size).toBe(0); expect(() => f.draw()).toThrow("disposed");
    expect(() => f.cache.updateInstances(p)).toThrow("not ready");
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
  it("rolls back a failed submitted-frame history write and keeps the prior frame drawable", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    const moved = { ...p.instances[0]!, transform: [...transform.slice(0, 12), 4, 0, 0, 1] };
    f.cache.updateInstances({ materials: p.materials, instances: [moved] });
    const previous = f.byLabel("Deep packet previous transforms")[0]!;
    const before = f.contents.get(previous);
    const write = f.device.queue.writeBuffer.getMockImplementation()!; let calls = 0;
    f.device.queue.writeBuffer.mockImplementation((buffer, offset, data) => {
      write(buffer, offset, data); if (++calls === 1) throw new Error("history upload failed");
    });
    expect(() => f.cache.commitFrame()).toThrow("history upload failed");
    expect(f.contents.get(previous)).toEqual(before); expect(f.owned.size).toBe(4);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.cache.commitFrame()).toBe(true); expect(f.contents.get(previous)![3]).toBe(4);
  });
  it("releases the packet when submitted-frame history cannot be restored", () => {
    const f = fixture(), p = packet(); f.cache.set(p);
    const moved = { ...p.instances[0]!, transform: [...transform.slice(0, 12), 4, 0, 0, 1] };
    f.cache.updateInstances({ materials: p.materials, instances: [moved] });
    f.device.queue.writeBuffer.mockImplementation(() => { throw new Error("history device unavailable"); });
    expect(() => f.cache.commitFrame()).toThrow("rollback failed");
    expect(f.owned.size).toBe(0); expect(() => f.draw()).toThrow("disposed");
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
  it("completes all new allocations before writing changed resident batches", () => {
    const f = fixture(), p = packet(); f.cache.set(p); f.device.queue.writeBuffer.mockClear();
    f.device.createBuffer.mockImplementationOnce(() => { throw new Error("new batch allocation failed"); });
    expect(() => f.cache.updateInstances({ materials: [{ ...p.materials[0]!, metallic: 1 }], instances: [...p.instances,
      { ...p.instances[0]!, id: "mirror", transform: [-1, ...transform.slice(1)] }] })).toThrow("allocation failed");
    expect(f.device.queue.writeBuffer).not.toHaveBeenCalled(); expect(f.owned.size).toBe(4);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
  });
  it("detaches all ownership when one driver resource fails during disposal", () => {
    const f = fixture(); f.cache.set(packet());
    const first = f.allocated[0]!.destroy;
    first.mockImplementation(() => { throw new Error("driver destroy failed"); });
    expect(() => f.cache.dispose()).toThrow(AggregateError);
    expect(f.owned.size).toBe(0);
    expect(f.allocated.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => f.cache.dispose()).not.toThrow();
  });
});
