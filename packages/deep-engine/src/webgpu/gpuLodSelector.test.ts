import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuLodSelector } from "./gpuLodSelector.js";
import { GPU_LOD_LEVEL_STRIDE, GPU_LOD_MAX_LEVELS, GPU_LOD_OBJECT_STRIDE, GPU_LOD_OUTPUT_STRIDE } from "./gpuLodTypes.js";
import { GPU_LOD_WGSL } from "./gpuLodWgsl.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
function buffer(label: string, size: number, usage = GPUBufferUsage.STORAGE): FakeBuffer {
  return { label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
}

function fixture() {
  const owned = new Set<FakeBuffer>(), allocated: FakeBuffer[] = [], writes: Array<{ buffer: GPUBuffer; data: ArrayBuffer }> = [];
  const queue = { writeBuffer: vi.fn((target: GPUBuffer, _offset: number, data: ArrayBuffer) => writes.push({ buffer: target, data })) };
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxUniformBufferBindingSize: 65_536, maxComputeWorkgroupsPerDimension: 65_535 }, queue,
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => { const value = buffer(label ?? "", size, usage); allocated.push(value); return value; }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends FakeBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: FakeBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, queue, session: session as unknown as DeviceSession, rawSession: session, owned, allocated, writes };
}

function encoderFixture() {
  const passes: Array<{ dispatches: number[]; ended: boolean }> = [];
  const encoder = { beginComputePass: vi.fn(() => { const record = { dispatches: [] as number[], ended: false }; passes.push(record);
    return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn((count: number) => record.dispatches.push(count)),
      end: vi.fn(() => { record.ended = true; }) }; }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, raw: encoder, passes };
}

function input(count = 70, revision = 0, objects = buffer("objects", count * GPU_LOD_OBJECT_STRIDE),
  levels = buffer("levels", count * GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE)) { return { objects, levels, count, revision }; }
function view(position: readonly [number, number, number] = [0, 0, 0], cameraJump = false) {
  return { camera: { projection: "perspective" as const, position, forward: [0, 0, 1] as const,
    verticalFovRadians: Math.PI / 2, near: 0.1, far: 1_000 }, viewport: { width: 800, height: 600 }, cameraJump };
}
function publish(selector: GpuLodSelector, result: ReturnType<GpuLodSelector["encode"]>) {
  selector.commit(result); return result;
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_SRC: 2, UNIFORM: 4, COPY_DST: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("GpuLodSelector", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-gpu-lod.wgsl", "--input-kind", "wgsl"],
      { input: GPU_LOD_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toContain("Validation successful");
  });

  it("creates one reusable pipeline and emits deterministic fixed-order records without atomic budgets", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    const first = selector.encode(encoder.encoder, source, view());
    expect(first).toMatchObject({ inputCount: 70, capacity: 128, recordStride: GPU_LOD_OUTPUT_STRIDE,
      historyReset: true, updated: true, budgetMode: "deferred-stable-prefix" });
    expect(first.records.size).toBe(128 * GPU_LOD_OUTPUT_STRIDE); expect(encoder.passes[0]!.dispatches).toEqual([2]);
    expect(f.device.createComputePipeline).toHaveBeenCalledOnce(); expect(GPU_LOD_WGSL).not.toContain("atomic");
    const uniform = new Uint32Array(f.writes[0]!.data); expect([...uniform.slice(12, 16)]).toEqual([70, 128, 1, 0]);
    selector.commit(first);
    expect(selector.encode(encoder.encoder, source, view())).toMatchObject({ updated: false });
    expect(encoder.passes).toHaveLength(1); expect(f.writes).toHaveLength(1);
  });

  it("handles an empty working set without issuing a zero-workgroup dispatch", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session);
    const empty = input(0, 0, buffer("empty objects", GPU_LOD_OBJECT_STRIDE),
      buffer("empty levels", GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE));
    const result = selector.encode(encoder.encoder, empty, view());
    expect(result).toMatchObject({ inputCount: 0, capacity: 1, historyReset: true }); selector.commit(result);
    expect(encoder.raw.beginComputePass).not.toHaveBeenCalled(); selector.dispose();
  });

  it("persists history for continuous views and resets for automatic or explicit camera jumps", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session, { cameraJumpThreshold: 0.35 }), source = input();
    publish(selector, selector.encode(encoder.encoder, source, view()));
    expect(publish(selector, selector.encode(encoder.encoder, { ...source, revision: 1 }, view([0.1, 0, 0])))).toMatchObject({ historyReset: false });
    expect(publish(selector, selector.encode(encoder.encoder, { ...source, revision: 2 }, view([1, 0, 0])))).toMatchObject({ historyReset: true });
    expect(publish(selector, selector.encode(encoder.encoder, { ...source, revision: 3 }, view([1, 0, 0], true)))).toMatchObject({ historyReset: true });
    const resets = f.writes.map(write => new Uint32Array(write.data)[14]); expect(resets).toEqual([1, 0, 1, 1]);
  });

  it("always resets history when projection kind changes, including explicit-cut-only mode", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session, { cameraJumpThreshold: Infinity }), source = input();
    publish(selector, selector.encode(encoder.encoder, source, view()));
    const orthographic = { camera: { projection: "orthographic" as const, position: [0, 0, 0] as const,
      forward: [0, 0, 1] as const, verticalSize: 10, near: 0.1, far: 1_000 }, viewport: { width: 800, height: 600 } };
    expect(publish(selector, selector.encode(encoder.encoder, { ...source, revision: 1 }, orthographic))).toMatchObject({ historyReset: true });
  });

  it("reuses capacity, resets on count/binding changes, then grows and shrinks owned buffers", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session),
      firstInput = input(70, 0, buffer("objects", 100 * GPU_LOD_OBJECT_STRIDE),
        buffer("levels", 100 * GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE));
    publish(selector, selector.encode(encoder.encoder, firstInput, view())); const firstOwned = f.allocated.slice();
    const sameBuffers = { ...firstInput, count: 100, revision: 1 };
    expect(publish(selector, selector.encode(encoder.encoder, sameBuffers, view()))).toMatchObject({ capacity: 128, historyReset: true });
    expect(f.allocated).toHaveLength(3);
    const replacement = input(100, 2);
    expect(publish(selector, selector.encode(encoder.encoder, replacement, view()))).toMatchObject({ capacity: 128, historyReset: true });
    expect(f.allocated).toHaveLength(3);
    const large = input(300, 3); expect(publish(selector, selector.encode(encoder.encoder, large, view()))).toMatchObject({ capacity: 512 });
    expect(firstOwned.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    const largeOwned = f.allocated.slice(-3), small = input(64, 4);
    expect(publish(selector, selector.encode(encoder.encoder, small, view()))).toMatchObject({ capacity: 64, historyReset: true });
    expect(largeOwned.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("enforces revisions, buffer ABI, camera ranges, and device capacity before encoding", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    publish(selector, selector.encode(encoder.encoder, source, view()));
    expect(() => selector.encode(encoder.encoder, { ...source, revision: -1 }, view())).toThrow("revision");
    expect(() => selector.encode(encoder.encoder, { ...source, objects: buffer("new", source.objects.size) }, view())).toThrow("without a revision");
    expect(() => selector.encode(encoder.encoder, { ...source, revision: 1, objects: buffer("short", 4) }, view())).toThrow("too small");
    expect(() => selector.encode(encoder.encoder, { ...source, revision: 1 }, { ...view(), viewport: { width: 0, height: 1 } })).toThrow("width");
    expect(() => selector.encode(encoder.encoder, { ...source, revision: 1 }, { ...view(), camera: { ...view().camera, forward: [0, 0, 0] } })).toThrow("zero");
  });

  it("rolls back partial growth, preserves active resources on write failure, and never destroys borrowed inputs", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    publish(selector, selector.encode(encoder.encoder, source, view())); const active = f.allocated.slice(), borrowed = [source.objects, source.levels] as FakeBuffer[];
    f.device.createBuffer.mockImplementationOnce(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    }).mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => selector.encode(encoder.encoder, input(300, 1), view())).toThrow("allocation failed");
    expect(f.allocated.at(-1)!.destroy).toHaveBeenCalledOnce(); expect(active.every(resource => resource.destroy.mock.calls.length === 0)).toBe(true);
    f.device.createBuffer.mockImplementation(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    });
    f.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("write failed"); });
    expect(() => selector.encode(encoder.encoder, { ...source, revision: 1 }, view([0.1, 0, 0]))).toThrow("write failed");
    expect(active.every(resource => resource.destroy.mock.calls.length === 0)).toBe(true);
    selector.dispose(); selector.dispose(); expect(active.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    expect(borrowed.every(resource => resource.destroy.mock.calls.length === 0)).toBe(true);
  });

  it("releases outputs on device loss and rejects use after disposal", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    selector.encode(encoder.encoder, source, view()); const resources = f.allocated.slice();
    f.rawSession.state = "lost"; expect(() => selector.encode(encoder.encoder, { ...source, revision: 1 }, view())).toThrow("not ready");
    expect(resources.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    selector.dispose(); expect(() => selector.encode(encoder.encoder, source, view())).toThrow("disposed");
  });

  it("publishes only submitted selections and allows an unsubmitted revision to retry", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    const abandoned = selector.encode(encoder.encoder, source, view());
    expect(() => selector.encode(encoder.encoder, source, view())).toThrow("pending submission");
    selector.cancel(abandoned);
    expect(abandoned.records.destroy).toHaveBeenCalledOnce();
    const retry = selector.encode(encoder.encoder, source, view());
    expect(retry).toMatchObject({ updated: true, historyReset: true });
    selector.commit(retry);
    expect(selector.encode(encoder.encoder, source, view())).toMatchObject({ updated: false });
    expect(() => selector.commit(abandoned)).toThrow("not pending");
  });

  it("keeps committed history and resources when a replacement encoder is cancelled", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    publish(selector, selector.encode(encoder.encoder, source, view())); const committed = f.allocated.slice();
    const replacement = selector.encode(encoder.encoder, input(300, 1), view([0.1, 0, 0]));
    const staged = f.allocated.slice(-3); expect(replacement.capacity).toBe(512); selector.cancel(replacement);
    expect(staged.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    expect(committed.every(resource => resource.destroy.mock.calls.length === 0)).toBe(true);
    const retry = selector.encode(encoder.encoder, { ...source, revision: 1 }, view([0.1, 0, 0]));
    expect(retry).toMatchObject({ capacity: 128, historyReset: false }); selector.commit(retry);
  });

  it("invalidates hysteresis after uncertain submission and makes resetHistory effective", () => {
    const f = fixture(), encoder = encoderFixture(), selector = new GpuLodSelector(f.session), source = input();
    publish(selector, selector.encode(encoder.encoder, source, view()));
    const uncertain = selector.encode(encoder.encoder, { ...source, revision: 1 }, view([0.1, 0, 0]));
    expect(uncertain.historyReset).toBe(false); selector.fail(uncertain);
    const retry = selector.encode(encoder.encoder, { ...source, revision: 1 }, view([0.1, 0, 0]));
    expect(retry.historyReset).toBe(true); selector.commit(retry);
    selector.resetHistory();
    const reset = selector.encode(encoder.encoder, { ...source, revision: 2 }, view([0.1, 0, 0]));
    expect(reset.historyReset).toBe(true); selector.commit(reset);
  });
});
