import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { HiZOcclusionIndirectResult } from "./hiZOcclusionCulling.js";
import { HiZInstanceCompactor, HI_Z_INSTANCE_COMPACTION_WGSL } from "./hiZInstanceCompactor.js";

interface FakeBuffer extends GPUBuffer {
  readonly label: string;
  readonly destroy: ReturnType<typeof vi.fn>;
}

function buffer(label: string, size: number, usage = GPUBufferUsage.STORAGE): FakeBuffer {
  return { label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
}

function visibility(count: number, capacity = 2 ** Math.ceil(Math.log2(count))): HiZOcclusionIndirectResult {
  return Object.freeze({ mode: "indirect", inputCount: count, capacity,
    visibleIndices: buffer("visible indices", capacity * 4), visibleCount: buffer("visible count", 4),
    indirect: buffer("indirect", 20, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT),
    historyReset: false, updated: true });
}

function input(count = 128, capacity = count, result = visibility(count)) {
  return { instances: buffer("instances", capacity * 144),
    previousTransforms: buffer("previous", capacity * 48), count, capacity, visibility: result };
}

function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: FakeBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65_535 },
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label, entries }: { label: string; entries: unknown[] }) => ({ label, entries })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); allocated.push(value); return value;
    }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, session: session as unknown as DeviceSession, rawSession: session, owned, allocated };
}

function encoderFixture() {
  const passes: Array<{ pipeline?: string; bindGroup?: unknown; dispatch?: number; ended: boolean }> = [];
  const encoder = { beginComputePass: vi.fn(() => {
    const record = { ended: false } as (typeof passes)[number]; passes.push(record);
    return { setPipeline: vi.fn((value: { label: string }) => { record.pipeline = value.label; }),
      setBindGroup: vi.fn((_slot: number, value: unknown) => { record.bindGroup = value; }),
      dispatchWorkgroups: vi.fn((value: number) => { record.dispatch = value; }),
      end: vi.fn(() => { record.ended = true; }) };
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, raw: encoder, passes };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, VERTEX: 2, COPY_SRC: 4, INDIRECT: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Hi-Z PBR instance compaction", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-hiz-instance-compaction.wgsl", "--input-kind", "wgsl"],
      { input: HI_Z_INSTANCE_COMPACTION_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0);
    expect(validation.stderr).toBe(""); expect(validation.stdout).toContain("Validation successful");
  });

  it("encodes both PBR streams in one pass and reuses Hi-Z indirect arguments", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session);
    const source = input(129, 256), result = compactor.encode(commands.encoder, source);
    expect(result).toMatchObject({ inputCount: 129, capacity: 256 });
    expect(result.indirect).toBe(source.visibility.indirect); expect(result.visibleCount).toBe(source.visibility.visibleCount);
    expect(result.instances.usage).toBe(GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC);
    expect(result.previousTransforms.usage).toBe(result.instances.usage);
    expect(f.allocated.map(value => [value.label, value.size])).toEqual([
      ["Deep Hi-Z compacted instances", 256 * 144], ["Deep Hi-Z compacted previous transforms", 256 * 48],
    ]);
    expect(commands.passes).toEqual([{ pipeline: "Deep Hi-Z instance compaction pipeline",
      bindGroup: expect.anything(), dispatch: 3, ended: true }]);
    const entries = (f.device.createBindGroup.mock.calls[0]![0] as { entries: GPUBindGroupEntry[] }).entries;
    expect(entries.slice(0, 4).map(entry => (entry.resource as GPUBufferBinding).size)).toEqual([129 * 144, 129 * 48, 256 * 4, 4]);
  });

  it("reuses owned output, rebinds changed borrowed inputs, and still refreshes every frame", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session);
    const firstInput = input(129, 256), first = compactor.encode(commands.encoder, firstInput);
    const repeated = compactor.encode(commands.encoder, firstInput);
    expect(repeated.instances).toBe(first.instances); expect(f.device.createBindGroup).toHaveBeenCalledOnce();
    const changed = input(128, 256, visibility(128, 128));
    const rebound = compactor.encode(commands.encoder, changed);
    expect(rebound.instances).toBe(first.instances); expect(rebound.capacity).toBe(256);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(2); expect(commands.passes).toHaveLength(3);
    expect((first.instances as FakeBuffer).destroy).not.toHaveBeenCalled();
  });

  it("grows and shrinks output capacity without retaining superseded buffers", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session);
    const first = compactor.encode(commands.encoder, input(128)), firstOwned = f.allocated.slice();
    const grown = compactor.encode(commands.encoder, input(257, 257, visibility(257, 512)));
    expect(grown.capacity).toBe(512); expect(grown.instances).not.toBe(first.instances);
    expect(firstOwned.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    const grownOwned = f.allocated.slice(2);
    const shrunk = compactor.encode(commands.encoder, input(64));
    expect(shrunk.capacity).toBe(64); expect(grownOwned.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.owned.size).toBe(2);
  });

  it("rejects invalid ABI, ranges, result identity, device limits, and dispatch before encoding", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session);
    expect(() => compactor.encode(commands.encoder, input(0, 1, visibility(1)))).toThrow("count or capacity");
    expect(() => compactor.encode(commands.encoder, input(129, 128))).toThrow("count or capacity");
    expect(() => compactor.encode(commands.encoder, { ...input(), visibility: visibility(127, 128) })).toThrow("does not match");
    expect(() => compactor.encode(commands.encoder, { ...input(), instances: buffer("short", 127 * 144) })).toThrow("instance source");
    const mapped = buffer("mapped", 128 * 48); (mapped as unknown as { mapState: GPUBufferMapState }).mapState = "mapped";
    expect(() => compactor.encode(commands.encoder, { ...input(), previousTransforms: mapped })).toThrow("previous-transform");
    const wrongIndirect = visibility(128); (wrongIndirect.indirect as unknown as { usage: number }).usage = GPUBufferUsage.STORAGE;
    expect(() => compactor.encode(commands.encoder, input(128, 128, wrongIndirect))).toThrow("indirect arguments");
    f.device.limits.maxStorageBufferBindingSize = 128 * 144 - 1;
    expect(() => compactor.encode(commands.encoder, input())).toThrow("storage-buffer limits");
    f.device.limits.maxStorageBufferBindingSize = 1 << 30; f.device.limits.maxComputeWorkgroupsPerDimension = 1;
    expect(() => compactor.encode(commands.encoder, input())).toThrow("dispatch");
    expect(f.allocated).toHaveLength(0); expect(commands.raw.beginComputePass).not.toHaveBeenCalled();
  });

  it("rolls back partial growth while preserving the last usable output", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session);
    const active = compactor.encode(commands.encoder, input(128));
    f.device.createBuffer.mockImplementationOnce(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    }).mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => compactor.encode(commands.encoder, input(257, 257, visibility(257, 512)))).toThrow("allocation failed");
    expect(f.allocated.at(-1)!.destroy).toHaveBeenCalledOnce();
    expect((active.instances as FakeBuffer).destroy).not.toHaveBeenCalled();
    f.device.createBuffer.mockImplementation(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    });
    expect(compactor.encode(commands.encoder, input(128)).instances).toBe(active.instances);
  });

  it("rolls back a complete candidate when binding or command encoding fails", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session);
    const active = compactor.encode(commands.encoder, input(128));
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    expect(() => compactor.encode(commands.encoder, input(257, 257, visibility(257, 512)))).toThrow("binding failed");
    expect(f.allocated.slice(-2).every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect((active.instances as FakeBuffer).destroy).not.toHaveBeenCalled();
    commands.raw.beginComputePass.mockImplementationOnce(() => { throw new Error("encode failed"); });
    expect(() => compactor.encode(commands.encoder, input(257, 257, visibility(257, 512)))).toThrow("encode failed");
    expect(f.allocated.slice(-2).every(value => value.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("releases only owned outputs on device loss and idempotent disposal", () => {
    const f = fixture(), commands = encoderFixture(), compactor = new HiZInstanceCompactor(f.session), source = input();
    const result = compactor.encode(commands.encoder, source); f.rawSession.state = "lost";
    expect(() => compactor.encode(commands.encoder, source)).toThrow("not ready");
    expect((result.instances as FakeBuffer).destroy).toHaveBeenCalledOnce();
    expect((result.previousTransforms as FakeBuffer).destroy).toHaveBeenCalledOnce();
    expect((source.instances as FakeBuffer).destroy).not.toHaveBeenCalled();
    expect((source.previousTransforms as FakeBuffer).destroy).not.toHaveBeenCalled();
    expect((source.visibility.visibleIndices as FakeBuffer).destroy).not.toHaveBeenCalled();
    expect((source.visibility.visibleCount as FakeBuffer).destroy).not.toHaveBeenCalled();
    expect((source.visibility.indirect as FakeBuffer).destroy).not.toHaveBeenCalled();
    compactor.dispose(); compactor.dispose();
    expect(() => compactor.encode(commands.encoder, source)).toThrow("disposed");
  });
});
