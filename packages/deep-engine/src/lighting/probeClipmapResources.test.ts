import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { planIrradianceProbeClipmap, type ProbeClipmapPlan } from "./probeClipmapPlan.js";
import { ProbeClipmapResources } from "./probeClipmapResources.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
interface FakeBuffer extends GPUBuffer {
  readonly label: string;
  readonly size: number;
  readonly destroy: ReturnType<typeof vi.fn>;
}
interface Write { readonly buffer: FakeBuffer; readonly offset: number; readonly data: Uint8Array }

function fixture() {
  const owned = new Set<FakeBuffer>(), allocated: FakeBuffer[] = [], descriptors: GPUBufferDescriptor[] = [];
  const checks: ReturnType<typeof deferred<GPUError | null>>[] = [], writes: Write[] = [];
  let failAt = -1;
  const queue = { writeBuffer: vi.fn((buffer: FakeBuffer, offset: number,
    source: ArrayBuffer | ArrayBufferView) => {
    const bytes = source instanceof ArrayBuffer
      ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    writes.push({ buffer, offset, data: bytes.slice() });
  }) };
  const device = {
    limits: { maxBufferSize: 128 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    queue,
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => { const check = deferred<GPUError | null>(); checks.push(check); return check.promise; }),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      if (allocated.length === failAt) throw new Error("allocation failed");
      descriptors.push(descriptor);
      const buffer = { label: descriptor.label as string, size: descriptor.size as number,
        destroy: vi.fn() } as unknown as FakeBuffer;
      allocated.push(buffer); return buffer;
    }),
  };
  const rawSession = {
    state: "ready", device,
    own(buffer: FakeBuffer) { owned.add(buffer); return buffer; },
    release(buffer: FakeBuffer) { if (owned.delete(buffer)) buffer.destroy(); },
  };
  const settle = (start = 0, errorAt = -1) => checks.slice(start, start + 3).forEach((check, index) =>
    check.resolve(index === errorAt ? { message: "driver rejected buffers" } as GPUError : null));
  return { session: rawSession as unknown as DeviceSession, rawSession, device, queue, owned,
    allocated, descriptors, checks, writes, settle, failNext(offset: number) { failAt = allocated.length + offset; } };
}

const scene = { min: [-1_000, -1_000, -1_000], max: [1_000, 1_000, 1_000] } as const;
const plan = (levelCount = 3): ProbeClipmapPlan => planIrradianceProbeClipmap({
  cameraPosition: [0, 0, 0], sceneBounds: scene, options: { levelCount },
});

beforeEach(() => vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Deep GI probe clipmap GPU resource lifecycle", () => {
  it("creates three bounded buffers and publishes exact byte/update evidence after validation", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "browser-1");
    const pending = resources.setValidated(plan(), "browser-1");
    expect(resources.current).toBeUndefined();
    expect(f.descriptors).toEqual([
      { label: "Deep GI probe storage", size: 589_824, usage: 3 },
      { label: "Deep GI probe update list", size: 1_024, usage: 3 },
      { label: "Deep GI probe level metadata", size: 192, usage: 3 },
    ]);
    expect(f.writes.map(write => [write.buffer.label, write.data.byteLength])).toEqual([
      ["Deep GI probe update list", 1_024], ["Deep GI probe level metadata", 192],
    ]);
    expect(new Uint32Array(f.writes[0]!.data.buffer).slice(0, 4)).toEqual(new Uint32Array([0, 8, 4, 8]));
    const levelFloats = new Float32Array(f.writes[1]!.data.buffer), levelWords = new Uint32Array(f.writes[1]!.data.buffer);
    expect([...levelFloats.slice(0, 4)]).toEqual([-16, -8, -16, 2]);
    expect([...levelWords.slice(4, 8)]).toEqual([16, 8, 16, 0]);
    f.settle();
    const result = await pending;
    expect(result.status).toBe("created");
    expect(result.evidence).toEqual({ generation: 1, allocatedBytes: 591_040,
      updatedBytes: 1_216, updateCount: 64, createdBufferCount: 3, reusedBufferCount: 0 });
    expect(result.resource.allocatedBytes).toBe(591_040); expect(f.owned.size).toBe(3);
  });

  it("reuses all buffers and uploads only the bounded update fragment when metadata is stable", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1"), firstPlan = plan();
    const first = resources.setValidated(firstPlan, "gpu-1"); f.settle(); await first;
    const active = resources.current!, writes = f.writes.length;
    const nextPlan = planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0], sceneBounds: scene,
      previous: firstPlan.history });
    const result = await resources.setValidated(nextPlan, "gpu-1");
    expect(result.status).toBe("reused");
    expect(result.resource.probeStorageBuffer).toBe(active.probeStorageBuffer);
    expect(result.resource.updateListBuffer).toBe(active.updateListBuffer);
    expect(result.resource.levelMetadataBuffer).toBe(active.levelMetadataBuffer);
    expect(result.evidence).toEqual({ generation: 2, allocatedBytes: 591_040,
      updatedBytes: 1_024, updateCount: 64, createdBufferCount: 0, reusedBufferCount: 3 });
    expect(f.writes.slice(writes).map(write => [write.buffer.label, write.data.byteLength]))
      .toEqual([["Deep GI probe update list", 1_024]]);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(3);
  });

  it("atomically swaps a changed profile only after candidate validation", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1");
    const initial = resources.setValidated(plan(), "gpu-1"); f.settle(); await initial;
    const active = resources.current!, replacement = resources.setValidated(plan(2), "gpu-1");
    expect(resources.current).toBe(active); expect(f.owned.size).toBe(6);
    expect(active.probeStorageBuffer.destroy).not.toHaveBeenCalled();
    f.settle(3);
    const result = await replacement;
    expect(result.status).toBe("created");
    expect(result.evidence).toEqual({ generation: 2, allocatedBytes: 394_368,
      updatedBytes: 1_152, updateCount: 64, createdBufferCount: 3, reusedBufferCount: 0 });
    expect(active.probeStorageBuffer.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(3);
  });

  it("preserves active resources after allocation, upload, validation and cancellation failures", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1");
    const initial = resources.setValidated(plan(), "gpu-1"); f.settle(); await initial;
    const active = resources.current!;

    f.failNext(1);
    await expect(resources.setValidated(plan(2), "gpu-1")).rejects.toThrow("allocation failed");
    expect(resources.current).toBe(active);
    f.settle(3);
    f.failNext(1_000);

    const rejected = resources.setValidated(plan(2), "gpu-1"); f.settle(6, 1);
    await expect(rejected).rejects.toThrow("driver rejected buffers"); expect(resources.current).toBe(active);

    const controller = new AbortController(), cancelled = resources.setValidated(plan(2), "gpu-1", controller.signal);
    controller.abort(new Error("caller stopped"));
    await expect(cancelled).rejects.toThrow("caller stopped"); expect(resources.current).toBe(active);
    f.settle(9); await Promise.allSettled(f.checks.map(check => check.promise));
  });

  it("lets the newest generation win and ignores late validation from a released candidate", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1");
    const initial = resources.setValidated(plan(), "gpu-1"); f.settle(); await initial;
    const active = resources.current!, stale = resources.setValidated(plan(2), "gpu-1");
    const staleAssertion = expect(stale).rejects.toMatchObject({ name: "AbortError" });
    const winner = resources.setValidated(plan(4), "gpu-1");
    await staleAssertion; expect(resources.current).toBe(active);
    expect(f.allocated.slice(3, 6).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    f.settle(6); const committed = await winner;
    expect(committed.resource.plan.profile.levelCount).toBe(4);
    f.settle(3); await Promise.allSettled(f.checks.map(check => check.promise));
    expect(resources.current).toBe(committed.resource);
    expect(f.allocated.slice(6, 9).every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
  });

  it("keeps the prior snapshot on same-profile write failure or mid-write cancellation", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1"), source = plan();
    const initial = resources.setValidated(source, "gpu-1"); f.settle(); await initial;
    const active = resources.current!, next = planIrradianceProbeClipmap({
      cameraPosition: [0, 0, 0], sceneBounds: scene, previous: source.history,
    });
    f.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(resources.setValidated(next, "gpu-1")).rejects.toThrow("write failed");
    expect(resources.current).toBe(active); expect(f.device.createBuffer).toHaveBeenCalledTimes(3);

    const controller = new AbortController();
    f.queue.writeBuffer.mockImplementationOnce(() => controller.abort(new Error("cancel during write")));
    await expect(resources.setValidated(next, "gpu-1", controller.signal)).rejects.toThrow("cancel during write");
    expect(resources.current).toBe(active);
  });

  it("rejects stale epochs, lost sessions and inconsistent plans before allocation", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1");
    await expect(resources.setValidated(plan(), "gpu-2")).rejects.toThrow("epoch mismatch");
    const source = plan(), invalid = { ...source,
      profile: { ...source.profile, estimatedBytes: 4 } } as ProbeClipmapPlan;
    await expect(resources.setValidated(invalid, "gpu-1")).rejects.toThrow("byte evidence");
    f.device.limits.maxStorageBufferBindingSize = 589_823;
    await expect(resources.setValidated(plan(), "gpu-1")).rejects.toThrow("device storage limits");
    f.device.limits.maxStorageBufferBindingSize = 128 * 1024 * 1024;
    f.rawSession.state = "lost";
    await expect(resources.setValidated(plan(), "gpu-1")).rejects.toThrow("not ready");
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(() => new ProbeClipmapResources(f.session, "bad epoch")).toThrow("not canonical");
  });

  it("isolates sessions and disposes active and pending resources exactly once", async () => {
    const a = fixture(), b = fixture();
    const first = new ProbeClipmapResources(a.session, "gpu-a"), second = new ProbeClipmapResources(b.session, "gpu-b");
    const readyA = first.setValidated(plan(), "gpu-a"); a.settle(); await readyA;
    const readyB = second.setValidated(plan(), "gpu-b"); b.settle(); await readyB;
    expect(first.current!.probeStorageBuffer).not.toBe(second.current!.probeStorageBuffer);
    const pending = first.setValidated(plan(2), "gpu-a");
    first.dispose(); first.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(first.current).toBeUndefined(); expect(a.owned.size).toBe(0);
    a.settle(3); await Promise.allSettled(a.checks.map(check => check.promise));
    expect(a.allocated.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    second.dispose(); expect(b.owned.size).toBe(0);
  });
});

describe("Deep GI relocation record writes", () => {
  it("writes ABI v1 records into the probe storage buffer with fail-closed validation", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1");
    const source = plan();
    const update = source.updates[0]!;
    const offsets: (readonly [number, number, number] | undefined)[] =
      new Array(source.updates.length).fill(undefined);
    offsets[source.updates.indexOf(update)] = [0.5, 0, -0.25];
    const pending = resources.setValidated(source, "gpu-1", undefined, undefined,
      { offsets, recordCount: 1 });
    f.settle();
    const result = await pending;
    expect(result.evidence).toEqual({ generation: 1, allocatedBytes: 591_040,
      updatedBytes: 1_216, updateCount: 64, createdBufferCount: 3, reusedBufferCount: 0,
      relocationRecordCount: 1, relocationRecordBytes: 96 });
    const storageWrites = f.writes.filter(write => write.buffer.label === "Deep GI probe storage");
    expect(storageWrites).toHaveLength(1);
    const perLevel = source.profile.gridSize[0]! * source.profile.gridSize[1]! * source.profile.gridSize[2]!;
    expect(storageWrites[0]!.offset).toBe((update.level * perLevel + update.linearIndex) * 96);
    const floats = new Float32Array(storageWrites[0]!.data.buffer);
    expect([...floats.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // 光照通道保持惰性
    expect([...floats.slice(8, 11)]).toEqual([0.5, 0, -0.25]);        // relocation 通道
    expect([...floats.slice(11, 12)]).toEqual([0]);
  });

  it("rejects misaligned or out-of-bounds relocation writes before any allocation", async () => {
    const f = fixture(), resources = new ProbeClipmapResources(f.session, "gpu-1");
    const source = plan();
    await expect(resources.setValidated(source, "gpu-1", undefined, undefined,
      { offsets: new Array(source.updates.length - 1).fill(undefined), recordCount: 0 }))
      .rejects.toThrow(RangeError);
    const outOfBounds: (readonly [number, number, number] | undefined)[] =
      new Array(source.updates.length).fill(undefined);
    outOfBounds[source.updates.length - 1] = [5, 0, 0]; // 间距 2：|5| 越界
    await expect(resources.setValidated(source, "gpu-1", undefined, undefined,
      { offsets: outOfBounds, recordCount: 1 })).rejects.toThrow("out of bounds");
    const nonFinite: (readonly [number, number, number] | undefined)[] =
      new Array(source.updates.length).fill(undefined);
    nonFinite[0] = [Number.NaN, 0, 0];
    await expect(resources.setValidated(source, "gpu-1", undefined, undefined,
      { offsets: nonFinite, recordCount: 1 })).rejects.toThrow("out of bounds");
    expect(f.writes).toHaveLength(0);
    expect(f.device.createBuffer).not.toHaveBeenCalled();
  });
});
