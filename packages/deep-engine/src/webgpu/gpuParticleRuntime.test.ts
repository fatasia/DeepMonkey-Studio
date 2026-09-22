import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuParticleRuntime } from "./gpuParticleRuntime.js";
import { createGpuParticleRuntimeFromEmitters,
  submitGpuParticleEmitterFrame } from "./gpuParticleEmitters.js";
import { GPU_PARTICLE_COMPUTE_WGSL, GPU_PARTICLE_RENDER_WGSL } from "./gpuParticleWgsl.js";
import { GPU_PARTICLE_INDIRECT_DCIR } from "./gpuParticleIndirectDcir.js";
import { GPU_PARTICLE_BURST_WGSL } from "./gpuParticleBurstWgsl.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function turns(count = 8): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
function fixture(bufferLimit = 128 * 1024 * 1024) {
  const owned = new Set<GPUBuffer>(), buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
  const passes: Array<{ pipelines: string[]; dispatches: number[] }> = [], bindGroups: string[] = [],
    lost = deferred<GPUDeviceLostInfo>();
  const queue = { writes: [] as unknown[][], writeBuffer: vi.fn((...args: unknown[]) => queue.writes.push(args)),
    submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: { maxBufferSize: bufferLimit, maxStorageBufferBindingSize: bufferLimit,
      maxComputeWorkgroupsPerDimension: 65_535, maxStorageBuffersPerShaderStage: 8,
      maxBindGroups: 4, maxUniformBuffersPerShaderStage: 12,
      maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256 },
    queue, lost: lost.promise, pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(({ label }) => ({ label })),
    createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroup: vi.fn(({ label, entries }) => ({ label, entries })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage, mapState: "unmapped",
        destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
      buffers.push(buffer); return buffer;
    }),
    createCommandEncoder: vi.fn(() => {
      const record = { pipelines: [] as string[], dispatches: [] as number[] }; passes.push(record);
      return { beginComputePass: vi.fn(() => ({ setBindGroup: vi.fn((_index: number, group: { label: string }) =>
        bindGroups.push(group.label)),
        setPipeline: vi.fn((pipeline: { label: string }) => record.pipelines.push(pipeline.label)),
        dispatchWorkgroups: vi.fn((count: number) => record.dispatches.push(count)), end: vi.fn() })),
      finish: vi.fn(() => ({})) };
    }),
  };
  const session = { state: "ready", device,
    own<T extends GPUBuffer>(buffer: T): T { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer): void { if (owned.delete(buffer)) buffer.destroy(); },
  };
  return { session: session as unknown as DeviceSession, rawSession: session,
    device, queue, buffers, passes, bindGroups, owned, lost };
}
const seeds = [{ id: 1, position: [0, 0, 0], velocity: [2, 0, 0], lifetime: 1 },
  { id: 2, position: [1, 0, 0], velocity: [0, 0, 0], age: 0.9, lifetime: 1 }] as const;

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1, VERTEX: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4,
    COPY_SRC: 8, INDIRECT: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded GPU particle runtime", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates compute and reusable render WGSL with Naga", () => {
    for (const [name, shader] of [["compute", GPU_PARTICLE_COMPUTE_WGSL], ["indirect", GPU_PARTICLE_INDIRECT_DCIR.code],
      ["render", GPU_PARTICLE_RENDER_WGSL], ["burst", GPU_PARTICLE_BURST_WGSL]] as const) {
      const checked = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
        ["--stdin-file-path", `deep-particle-${name}.wgsl`, "--input-kind", "wgsl"],
        { input: shader, encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0); expect(checked.stdout).toContain("Validation successful");
    }
  });

  it("uploads seeds once, writes one small frame uniform, compacts and publishes drawIndirect", async () => {
    const f = fixture(), runtime = new GpuParticleRuntime(f.session, "gpu-1",
      { capacity: 8, initialParticles: seeds });
    expect(f.device.createShaderModule).toHaveBeenNthCalledWith(2, {
      label: "Deep GPU particle indirect DCIR", code: GPU_PARTICLE_INDIRECT_DCIR.code,
    });
    expect(GPU_PARTICLE_COMPUTE_WGSL).not.toContain("fn writeIndirect");
    expect(f.device.createBuffer).toHaveBeenCalledTimes(7);
    expect(f.queue.writes).toHaveLength(5);
    const committed = await runtime.beginFrame({ deltaTime: 0.25, acceleration: [0, 0, 0] });
    expect(committed).toMatchObject({ frame: 0, status: "committed", snapshot: {
      generation: 1, deviceEpoch: "gpu-1", capacityEvidence: { capacity: 8, degraded: false },
      binding: { bindGroupIndex: 0, capacity: 8, stride: 64 } } });
    expect(f.queue.writes).toHaveLength(6);
    expect((f.queue.writes[5]![2] as ArrayBuffer).byteLength).toBe(32);
    expect(f.passes[0]).toEqual({ pipelines: ["Deep particle reset pipeline",
      "Deep particle simulation pipeline", "Deep particle indirect DCIR pipeline"], dispatches: [1, 1, 1] });
    expect(f.bindGroups).toEqual(["Deep particle compute 0->1"]);
    expect(committed.snapshot!.binding.stateBuffer).toBe(f.buffers[4]);
    const pass = { setBindGroup: vi.fn(), drawIndirect: vi.fn() };
    expect(runtime.encodeDraw(pass as unknown as GPURenderPassEncoder)).toBe(true);
    expect(pass.drawIndirect).toHaveBeenCalledWith(committed.snapshot!.binding.indirectBuffer, 0);
    runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("derives a fixed capacity from limits and reports degradation", async () => {
    const automatic = fixture(), automaticRuntime = new GpuParticleRuntime(automatic.session, "gpu-auto",
      { initialParticles: seeds });
    expect(automaticRuntime.capacityEvidence).toMatchObject({ requestedCapacity: 1_024,
      capacity: 1_024, degraded: false });
    automaticRuntime.dispose();
    const f = fixture(5 * 64), runtime = new GpuParticleRuntime(f.session, "gpu-1",
      { capacity: 8, initialParticles: seeds });
    expect(runtime.capacityEvidence).toMatchObject({ requestedCapacity: 8, capacity: 5,
      degraded: true, stateBytes: 320, totalBufferBytes: 712 });
    await expect(runtime.beginFrame({ deltaTime: 0 })).resolves.toMatchObject({ status: "committed" });
    runtime.dispose();
  });

  it("wires declarative presets into the existing runtime with constant-velocity uniforms", async () => {
    const f = fixture(), setup = createGpuParticleRuntimeFromEmitters(f.session, "gpu-effects", [
      { id: "alarm", preset: "alarm-pulse", position: [0, 0, 0] },
      { id: "ring", preset: "expanding-ring", center: [0, 0, 0], count: 3 },
      { id: "flow", preset: "flow-line", start: [0, 0, 0], end: [3, 0, 0], count: 3 },
    ], { capacity: 8 });
    expect(setup.program.evidence).toMatchObject({ emittedParticleCount: 7, degraded: false });
    const committed = await submitGpuParticleEmitterFrame(setup.runtime, { deltaTime: 0.2 });
    expect(committed.status).toBe("committed");
    const bytes = f.queue.writes.at(-1)![2] as ArrayBuffer;
    const uniform = new Float32Array(bytes), uniformWords = new Uint32Array(bytes);
    expect(uniform[0]).toBeCloseTo(0.2); expect(uniform[1]).toBe(0); expect(uniformWords[2]).toBe(8);
    expect(Array.from(uniform.slice(3))).toEqual([0, 0, 0, 0, 0]);
    setup.runtime.dispose();
  });

  it("uploads bounded burst descriptors and expands them in the existing compute pass", async () => {
    const f = fixture(), runtime = new GpuParticleRuntime(f.session, "gpu-bursts",
      { capacity: 8, initialParticles: seeds, burst: { maxEvents: 2, particleBudget: 3 } });
    expect(f.device.createBuffer).toHaveBeenCalledTimes(10);
    const committed = await runtime.beginFrame({ deltaTime: 0.1, bursts: [
      { id: "impact", position: [2, 3, 4], direction: [0, 1, 0], count: 5, seed: 17 },
    ] });
    expect(committed).toMatchObject({ status: "committed", snapshot: { burstEvidence: {
      requestedEventCount: 1, submittedEventCount: 1, requestedParticleCount: 5,
      submittedParticleCount: 3, degraded: true, degradationReasons: ["particle-count:5->3"],
    } } });
    expect((f.queue.writes.at(-2)![2] as ArrayBuffer).byteLength).toBe(80);
    expect((f.queue.writes.at(-1)![2] as ArrayBuffer).byteLength).toBe(16);
    expect(f.passes[0]).toEqual({ pipelines: ["Deep particle reset pipeline",
      "Deep particle simulation pipeline", "Deep particle burst reserve pipeline",
      "Deep particle burst spawn pipeline", "Deep particle indirect DCIR pipeline"],
    dispatches: [1, 1, 1, 1, 1] });
    expect(f.bindGroups).toEqual(["Deep particle compute 0->1", "Deep particle burst output 1",
      "Deep particle compute 0->1"]);
    runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("keeps the active frame across validation and submit failures", async () => {
    const f = fixture(), runtime = new GpuParticleRuntime(f.session, "gpu-1",
      { capacity: 8, initialParticles: seeds, burst: { particleBudget: 4 } });
    await runtime.beginFrame({ deltaTime: 0.1, acceleration: [0, 0, 0] });
    const before = runtime.current, writes = f.queue.writes.length;
    await expect(runtime.beginFrame({ deltaTime: Number.NaN })).resolves.toMatchObject({
      status: "failed", snapshot: before });
    expect(f.queue.writes).toHaveLength(writes); expect(runtime.current).toBe(before);
    const cancelled = new AbortController(); cancelled.abort("skip");
    await expect(runtime.beginFrame({ deltaTime: 0.1, bursts: [] }, cancelled.signal)).resolves.toMatchObject({
      status: "cancelled", snapshot: before });
    expect(f.queue.writes).toHaveLength(writes);
    f.queue.submit.mockImplementationOnce(() => { throw new Error("queue rejected"); });
    await expect(runtime.beginFrame({ deltaTime: 0.1, bursts: [
      { id: "failed", position: [0, 0, 0], direction: [1, 0, 0], count: 1 },
    ] })).resolves.toMatchObject({
      status: "failed", snapshot: before, error: { message: "queue rejected" } });
    expect(runtime.current).toBe(before); runtime.dispose();
  });

  it("serializes its two buffers while the latest frame supersedes in-flight work", async () => {
    const f = fixture(), runtime = new GpuParticleRuntime(f.session, "gpu-1",
      { capacity: 8, initialParticles: seeds, burst: { particleBudget: 4 } });
    await runtime.beginFrame({ deltaTime: 0.1 }); const before = runtime.current;
    const oldGpu = deferred<void>(), newGpu = deferred<void>();
    f.queue.onSubmittedWorkDone.mockImplementationOnce(() => oldGpu.promise)
      .mockImplementationOnce(() => newGpu.promise);
    const burst = [{ id: "burst", position: [0, 0, 0], direction: [1, 0, 0], count: 1 }] as const;
    const stale = runtime.beginFrame({ deltaTime: 0.1, bursts: burst }); await turns();
    const winner = runtime.beginFrame({ deltaTime: 0.2, bursts: burst });
    await expect(stale).resolves.toMatchObject({ status: "superseded", snapshot: before });
    expect(f.device.createBuffer).toHaveBeenCalledTimes(10);
    oldGpu.resolve(); await turns(12); newGpu.resolve();
    await expect(winner).resolves.toMatchObject({ status: "committed", frame: 2 });
    expect(runtime.current?.frame).toBe(2); runtime.dispose();
  });

  it("invalidates the epoch and releases every buffer once after device loss", async () => {
    const f = fixture(), runtime = new GpuParticleRuntime(f.session, "gpu-1",
      { capacity: 8, initialParticles: seeds, burst: { particleBudget: 4 } });
    await runtime.beginFrame({ deltaTime: 0.1 });
    f.rawSession.state = "lost"; f.lost.resolve({ message: "reset", reason: "unknown" } as GPUDeviceLostInfo);
    await turns(); expect(runtime.current).toBeUndefined(); expect(runtime.encodeDraw({} as GPURenderPassEncoder)).toBe(false);
    await expect(runtime.beginFrame({ deltaTime: 0.1 })).resolves.toMatchObject({ status: "failed" });
    expect(f.owned.size).toBe(0);
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    runtime.dispose();
  });
});
