import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProbeClipmapPbrController } from "./probeClipmapPbrController.js";
import { ProbeClipmapRuntime } from "./probeClipmapRuntime.js";
import { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";

import { deferred, turns, fixture, frame, packet, options } from "./probeClipmapRuntime.testUtils.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2,
    COPY_SRC: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("probe clipmap WebGPU runtime", () => {
  it("releases a stale GI owner after a ready session changes device without publishing on its replacement", async () => {
    const f = fixture(), epoch = new RendererDeviceEpoch(f.device);
    const setProbeClipmap = vi.fn(() => epoch.assertCurrent(f.session.device));
    const controller = new ProbeClipmapPbrController({ session: f.session, setProbeClipmap }, "old", options);
    expect((await controller.beginFrame(frame())).status).toBe("committed");
    expect(f.resources.size).toBeGreaterThan(0);
    const replacementQueue = { ...f.queue, writeBuffer: vi.fn(), submit: vi.fn() };
    f.rawSession.device = { ...f.device, queue: replacementQueue };
    expect(() => epoch.assertCurrent(f.session.device)).toThrow("GPU device changed");
    expect(() => controller.dispose()).not.toThrow();
    expect(setProbeClipmap).toHaveBeenCalledOnce();
    expect(replacementQueue.writeBuffer).not.toHaveBeenCalled();
    expect(replacementQueue.submit).not.toHaveBeenCalled();
    expect(f.resources.size).toBe(0);
    controller.dispose();
    expect(setProbeClipmap).toHaveBeenCalledOnce();
  });

  it("preserves an unrelated detach error while releasing the same-device runtime exactly once", async () => {
    const f = fixture(), failure = new Error("unrelated detach failure");
    const setProbeClipmap = vi.fn(binding => { if (binding === undefined) throw failure; });
    const controller = new ProbeClipmapPbrController({ session: f.session, setProbeClipmap }, "same", options);
    expect((await controller.beginFrame(frame())).status).toBe("committed");
    expect(f.resources.size).toBeGreaterThan(0);
    expect(() => controller.dispose()).toThrow(failure);
    expect(f.resources.size).toBe(0);
    expect(setProbeClipmap).toHaveBeenCalledTimes(2);
    controller.dispose();
    expect(setProbeClipmap).toHaveBeenCalledTimes(2);
  });
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

  it("caps an author-requested frame budget at the producer admission without rejecting the frame", async () => {
    const f = fixture(), runtime = new ProbeClipmapRuntime(f.session, "gpu-bounded", {
      ...options, frameBudget: 8, cameraCutBudget: 8 });
    const first = await runtime.beginFrame({ ...frame(), updateBudget: 64 });
    expect(first).toMatchObject({ status: "committed",
      snapshot: { frameStats: { frameBudget: 8, updateCount: 8 } } });
    const smaller = await runtime.beginFrame({ ...frame(), updateBudget: 2 });
    expect(smaller).toMatchObject({ status: "committed",
      snapshot: { frameStats: { frameBudget: 2, updateCount: 2 } } });
    runtime.dispose();
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
