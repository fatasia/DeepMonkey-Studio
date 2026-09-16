import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GpuDeformationHistory, type GpuDeformationHistorySource } from "./gpuDeformationHistory.js";
import { GPU_DEFORMATION_HISTORY_WGSL } from "./gpuDeformationHistoryWgsl.js";
import type { DeviceSession } from "./deviceSession.js";

function fixture(stride: 32 | 48 = 48) {
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, VERTEX: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  const owned = new Set<GPUBuffer>();
  const buffer = (size: number, usage = 15) => ({ size, usage, mapState: "unmapped", destroy: vi.fn() }) as unknown as GPUBuffer;
  const device = {
    limits: { maxBufferSize: 1024 * 1024, maxStorageBufferBindingSize: 1024 * 1024, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => buffer(descriptor.size, descriptor.usage)),
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor),
    createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => descriptor),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
  };
  const rawSession = { state: "ready", device,
    own<T extends GPUBuffer>(value: T): T { owned.add(value); return value; },
    release(value: GPUBuffer) { if (owned.delete(value)) value.destroy(); },
  };
  const compute = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { copyBufferToBuffer: vi.fn(), beginComputePass: vi.fn(() => compute) };
  const source: GpuDeformationHistorySource = { output: buffer(3 * stride), vertexCount: 3, outputStride: stride, sourceRevision: 1, poseRevision: 0 };
  return { device, rawSession, session: rawSession as unknown as DeviceSession, owned, buffer, compute,
    rawEncoder: encoder, encoder: encoder as unknown as GPUCommandEncoder, source };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("submitted GPU deformation history", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates its GPU stride conversion with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deformation-history.wgsl", "--input-kind", "wgsl"],
      { input: GPU_DEFORMATION_HISTORY_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Validation successful");
  });
  it("starts previous=current and never copies into the last committed output", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), first = history.begin(f.source);
    expect(first.result.current).toBe(first.result.previous); expect(first.result.historyValid).toBe(false);
    history.encode(f.encoder, first); history.commit(first);
    const second = history.begin({ ...f.source, poseRevision: 1 });
    expect(second.result.previous).toBe(first.result.current); expect(second.result.current).not.toBe(first.result.current);
    history.encode(f.encoder, second);
    expect(f.rawEncoder.copyBufferToBuffer).toHaveBeenLastCalledWith(f.source.output, 0, second.result.current, 0, 144);
    history.commit(second);
    const third = history.begin({ ...f.source, poseRevision: 2 });
    expect(third.result.current).toBe(first.result.current); expect(third.result.previous).toBe(second.result.current);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(2);
    history.cancel(third); history.dispose(); expect(f.owned.size).toBe(0);
  });
  it("reuses only a committed pose without copy or dispatch, including after cancel", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), first = history.begin(f.source);
    history.encode(f.encoder, first); history.commit(first);
    const advanced = history.begin({ ...f.source, poseRevision: 1 }); history.encode(f.encoder, advanced); history.cancel(advanced);
    const retry = history.begin({ ...f.source, poseRevision: 1 });
    expect(retry.result.updated).toBe(true); expect(retry.result.previous).toBe(first.result.current);
    history.cancel(retry);
    const unchanged = history.begin(f.source);
    expect(unchanged.result).toMatchObject({ updated: false, historyValid: true, current: first.result.current, previous: first.result.current });
    f.rawEncoder.copyBufferToBuffer.mockClear(); history.encode(f.encoder, unchanged); history.commit(unchanged);
    expect(f.rawEncoder.copyBufferToBuffer).not.toHaveBeenCalled(); expect(f.rawEncoder.beginComputePass).not.toHaveBeenCalled();
    history.dispose();
  });
  it("converts 32-byte output on GPU with bounded storage bindings and no tangent claim", () => {
    const f = fixture(32), history = new GpuDeformationHistory(f.session), stage = history.begin(f.source);
    expect(stage.result).toMatchObject({ outputStride: 48, hasTangents: false });
    history.encode(f.encoder, stage);
    expect(f.rawEncoder.copyBufferToBuffer).not.toHaveBeenCalled(); expect(f.compute.dispatchWorkgroups).toHaveBeenCalledWith(1);
    expect(f.device.createBindGroup).toHaveBeenCalledWith(expect.objectContaining({ entries: [
      { binding: 0, resource: { buffer: f.source.output, size: 96 } },
      { binding: 1, resource: { buffer: stage.result.current, size: 144 } },
    ] }));
    expect(GPU_DEFORMATION_HISTORY_WGSL).toContain("DeformedVertex(value.position, value.normal, vec4f(0.0))");
    history.commit(stage); history.dispose(); expect(f.owned.size).toBe(0);
  });
  it("releases cancelled first stages and retains committed history during source replacement", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), abandoned = history.begin(f.source);
    history.cancel(abandoned); expect(f.owned.size).toBe(0);
    const first = history.begin(f.source); history.encode(f.encoder, first); history.commit(first);
    const source = { ...f.source, output: f.buffer(288), vertexCount: 6, sourceRevision: 2 };
    const candidate = history.begin(source);
    expect(candidate.result.historyValid).toBe(false); expect(candidate.result.previous).toBe(candidate.result.current);
    expect(f.owned.size).toBe(4); history.cancel(candidate); expect(f.owned.size).toBe(2);
    expect(first.result.current.destroy).not.toHaveBeenCalled();
    const replacement = history.begin(source); history.encode(f.encoder, replacement); history.commit(replacement);
    expect(first.result.current.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(2);
    history.dispose();
  });
  it("rejects unencoded, duplicate, fabricated or overlapping stage commits", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), stage = history.begin(f.source);
    expect(() => history.begin(f.source)).toThrow("pending"); expect(() => history.commit(stage)).toThrow("unencoded");
    expect(() => history.encode(f.encoder, { result: stage.result })).toThrow("Unknown");
    history.encode(f.encoder, stage); expect(() => history.encode(f.encoder, stage)).toThrow("already encoded");
    history.commit(stage); expect(() => history.commit(stage)).toThrow("Unknown");
    expect(history.cancel(stage)).toBe(false); history.dispose();
  });
  it("rejects hidden source identity/shape changes and stale revisions", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), stage = history.begin({ ...f.source, poseRevision: 2 });
    history.encode(f.encoder, stage); history.commit(stage);
    expect(() => history.begin({ ...f.source, output: f.buffer(144), poseRevision: 2 })).toThrow("without a source revision");
    expect(() => history.begin({ ...f.source, vertexCount: 2, poseRevision: 2 })).toThrow("without a source revision");
    expect(() => history.begin({ ...f.source, hasTangents: true, poseRevision: 2 })).toThrow("without a source revision");
    expect(() => history.begin({ ...f.source, sourceRevision: 0 })).toThrow("Stale deformation source");
    expect(() => history.begin(f.source)).toThrow("Stale deformation pose"); history.dispose();
  });
  it.each([
    { vertexCount: 0 }, { vertexCount: 1.5 }, { outputStride: 16 }, { sourceRevision: -1 }, { poseRevision: NaN },
    { vertexCount: 100000 }, { hasTangents: "yes" },
  ])("rejects invalid source contracts %j", patch => {
    const f = fixture(), history = new GpuDeformationHistory(f.session);
    expect(() => history.begin({ ...f.source, ...patch } as never)).toThrow(); expect(f.owned.size).toBe(0);
  });
  it("rejects small/missing-usage buffers and nonexistent skin tangents", () => {
    const f = fixture(32), history = new GpuDeformationHistory(f.session);
    expect(() => history.begin({ ...f.source, output: f.buffer(95) })).toThrow("too small");
    expect(() => history.begin({ ...f.source, output: f.buffer(96, 0) })).toThrow("usage");
    expect(() => history.begin({ ...f.source, hasTangents: true })).toThrow("cannot supply tangents");
    expect(() => history.begin({ ...f.source, output: { ...f.source.output, mapState: "mapped" } as GPUBuffer })).toThrow("unmapped");
  });
  it("cancels failed encoding without advancing and safely retries", () => {
    const f = fixture(32), history = new GpuDeformationHistory(f.session), first = history.begin(f.source);
    f.compute.dispatchWorkgroups.mockImplementationOnce(() => { throw new Error("dispatch failed"); });
    expect(() => history.encode(f.encoder, first)).toThrow("dispatch failed");
    expect(f.compute.end).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    const retry = history.begin(f.source); expect(retry.result.historyValid).toBe(false);
    history.encode(f.encoder, retry); history.commit(retry); history.dispose();
  });
  it("rolls back partial allocation and pipeline creation failures", () => {
    const f = fixture(32), history = new GpuDeformationHistory(f.session);
    f.device.createBuffer.mockImplementationOnce(descriptor => f.buffer(descriptor.size))
      .mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => history.begin(f.source)).toThrow("allocation failed"); expect(f.owned.size).toBe(0);
    f.device.createComputePipeline.mockImplementationOnce(() => { throw new Error("pipeline failed"); });
    expect(() => history.begin(f.source)).toThrow("pipeline failed"); expect(f.owned.size).toBe(0);
    const stage = history.begin(f.source); history.cancel(stage); expect(f.owned.size).toBe(0);
  });
  it("releases both pending and committed allocations on device loss", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), first = history.begin(f.source);
    history.encode(f.encoder, first); history.commit(first);
    const pending = history.begin({ ...f.source, sourceRevision: 2 });
    f.rawSession.state = "lost";
    expect(() => history.commit(pending)).toThrow("not ready"); expect(f.owned.size).toBe(0);
    history.dispose(); expect(() => history.begin(f.source)).toThrow("disposed");
  });
  it("attempts all destruction and detaches state even if release throws", () => {
    const f = fixture(), history = new GpuDeformationHistory(f.session), first = history.begin(f.source);
    history.encode(f.encoder, first); history.commit(first); history.begin({ ...f.source, sourceRevision: 2 });
    const resources = [...f.owned]; vi.mocked(resources[0]!.destroy).mockImplementationOnce(() => { throw new Error("destroy failed"); });
    expect(() => history.dispose()).toThrow("cleanup failed"); expect(f.owned.size).toBe(0);
    for (const resource of resources) expect(resource.destroy).toHaveBeenCalledOnce();
    expect(() => history.dispose()).not.toThrow();
  });
  it("preserves dispatch and pass-end errors together while cancelling the stage", () => {
    const f = fixture(32), history = new GpuDeformationHistory(f.session), stage = history.begin(f.source);
    f.compute.dispatchWorkgroups.mockImplementationOnce(() => { throw new Error("dispatch failed"); });
    f.compute.end.mockImplementationOnce(() => { throw new Error("end failed"); });
    let observed: unknown;
    try { history.encode(f.encoder, stage); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors[0].message).toBe("dispatch failed");
    expect(f.owned.size).toBe(0); expect(history.cancel(stage)).toBe(false);
  });
});
