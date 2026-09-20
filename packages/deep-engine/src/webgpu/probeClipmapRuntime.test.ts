import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { ProbeClipmapPbrController } from "./probeClipmapPbrController.js";
import { ProbeClipmapRuntime } from "./probeClipmapRuntime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
function fixture(bufferLimit = 128 * 1024 * 1024) {
  const resources = new Set<{ destroy(): void }>(), lost = deferred<GPUDeviceLostInfo>();
  const queue = { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: { maxBufferSize: bufferLimit, maxStorageBufferBindingSize: bufferLimit,
      maxTextureDimension2D: 16_384, maxTextureArrayLayers: 256,
      maxComputeWorkgroupsPerDimension: 65_535 },
    queue, lost: lost.promise, pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size,
      usage: descriptor.usage, destroy: vi.fn() })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({ destroy: vi.fn(),
      createView: vi.fn(() => ({})), descriptor })),
    createCommandEncoder: vi.fn(() => ({ copyTextureToTexture: vi.fn(),
      beginComputePass: vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(), end: vi.fn() })), finish: vi.fn(() => ({})) })),
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { resources.add(resource); return resource; },
    release(resource: { destroy(): void }): void { if (resources.delete(resource)) resource.destroy(); },
  };
  return { session: session as unknown as DeviceSession, rawSession: session, device, queue, lost, resources };
}
const frame = (cameraPosition: readonly [number, number, number] = [0, 0, 0]) => ({
  viewport: [1280, 720] as const, cameraPosition,
  sceneBounds: { min: [-100, -100, -100], max: [100, 100, 100] } as const,
});
const packet = (x: number): RenderPacket => ({
  geometries: [{ id: "robot-geometry", revision: 1,
    vertices: new Float32Array([
      -2, -2, -2, 0, 1, 0, 2, -2, -2, 0, 1, 0, 2, 2, 2, 0, 1, 0,
    ]), indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "robot-material", baseColor: [1, 1, 1], metallic: 0, roughness: 0.5 }],
  instances: [{ id: "robot", geometry: "robot-geometry", material: "robot-material",
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]) }],
});
const options = { frameBudget: 4, cameraCutBudget: 6,
  clipmap: { levelCount: 2, gridSize: [4, 2, 4] as const } } as const;

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2,
    COPY_SRC: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("probe clipmap WebGPU runtime", () => {
  it("provides one automatic frame entry and detects a bounded camera cut", async () => {
    const f = fixture(), runtime = new ProbeClipmapRuntime(f.session, "gpu-1", options);
    const first = await runtime.beginFrame(frame());
    expect(first).toMatchObject({ frame: 0, status: "committed", snapshot: {
      frame: 0, deviceEpoch: "gpu-1", degraded: false,
      frameStats: { frameBudget: 4, updateCount: 4 }, captureStats: { committedUpdateCount: 4 },
      binding: { deviceEpoch: "gpu-1", width: 4, height: 2, depthOrArrayLayers: 8 } } });
    expect(runtime.current).toBe(first.snapshot); expect(runtime.samplingBinding).toBe(first.snapshot!.binding);
    expect(runtime.diagnostics).toEqual([]);
    const moved = await runtime.beginFrame(frame([20, 0, 0]));
    expect(moved).toMatchObject({ frame: 1, status: "committed",
      snapshot: { frameStats: { frameBudget: 6, updateCount: 6 } } });
    runtime.dispose(); expect(f.resources.size).toBe(0);
  });

  it("derives capacity from the device and reports automatic level degradation", async () => {
    const f = fixture(7_000), runtime = new ProbeClipmapRuntime(f.session, "gpu-1", {
      ...options, clipmap: { levelCount: 3, gridSize: [4, 2, 4] } });
    const result = await runtime.beginFrame(frame());
    expect(result).toMatchObject({ status: "committed", snapshot: { degraded: true,
      degradationReasons: ["level-count:3->2"], binding: { depthOrArrayLayers: 8 } } });
    runtime.dispose();
  });

  it("keeps the last committed snapshot on failure and keeps diagnostics opt-in", async () => {
    const f = fixture(), runtime = new ProbeClipmapRuntime(f.session, "gpu-1", options);
    await runtime.beginFrame(frame()); const before = runtime.current;
    runtime.setDiagnosticsEnabled(true);
    f.queue.submit.mockImplementationOnce(() => { throw new Error("queue rejected"); });
    const failed = await runtime.beginFrame(frame());
    expect(failed).toMatchObject({ status: "failed", snapshot: before, error: { message: "queue rejected" } });
    expect(runtime.current).toBe(before);
    expect(runtime.diagnostics).toEqual([{ frame: 1, status: "failed", updateCount: 0,
      degraded: false, message: "queue rejected" }]);
    runtime.setDiagnosticsEnabled(false); expect(runtime.diagnostics).toEqual([]); runtime.dispose();
  });

  it("lets a newer frame win without recycling the older in-flight GPU volume", async () => {
    const f = fixture(), runtime = new ProbeClipmapRuntime(f.session, "gpu-1", options);
    const oldGpu = deferred<void>(), newGpu = deferred<void>();
    f.queue.onSubmittedWorkDone.mockImplementationOnce(() => oldGpu.promise)
      .mockImplementationOnce(() => newGpu.promise);
    const stale = runtime.beginFrame(frame()); await turns(12);
    const winner = runtime.beginFrame(frame([4, 0, 0])); await turns(12);
    await expect(stale).resolves.toMatchObject({ frame: 0, status: "superseded" });
    expect(f.device.createTexture).toHaveBeenCalledTimes(4);
    newGpu.resolve(); await expect(winner).resolves.toMatchObject({ frame: 1, status: "committed" });
    oldGpu.resolve(); await turns(); expect(runtime.current?.frame).toBe(1); runtime.dispose();
  });

  it("preserves a snapshot on caller cancellation but invalidates it on device loss", async () => {
    const f = fixture(), runtime = new ProbeClipmapRuntime(f.session, "gpu-1", options);
    await runtime.beginFrame(frame()); const before = runtime.current;
    const controller = new AbortController(); controller.abort(new Error("caller stopped"));
    await expect(runtime.beginFrame(frame(), controller.signal)).resolves.toMatchObject({
      status: "cancelled", snapshot: before });
    f.rawSession.state = "lost"; f.lost.resolve({ message: "reset", reason: "unknown" } as GPUDeviceLostInfo);
    await turns(); expect(runtime.current).toBeUndefined(); expect(runtime.samplingBinding).toBeUndefined();
    await expect(runtime.beginFrame(frame())).resolves.toMatchObject({ status: "failed" }); runtime.dispose();
  });

  it("publishes only committed volumes to PBR and clears an empty scene", async () => {
    const f = fixture(), published: unknown[] = [];
    const controller = new ProbeClipmapPbrController({ session: f.session,
      setProbeClipmap: binding => { published.push(binding); } }, "gpu-1", options);
    const first = await controller.beginFrame(frame());
    expect(first.status).toBe("committed"); expect(published).toEqual([first.snapshot!.binding]);
    f.queue.submit.mockImplementationOnce(() => { throw new Error("queue rejected"); });
    await expect(controller.beginFrame(frame())).resolves.toMatchObject({ status: "failed", snapshot: first.snapshot });
    expect(published).toHaveLength(1);
    await expect(controller.beginFrame({ ...frame(), sceneBounds: null })).resolves.toMatchObject({ status: "committed" });
    expect(published.at(-1)).toBeUndefined(); expect(controller.current?.binding).toBeUndefined();
    controller.dispose(); expect(published.at(-1)).toBeUndefined();
    await expect(controller.beginFrame(frame())).rejects.toThrow("disposed");
  });

  it("feeds surface-cache mutations into real probe capture and retries after host publication failure", async () => {
    const f = fixture(), publish = vi.fn();
    const controller = new ProbeClipmapPbrController({ session: f.session,
      setProbeClipmap: publish }, "gpu-1", options);
    const initialPacket = packet(0);
    expect(controller.syncRenderPacket({ packet: initialPacket, revision: 1,
      dynamicInstanceIds: new Set(["robot"]) })).toBe(true);
    expect(controller.syncRenderPacket({ packet: initialPacket, revision: 1,
      dynamicInstanceIds: new Set(["robot"]) })).toBe(false);
    const first = await controller.beginFrame(frame());
    expect(first).toMatchObject({ status: "committed",
      snapshot: { frameStats: { updatesByClass: { dynamic: expect.any(Number) } } } });
    expect(first.snapshot!.frameStats.updatesByClass.dynamic).toBeGreaterThan(0);
    expect(controller.surfaceCache.pendingCount).toBe(0);

    controller.syncRenderPacket({ packet: packet(4), revision: 2,
      dynamicInstanceIds: new Set(["robot"]) });
    publish.mockImplementationOnce(() => { throw new Error("renderer rejected GI binding"); });
    await expect(controller.beginFrame(frame())).rejects.toThrow("renderer rejected GI binding");
    expect(controller.surfaceCache.pendingCount).toBe(1);
    await expect(controller.beginFrame(frame())).resolves.toMatchObject({ status: "committed" });
    expect(controller.surfaceCache.pendingCount).toBe(0);
    controller.dispose();
  });

  it("solves relocation against occluders, feeds dirty evidence forward and converges", async () => {
    const f = fixture(), runtime = new ProbeClipmapRuntime(f.session, "gpu-1",
      { ...options, frameBudget: 8, cameraCutBudget: 12 });
    // baseSpacing 默认 2：世界原点探针 [0,0,0]（level0 与 level1）嵌入墙体，逸出 +x。
    const wall = { min: [-0.6, -0.8, -0.6], max: [0.2, 0.8, 0.2] } as const;
    const first = await runtime.beginFrame({ ...frame(), relocationOccluders: [wall] });
    expect(first.status).toBe("committed");
    expect(first.snapshot?.relocation?.recordCount).toBe(2);
    expect(first.snapshot?.relocation?.changedCount).toBe(2);
    expect(first.snapshot?.relocation?.dirtyBounds).toHaveLength(2);
    // 第二帧：偏移 dirty 证据进入计划（dirty 类），重新求解零变化 → 证据链收敛。
    const second = await runtime.beginFrame({ ...frame(), relocationOccluders: [wall] });
    expect(second.status).toBe("committed");
    expect(second.snapshot?.frameStats.updatesByClass.dirty).toBe(2);
    expect(second.snapshot?.relocation?.changedCount).toBe(0);
    runtime.dispose();
  });

  it("feeds surface-cache occluders into relocation through the PBR controller", async () => {
    const f = fixture(), published: unknown[] = [];
    const controller = new ProbeClipmapPbrController({ session: f.session,
      setProbeClipmap: binding => { published.push(binding); } }, "gpu-1", options);
    controller.upsertSurface({ id: "relocation-wall", revision: 1,
      bounds: { min: [-0.6, -0.8, -0.6], max: [0.2, 0.8, 0.2] } });
    const result = await controller.beginFrame(frame());
    expect(result.status).toBe("committed");
    expect(result.snapshot?.relocation?.recordCount).toBeGreaterThan(0);
    expect(published[0]).toBeDefined();
    controller.dispose();
    expect(published.at(-1)).toBeUndefined();
  });
});
