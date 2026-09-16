import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMeshlets, expandMeshletIndices, isMirroredMeshletTransform } from "../geometry/index.js";
import type { DeviceSession } from "./deviceSession.js";
import { MeshletIndexBuffer } from "./meshletIndexBuffer.js";
import { MeshletIndirectExecutor, MESHLET_INDIRECT_WGSL } from "./meshletIndirectExecutor.js";
import type { MeshletCullingGpuResult } from "./meshletCullingTypes.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
function buffer(label: string, size: number, usage = GPUBufferUsage.STORAGE): FakeBuffer {
  return { label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
}

function fixture() {
  const owned = new Set<FakeBuffer>(), allocated: FakeBuffer[] = [], writes: Array<{ buffer: GPUBuffer; data: ArrayBufferView }> = [];
  const bundleEncoders: Array<{ draws: Array<[GPUBuffer, number]>; finish: ReturnType<typeof vi.fn> }> = [];
  const queue = { writeBuffer: vi.fn((target: GPUBuffer, _offset: number, data: ArrayBufferView) => writes.push({ buffer: target, data })) };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxUniformBufferBindingSize: 65_536, maxComputeWorkgroupsPerDimension: 65_535,
      maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256,
      maxColorAttachments: 8, maxVertexBuffers: 8, maxBindGroups: 4 }, queue,
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); allocated.push(value); return value;
    }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
    createRenderBundleEncoder: vi.fn(() => {
      const draws: Array<[GPUBuffer, number]> = [], finish = vi.fn(() => ({ label: "bundle" }));
      const raw = { draws, finish }; bundleEncoders.push(raw);
      return { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(),
        drawIndexedIndirect: vi.fn((commands: GPUBuffer, offset: number) => draws.push([commands, offset])), finish };
    }),
  };
  const session = { state: "ready", device,
    own<T extends FakeBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: FakeBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, queue, session: session as unknown as DeviceSession, rawSession: session, owned, allocated, writes, bundleEncoders };
}

function encoderFixture() {
  const passes: Array<{ pipeline: unknown[]; bindGroup: unknown[]; dispatch: number[] }> = [];
  const encoder = { beginComputePass: vi.fn(() => {
    const record = { pipeline: [] as unknown[], bindGroup: [] as unknown[], dispatch: [] as number[] }; passes.push(record);
    return { setPipeline: vi.fn((value: unknown) => record.pipeline.push(value)), setBindGroup: vi.fn((...value: unknown[]) => record.bindGroup.push(value)),
      dispatchWorkgroups: vi.fn((count: number) => record.dispatch.push(count)), end: vi.fn() };
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, raw: encoder, passes };
}

function culling(capacity = 64, inputCount = capacity, updated = true): MeshletCullingGpuResult {
  return { mode: "gpu", inputCount, capacity, visibleIndices: buffer("indices", capacity * 4),
    visibleCount: buffer("count", 4), visibleRecords: buffer("records", capacity * 32), recordStride: 32,
    hizTested: false, normalConeTested: true, updated };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, INDIRECT: 2, COPY_SRC: 4, UNIFORM: 8, COPY_DST: 16, INDEX: 32, VERTEX: 64 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("meshlet indirect execution", () => {
  it("closes the compute pass when dispatch fails", () => {
    const f = fixture(), executor = new MeshletIndirectExecutor(f.session);
    const end = vi.fn(), pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), end,
      dispatchWorkgroups: vi.fn(() => { throw Error("dispatch rejected"); }) };
    const encoder = { beginComputePass: () => pass } as unknown as GPUCommandEncoder;
    expect(() => executor.encode(encoder, culling(), { expandedIndexCount: 192 })).toThrow("dispatch rejected");
    expect(end).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
  });

  it("detaches and releases every output even when destruction throws", () => {
    const f = fixture(), executor = new MeshletIndirectExecutor(f.session), encoder = encoderFixture();
    executor.encode(encoder.encoder, culling(), { expandedIndexCount: 192 });
    f.allocated[0]!.destroy.mockImplementation(() => { throw Error("destroy rejected"); });
    expect(() => executor.dispose()).toThrow();
    expect(f.owned.size).toBe(0); expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
    expect(() => executor.dispose()).not.toThrow();
  });

  it("keeps replacement buffers alive after retirement failure and re-encodes on retry", () => {
    const f = fixture(), executor = new MeshletIndirectExecutor(f.session), encoder = encoderFixture();
    executor.encode(encoder.encoder, culling(), { expandedIndexCount: 192 });
    f.allocated[0]!.destroy.mockImplementation(() => { throw Error("retirement rejected"); });
    const next = culling(128);
    expect(() => executor.encode(encoder.encoder, next, { expandedIndexCount: 384 })).toThrow();
    expect(f.owned.size).toBe(2);
    expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
    expect(f.allocated.slice(2).every(value => value.destroy.mock.calls.length === 0)).toBe(true);
    const count = f.allocated.length;
    expect(executor.encode(encoder.encoder, next, { expandedIndexCount: 384 }).updated).toBe(true);
    expect(f.allocated).toHaveLength(count); executor.dispose(); expect(f.owned.size).toBe(0);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-meshlet-indirect.wgsl", "--input-kind", "wgsl"], { input: MESHLET_INDIRECT_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("Validation successful");
  });

  it("expands standard and mirrored winding into contiguous global uint32 index ranges", () => {
    const meshlets = buildMeshlets({ positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]) }, { maxTriangles: 1 });
    const standard = expandMeshletIndices(meshlets), mirrored = expandMeshletIndices(meshlets, "flip");
    expect([...standard.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...mirrored.indices]).toEqual([0, 2, 1, 0, 3, 2]);
    expect([...standard.ranges]).toEqual([0, 3, 3, 3]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(isMirroredMeshletTransform(identity)).toBe(false);
    identity[0] = -1; expect(isMirroredMeshletTransform(identity)).toBe(true);
    identity[0] = 0; expect(() => isMirroredMeshletTransform(identity)).toThrow("Singular");
  });

  it("uploads expanded indices transactionally and disposes idempotently", () => {
    const f = fixture();
    const meshlets = buildMeshlets({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint16Array([0, 1, 2]) });
    const expanded = expandMeshletIndices(meshlets), uploaded = new MeshletIndexBuffer(f.session, expanded);
    expect(uploaded.indexCount).toBe(3); expect(uploaded.winding).toBe("preserve");
    expect(uploaded.buffer.usage & GPUBufferUsage.INDEX).not.toBe(0); expect(f.writes).toHaveLength(1);
    uploaded.dispose(); uploaded.dispose(); expect((uploaded.buffer as FakeBuffer).destroy).toHaveBeenCalledOnce();
    f.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("upload failed"); });
    expect(() => new MeshletIndexBuffer(f.session, expanded)).toThrow("upload failed");
    expect(f.allocated.at(-1)!.destroy).toHaveBeenCalledOnce();
  });

  it("writes one fixed-capacity command pass and verifies firstIndex/baseVertex/source-instance mapping", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session), source = culling();
    const plan = executor.encode(encoder.encoder, source, { expandedIndexCount: 192, firstIndexBase: 5,
      baseVertex: -3, baseInstance: 11, instanceMapping: "source-meshlet" });
    expect(plan).toMatchObject({ capacity: 64, firstIndexBase: 5, baseVertex: -3, baseInstance: 11,
      instanceMapping: "source-meshlet", commandStride: 20, updated: true });
    expect(f.allocated).toHaveLength(2); expect(f.device.createComputePipeline).toHaveBeenCalledOnce();
    expect(encoder.passes[0]!.dispatch).toEqual([1]);
    expect([...new Uint32Array(f.writes[0]!.data.buffer, f.writes[0]!.data.byteOffset, 8)])
      .toEqual([64, 64, 192, 5, 0xffff_fffd, 11, 1, 64]);
    const writes = f.writes.length, passes = encoder.passes.length;
    expect(executor.encode(encoder.encoder, source, { expandedIndexCount: 192, firstIndexBase: 5,
      baseVertex: -3, baseInstance: 11, instanceMapping: "source-meshlet" })).toMatchObject({ updated: false });
    expect(f.writes).toHaveLength(writes); expect(encoder.passes).toHaveLength(passes);
  });

  it("records every indirect slot once and reuses a structurally identical RenderBundle", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session);
    const plan = executor.encode(encoder.encoder, culling(), { expandedIndexCount: 192 });
    const pipeline = {} as GPURenderPipeline, indexBuffer = buffer("expanded", 192 * 4, GPUBufferUsage.INDEX);
    const vertexBuffer = buffer("vertices", 1024, GPUBufferUsage.VERTEX), bindGroup = {} as GPUBindGroup;
    const request = { pipeline, indexBuffer, vertexBuffers: [{ slot: 0, buffer: vertexBuffer }],
      bindGroups: [{ index: 0, bindGroup }], colorFormats: ["rgba8unorm" as const] };
    const first = executor.prepareBundle(plan, request);
    expect(first).toMatchObject({ drawCount: 64, reused: false });
    expect(f.bundleEncoders[0]!.draws).toHaveLength(64);
    expect(f.bundleEncoders[0]!.draws.map(value => value[1])).toEqual(Array.from({ length: 64 }, (_, index) => index * 20));
    const second = executor.prepareBundle(plan, { ...request, vertexBuffers: [...request.vertexBuffers] });
    expect(second.bundle).toBe(first.bundle); expect(second.reused).toBe(true);
    const pass = { executeBundles: vi.fn() } as unknown as GPURenderPassEncoder;
    expect(executor.execute(pass, plan, request).reused).toBe(true);
    expect(pass.executeBundles).toHaveBeenCalledWith([first.bundle]);
    (indexBuffer as unknown as { mapState: GPUBufferMapState }).mapState = "mapped";
    expect(() => executor.prepareBundle(plan, request)).toThrow("index buffer");
  });

  it("rejects a superseded plan even when command capacity and buffer identity were reused", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session), source = culling();
    const old = executor.encode(encoder.encoder, source, { expandedIndexCount: 192 });
    const current = executor.encode(encoder.encoder, { ...source, updated: true }, { expandedIndexCount: 192, baseInstance: 1 });
    const request = { pipeline: {} as GPURenderPipeline, indexBuffer: buffer("index", 768, GPUBufferUsage.INDEX),
      colorFormats: ["rgba8unorm" as const] };
    expect(() => executor.prepareBundle(old, request)).toThrow("stale");
    expect(() => executor.prepareBundle(current, request)).not.toThrow();
  });

  it("supports all instance mappings and rejects address/ABI/capacity overflow before encoding", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session), source = culling();
    for (const [revision, instanceMapping, code] of [[0, "constant", 0], [1, "source-meshlet", 1], [2, "visible-order", 2]] as const) {
      const current = { ...source, updated: true, inputCount: 64, visibleRecords: revision ? buffer(`records${revision}`, 64 * 32) : source.visibleRecords };
      executor.encode(encoder.encoder, current, { expandedIndexCount: 192, baseInstance: 7, instanceMapping });
      expect(new Uint32Array(f.writes.at(-1)!.data.buffer, f.writes.at(-1)!.data.byteOffset, 8)[6]).toBe(code);
    }
    expect(() => executor.encode(encoder.encoder, source, { expandedIndexCount: 100 })).toThrow("cannot cover");
    expect(() => executor.encode(encoder.encoder, source, { expandedIndexCount: 192, firstIndexBase: 0xffff_ffff })).toThrow("overflows");
    expect(() => executor.encode(encoder.encoder, source, { expandedIndexCount: 192, baseVertex: 0x8000_0000 })).toThrow("baseVertex");
    expect(() => executor.encode(encoder.encoder, source, { expandedIndexCount: 192,
      baseInstance: 0xffff_ffff, instanceMapping: "source-meshlet" })).toThrow("firstInstance");
    expect(() => executor.encode(encoder.encoder, { ...source, capacity: 131_072 }, { expandedIndexCount: 192 })).toThrow("Invalid GPU");
  });

  it("reallocates on capacity changes, invalidates stale plans, and keeps borrowed culling buffers alive", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session), firstSource = culling();
    const first = executor.encode(encoder.encoder, firstSource, { expandedIndexCount: 192 }), firstOwned = f.allocated.slice();
    const secondSource = culling(128), second = executor.encode(encoder.encoder, secondSource, { expandedIndexCount: 384 });
    expect(second.capacity).toBe(128); expect(firstOwned.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    const request = { pipeline: {} as GPURenderPipeline, indexBuffer: buffer("index", 1536, GPUBufferUsage.INDEX),
      colorFormats: ["rgba8unorm" as const] };
    expect(() => executor.prepareBundle(first, request)).toThrow("stale");
    expect(() => executor.prepareBundle(second, request)).not.toThrow();
    expect((firstSource.visibleRecords as FakeBuffer).destroy).not.toHaveBeenCalled();
  });

  it("rolls back partial allocation and invalidates reused commands after write failure", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session), source = culling();
    f.device.createBuffer.mockImplementationOnce(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    }).mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => executor.encode(encoder.encoder, source, { expandedIndexCount: 192 })).toThrow("allocation failed");
    expect(f.allocated[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    f.device.createBuffer.mockImplementation(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    });
    executor.encode(encoder.encoder, source, { expandedIndexCount: 192 }); const active = f.allocated.slice(-2);
    f.queue.writeBuffer.mockImplementation(() => { throw new Error("write failed"); });
    expect(() => executor.encode(encoder.encoder, { ...source, updated: true }, { expandedIndexCount: 192, baseInstance: 1 })).toThrow("write failed");
    expect(active.every(value => value.destroy.mock.calls.length === 1)).toBe(true); expect(f.owned.size).toBe(0);
  });

  it("releases commands on device loss/dispose and rejects use after disposal", () => {
    const f = fixture(), encoder = encoderFixture(), executor = new MeshletIndirectExecutor(f.session), source = culling();
    executor.encode(encoder.encoder, source, { expandedIndexCount: 192 }); const outputs = f.allocated.slice();
    f.rawSession.state = "lost";
    expect(() => executor.encode(encoder.encoder, { ...source, updated: true }, { expandedIndexCount: 192 })).toThrow("not ready");
    expect(outputs.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect((source.visibleRecords as FakeBuffer).destroy).not.toHaveBeenCalled();
    executor.dispose(); executor.dispose();
    expect(() => executor.encode(encoder.encoder, source, { expandedIndexCount: 192 })).toThrow("disposed");
  });
});
