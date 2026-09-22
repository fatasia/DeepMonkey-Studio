import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { ForwardPlusClusterAssigner, FORWARD_PLUS_CLUSTER_PIPELINE_KEY } from "./clusterCompute.js";
import { FORWARD_PLUS_CLUSTER_ASSIGN_WGSL } from "./clusterComputeWgsl.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: FakeBuffer[] = [], writes: Array<{ buffer: FakeBuffer; data: ArrayBuffer }> = [];
  let failAllocationAt = -1;
  const queue = { writeBuffer: vi.fn((buffer: FakeBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
    const source = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    writes.push({ buffer, data: source });
  }) };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 65_535 }, queue,
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })), createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })), createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      if (allocated.length === failAllocationAt) throw new Error("allocation failed");
      const value = { label: label ?? "", size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
      allocated.push(value); return value;
    }), createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { session: session as unknown as DeviceSession, rawSession: session, device, queue, owned, allocated, writes,
    failNextAllocation(offset: number) { failAllocationAt = allocated.length + offset; } };
}

const config = { viewportWidth: 64, viewportHeight: 32, tileSizeX: 32, tileSizeY: 32,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 4 } as const;
const point = (x = 0) => ({ positionView: [x, 0, -4] as const, range: 2, color: [1, 0.5, 0.25] as const, intensity: 2 });

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Forward+ WebGPU cluster assignment", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-forward-plus.wgsl", "--input-kind", "wgsl"],
      { input: FORWARD_PLUS_CLUSTER_ASSIGN_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe(""); expect(validation.stdout).toContain("Validation successful");
  });

  it("uploads the same view-space inputs as the CPU reference and encodes one deterministic scan", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session);
    const result = assigner.prepare(config, { points: [point()], spots: [{ ...point(1), directionView: [0, 0, -1], outerConeCos: 0.5, innerConeCos: 0.75 }] }, { cpuReference: true });
    expect(result.pipelineKey).toBe(FORWARD_PLUS_CLUSTER_PIPELINE_KEY); expect(result.cpuReference?.localLightCount).toBe(2);
    const boundsWrite = f.writes.find(write => write.buffer === result.localBoundsBuffer)!;
    expect(Array.from(new Float32Array(boundsWrite.data))).toEqual([0, 0, -4, 2, 1, 0, -4, 2]);
    const parameters = f.writes.find(write => write.buffer.label.includes("parameters"))!;
    expect(Array.from(new Uint32Array(parameters.data).slice(0, 12))).toEqual([64, 32, 32, 32, 2, 1, 4, 2, 4, 8, 0, 1]);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
    expect(assigner.encode(encoder)).toBe(result); expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(result.grid.clusterCount);
    expect(() => assigner.encode(encoder)).toThrow("prepared"); assigner.dispose();
  });

  it("uses one cooperative workgroup per cluster instead of a serial light scan per invocation", () => {
    expect(FORWARD_PLUS_CLUSTER_ASSIGN_WGSL).toContain("var<workgroup> acceptedPrefix: array<u32, 64>");
    expect(FORWARD_PLUS_CLUSTER_ASSIGN_WGSL).toContain("for (var base = 0u; base < params.grid1.w; base += 64u)");
    expect(FORWARD_PLUS_CLUSTER_ASSIGN_WGSL).toContain("let light = base + local.x");
    expect(FORWARD_PLUS_CLUSTER_ASSIGN_WGSL).toContain("lightIndices[outputOffset + count + rank - 1u] = light");
  });

  it("strides oversized grids across the device workgroup limit", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session);
    const result = assigner.prepare({ ...config, viewportWidth: 512, viewportHeight: 512,
      tileSizeX: 1, tileSizeY: 1, zSlices: 1 }, { points: [] });
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    assigner.encode({ beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder);
    expect(result.grid.clusterCount).toBe(262_144);
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(65_535);
    expect(FORWARD_PLUS_CLUSTER_ASSIGN_WGSL).toContain("cluster += workgroupCount.x");
    assigner.dispose();
  });

  it("reuses stable buffers, grows and shrinks geometrically, and keeps one pipeline", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session);
    const first = assigner.prepare(config, { points: [point()] });
    const second = assigner.prepare(config, { points: [point(1)] });
    expect(second.clusterHeaderBuffer).toBe(first.clusterHeaderBuffer); expect(second.pointLightBuffer).toBe(first.pointLightBuffer);
    const grown = assigner.prepare(config, { points: [point(), point(1), point(2)] });
    expect(grown.pointLightBuffer).not.toBe(first.pointLightBuffer); expect((first.pointLightBuffer as FakeBuffer).destroy).toHaveBeenCalledOnce();
    const shrunk = assigner.prepare(config, { points: [] });
    expect(shrunk.pointLightBuffer).not.toBe(grown.pointLightBuffer); expect((grown.pointLightBuffer as FakeBuffer).destroy).toHaveBeenCalledOnce();
    expect(f.device.createComputePipeline).toHaveBeenCalledOnce(); assigner.dispose(); assigner.dispose(); expect(f.owned.size).toBe(0);
    expect(f.allocated.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("keeps the production prepare path free of CPU reference allocation", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session);
    const production = assigner.prepare(config, { points: [point()] });
    expect(production.cpuReference).toBeUndefined();
    expect(assigner.prepare(config, { points: [point()] }, { cpuReference: true }).cpuReference?.headers).toBeInstanceOf(Uint32Array);
    assigner.dispose();
  });

  it("rolls back a failed resize and preserves the prior allocation", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session), first = assigner.prepare(config, { points: [point()] });
    const allocationStart = f.allocated.length; f.failNextAllocation(3);
    expect(() => assigner.prepare(config, { points: [point(), point(1), point(2)] })).toThrow("allocation failed");
    expect((first.pointLightBuffer as FakeBuffer).destroy).not.toHaveBeenCalled();
    expect(f.allocated.slice(allocationStart).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    f.failNextAllocation(1_000); expect(assigner.prepare(config, { points: [point()] }).pointLightBuffer).toBe(first.pointLightBuffer);
    assigner.dispose();
  });

  it("releases a complete candidate when upload fails without destroying the active buffers", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session), first = assigner.prepare(config, { points: [point()] });
    const allocationStart = f.allocated.length;
    f.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("upload failed"); });
    expect(() => assigner.prepare(config, { points: [point(), point(1), point(2)] })).toThrow("upload failed");
    expect((first.pointLightBuffer as FakeBuffer).destroy).not.toHaveBeenCalled();
    expect(f.allocated.slice(allocationStart)).toHaveLength(9);
    expect(f.allocated.slice(allocationStart).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    f.queue.writeBuffer.mockReset(); expect(assigner.prepare(config, { points: [point()] }).pointLightBuffer).toBe(first.pointLightBuffer);
    assigner.dispose();
  });

  it("invalidates incremental upload state after a reused-buffer write failure", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session);
    assigner.prepare(config, { points: [point()] });
    f.queue.writeBuffer.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("bounds upload failed"); });
    expect(() => assigner.prepare(config, { points: [point(1)] })).toThrow("bounds upload failed");

    f.queue.writeBuffer.mockReset();
    const restored = assigner.prepare(config, { points: [point()] });
    expect(restored.uploadedInputBufferCount).toBe(4);
    expect(f.queue.writeBuffer.mock.calls.map(call => (call[0] as FakeBuffer).label)).toEqual([
      "Deep Forward+ point lights", "Deep Forward+ local light bounds",
      "Deep Forward+ IES shading tables", "Deep Forward+ cluster parameters",
    ]);
    assigner.dispose();
  });

  it("fails closed after device loss and disposes owned buffers", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session); assigner.prepare(config, { points: [point()] });
    f.rawSession.state = "lost";
    expect(() => assigner.prepare(config, { points: [] })).toThrow("lost GPU session");
    expect(() => assigner.encode({} as GPUCommandEncoder)).toThrow("lost GPU session");
    assigner.dispose(); expect(f.owned.size).toBe(0); expect(f.allocated.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
});
