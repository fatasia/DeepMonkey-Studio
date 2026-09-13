import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { HiZResult } from "./hiZPyramid.js";
import { HI_Z_OCCLUSION_MIN_INSTANCES, HI_Z_OCCLUSION_WGSL, HiZOcclusionCuller,
  hiZOcclusionMip, hiZOcclusionVisible, projectHiZOcclusionAabb } from "./hiZOcclusionCulling.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
interface FakeTexture extends GPUTexture { readonly destroy: ReturnType<typeof vi.fn>; readonly createView: ReturnType<typeof vi.fn> }

function buffer(label: string, size: number, usage = GPUBufferUsage.STORAGE): FakeBuffer {
  return { label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
}

function hiz(revision = 0, reversedZ = true, width = 64, height = 64): HiZResult {
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = { label: "hiz", width, height, depthOrArrayLayers: 1, mipLevelCount, sampleCount: 1,
    dimension: "2d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING,
    createView: vi.fn((descriptor = {}) => ({ descriptor })), destroy: vi.fn() } as unknown as FakeTexture;
  return { texture, format: "r32float", width, height, mipLevelCount,
    levels: Array.from({ length: mipLevelCount }, (_, level) => ({ level, width: Math.max(1, width >> level),
      height: Math.max(1, height >> level), view: {} as GPUTextureView })),
    sourceRevision: revision, reversedZ, reduction: reversedZ ? "min" : "max", updated: true };
}

function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: FakeBuffer[] = [], writes: Array<{ buffer: GPUBuffer; data: ArrayBuffer | ArrayBufferView }> = [];
  const queue = { writeBuffer: vi.fn((target: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => writes.push({ buffer: target, data })) };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxTextureDimension2D: 16_384,
      maxComputeWorkgroupsPerDimension: 65_535 }, queue,
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => { const value = buffer(label ?? "", size, usage); allocated.push(value); return value; }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, queue, session: session as unknown as DeviceSession, rawSession: session, owned, allocated, writes };
}

function encoderFixture() {
  const passes: Array<{ pipeline: string[]; dispatch: Array<[number, number?, number?]> }> = [];
  const encoder = { clearBuffer: vi.fn(), beginComputePass: vi.fn(() => {
    const record = { pipeline: [] as string[], dispatch: [] as Array<[number, number?, number?]> }; passes.push(record);
    return { setBindGroup: vi.fn(), setPipeline: vi.fn((pipeline: { label: string }) => record.pipeline.push(pipeline.label)),
      dispatchWorkgroups: vi.fn((...args: [number, number?, number?]) => record.dispatch.push(args)), end: vi.fn() };
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, raw: encoder, passes };
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
function request(count = HI_Z_OCCLUSION_MIN_INSTANCES, revision = 0) {
  return { instances: buffer("instances", count * 144), bounds: buffer("bounds", count * 16), count, revision, indexCount: 36 };
}
function view(pyramid = hiz(), matrix: readonly number[] = identity) {
  return { viewProjection: matrix, cameraPosition: [0, 0, 5] as const, viewport: [64, 64] as const,
    hiz: pyramid, reversedZ: pyramid.reversedZ };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, INDIRECT: 8, UNIFORM: 16 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Hi-Z occlusion culling", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-hiz-occlusion.wgsl", "--input-kind", "wgsl"], { input: HI_Z_OCCLUSION_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("Validation successful");
  });

  it("keeps min/max comparisons and conservative mip selection correct on the CPU reference", () => {
    expect(hiZOcclusionMip(1, 1, 8)).toBe(0); expect(hiZOcclusionMip(9, 3, 8)).toBe(4);
    expect(hiZOcclusionVisible(0.8, [0.4, 0.5, 0.6, 0.7], false)).toBe(false);
    expect(hiZOcclusionVisible(0.5, [0.4, 0.5, 0.6, 0.7], false)).toBe(true);
    expect(hiZOcclusionVisible(0.2, [0.6, 0.5, 0.4, 0.3], true)).toBe(false);
    expect(hiZOcclusionVisible(0.5, [0.6, 0.5, 0.4, 0.3], true)).toBe(true);
    expect(hiZOcclusionVisible(Number.NaN, [0.5], true)).toBe(true);
  });

  it("keeps ambiguous AABBs visible but rejects a wholly offscreen valid projection", () => {
    expect(projectHiZOcclusionAabb([0, 0, 0.5], 0.1, identity, [0, 0, 0.5], [64, 64], 7, false))
      .toMatchObject({ testable: false, reason: "camera-inside" });
    expect(projectHiZOcclusionAabb([0, 0, 0.05], 0.1, identity, [0, 0, 5], [64, 64], 7, false))
      .toMatchObject({ testable: false, reason: "clip-boundary" });
    expect(projectHiZOcclusionAabb([3, 0, 0.5], 0.1, identity, [0, 0, 5], [64, 64], 7, false))
      .toMatchObject({ testable: false, reason: "screen-outside", culled: true });
    expect(HI_Z_OCCLUSION_WGSL).toContain("wholly outside one clip edge is safely invisible");
    const standard = projectHiZOcclusionAabb([0, 0, 0.5], 0.1, identity, [0, 0, 5], [64, 64], 7, false);
    const reversed = projectHiZOcclusionAabb([0, 0, 0.5], 0.1, identity, [0, 0, 5], [64, 64], 7, true);
    expect(standard).toMatchObject({ testable: true, objectNearDepth: 0.4 });
    expect(reversed).toMatchObject({ testable: true, objectNearDepth: 0.6 });
  });

  it("returns the small-batch direct contract without allocating or encoding", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session);
    expect(culler.encode(encoder.encoder, request(HI_Z_OCCLUSION_MIN_INSTANCES - 1), view())).toEqual({
      mode: "direct", inputCount: HI_Z_OCCLUSION_MIN_INSTANCES - 1, updated: false,
    });
    expect(f.device.createBuffer).not.toHaveBeenCalled(); expect(encoder.raw.beginComputePass).not.toHaveBeenCalled();
  });

  it("encodes visible indices, count, and indirect output with cached exact-frame reuse", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request(), pyramid = hiz();
    const result = culler.encode(encoder.encoder, input, view(pyramid));
    expect(result.mode).toBe("indirect"); if (result.mode !== "indirect") return;
    expect(result.capacity).toBe(128); expect(result.historyReset).toBe(true);
    expect(encoder.passes).toHaveLength(1); expect(encoder.passes[0]!.dispatch).toEqual([[2], [1]]);
    expect(encoder.passes[0]!.pipeline).toEqual(["Deep Hi-Z occlusion pipeline", "Deep Hi-Z occlusion indirect pipeline"]);
    expect(encoder.raw.clearBuffer.mock.calls.map(call => call[0])).toEqual([result.visibleCount, f.allocated.find(value => value.label === "Deep Hi-Z visibility history")]);
    expect(f.allocated).toHaveLength(5); expect(f.device.createShaderModule).toHaveBeenCalledOnce();
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(2);
    const indirectWrite = f.writes.find(item => item.buffer === result.indirect)!;
    expect(Array.from(new Uint32Array(indirectWrite.data as ArrayBuffer))).toEqual([36, 0, 0, 0, 0]);
    const writes = f.writes.length, passes = encoder.passes.length;
    const cached = culler.encode(encoder.encoder, input, view(pyramid));
    expect(cached.mode).toBe("indirect"); expect(cached.updated).toBe(false);
    expect(f.writes).toHaveLength(writes); expect(encoder.passes).toHaveLength(passes); expect(f.allocated).toHaveLength(5);
  });

  it("applies one-frame temporal history and resets it for Hi-Z changes, camera jumps, and cuts", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request();
    const pyramid0 = hiz(0), pyramid1 = hiz(1);
    const first = culler.encode(encoder.encoder, input, view(pyramid0)); expect(first.mode === "indirect" && first.historyReset).toBe(true);
    encoder.raw.clearBuffer.mockClear();
    const continuous = culler.encode(encoder.encoder, { ...input, revision: 1 }, view(pyramid0));
    expect(continuous.mode === "indirect" && continuous.historyReset).toBe(false);
    expect(encoder.raw.clearBuffer).toHaveBeenCalledTimes(1);
    encoder.raw.clearBuffer.mockClear();
    const changedHiZ = culler.encode(encoder.encoder, { ...input, revision: 2 }, view(pyramid1));
    expect(changedHiZ.mode === "indirect" && changedHiZ.historyReset).toBe(true);
    expect(encoder.raw.clearBuffer).toHaveBeenCalledTimes(2);
    encoder.raw.clearBuffer.mockClear();
    const jumped = [...identity]; jumped[12] = 2;
    const cameraJump = culler.encode(encoder.encoder, { ...input, revision: 3 }, view(pyramid1, jumped));
    expect(cameraJump.mode === "indirect" && cameraJump.historyReset).toBe(true);
    encoder.raw.clearBuffer.mockClear();
    const cut = culler.encode(encoder.encoder, { ...input, revision: 4 }, view(pyramid1, jumped), { cameraCut: true });
    expect(cut.mode === "indirect" && cut.historyReset).toBe(true);
  });

  it("retains temporal visibility when only the contents revision of the same Hi-Z texture advances", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request();
    const firstPyramid = hiz(0);
    culler.encode(encoder.encoder, input, view(firstPyramid));
    encoder.raw.clearBuffer.mockClear();
    const nextPyramid = { ...firstPyramid, sourceRevision: 1, updated: true };
    const next = culler.encode(encoder.encoder, { ...input, revision: 1 }, view(nextPyramid));
    expect(next.mode === "indirect" && next.historyReset).toBe(false);
    expect(encoder.raw.clearBuffer).toHaveBeenCalledTimes(1);
  });

  it("rebinds borrowed inputs without rebuilding pipelines and rejects silent revision changes", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request(), pyramid = hiz();
    culler.encode(encoder.encoder, input, view(pyramid)); const bindingCount = f.device.createBindGroup.mock.calls.length;
    expect(() => culler.encode(encoder.encoder, { ...input, instances: buffer("other", input.instances.size) }, view(pyramid))).toThrow("without a revision");
    const rebound = culler.encode(encoder.encoder, { ...input, instances: buffer("other", input.instances.size), revision: 1 }, view(pyramid));
    expect(rebound.mode).toBe("indirect"); expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount + 1);
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(2); expect(input.instances.destroy).not.toHaveBeenCalled();
  });

  it("grows and shrinks capacity transactionally, then releases outputs on direct fallback", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), pyramid = hiz();
    const large = request(513), first = culler.encode(encoder.encoder, large, view(pyramid));
    expect(first.mode === "indirect" && first.capacity).toBe(1024); const firstBuffers = f.allocated.slice();
    const small = request(128, 1), second = culler.encode(encoder.encoder, small, view(pyramid));
    expect(second.mode === "indirect" && second.capacity).toBe(128);
    expect(firstBuffers.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    const secondBuffers = f.allocated.slice(firstBuffers.length);
    culler.encode(encoder.encoder, request(127, 2), view(pyramid));
    expect(secondBuffers.every(value => value.destroy.mock.calls.length === 1)).toBe(true); expect(f.owned.size).toBe(0);
  });

  it("rolls back partial allocation and invalidates reusable output after write failure", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request(), pyramid = hiz();
    f.device.createBuffer.mockImplementationOnce(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    }).mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => culler.encode(encoder.encoder, input, view(pyramid))).toThrow("allocation failed");
    expect(f.allocated[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);

    f.device.createBuffer.mockImplementation(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    });
    const valid = culler.encode(encoder.encoder, input, view(pyramid)); expect(valid.mode).toBe("indirect");
    const active = f.allocated.slice(-5), write = f.queue.writeBuffer.getMockImplementation()!;
    f.queue.writeBuffer.mockImplementation((target, offset, data) => {
      if ((target as FakeBuffer).label === "Deep Hi-Z indirect arguments") throw new Error("write failed");
      write(target, offset, data);
    });
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1 }, view(pyramid))).toThrow("write failed");
    expect(active.every(value => value.destroy.mock.calls.length === 1)).toBe(true); expect(f.owned.size).toBe(0);
  });

  it("rejects incompatible depth conventions, buffers, limits, and indirect offsets before dispatch", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request();
    expect(() => culler.encode(encoder.encoder, input, view(hiz(0, false)))).not.toThrow();
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1 }, { ...view(hiz(1, true)), reversedZ: false })).toThrow("incompatible");
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1, instances: buffer("tiny", 4) }, view())).toThrow("instance buffer");
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1, firstInstance: 1 }, view())).toThrow("firstInstance");
    f.device.limits.maxComputeWorkgroupsPerDimension = 1;
    expect(() => culler.encode(encoder.encoder, request(129, 2), view())).toThrow("dispatch");
  });

  it("releases owned output on device loss and dispose without destroying borrowed inputs or Hi-Z", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new HiZOcclusionCuller(f.session), input = request(), pyramid = hiz();
    culler.encode(encoder.encoder, input, view(pyramid)); const outputs = f.allocated.slice();
    f.rawSession.state = "lost";
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1 }, view(pyramid))).toThrow("not ready");
    expect(outputs.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(input.instances.destroy).not.toHaveBeenCalled(); expect((pyramid.texture as FakeTexture).destroy).not.toHaveBeenCalled();
    culler.dispose(); culler.dispose(); expect(() => culler.encode(encoder.encoder, input, view(pyramid))).toThrow("disposed");
  });
});
