import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import * as renderPacket from "../renderPacket.js";
import { ProbeClipmapPbrController } from "./probeClipmapPbrController.js";
import { fixture, frame, packet, options } from "./probeClipmapRuntime.testUtils.js";
beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2,
    COPY_SRC: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("probe capture readiness and owned packet admission", () => {
  it("admits a real capture before reading dynamic bounds or planning and clears stale volumes once", async () => {
    const f = fixture(), setProbeClipmap = vi.fn();
    let unavailable: string | undefined = "deformed scene cannot be captured";
    const controller = new ProbeClipmapPbrController({ session: f.session, setProbeClipmap }, "admission", {
      ...options, captureUnavailableReason: () => unavailable });
    const surfaceRead = vi.spyOn(controller.surfaceCache, "beginFrame");
    const plan = vi.spyOn(controller.runtime, "beginFrame");
    for (let index = 0; index < 100; index++) {
      expect((await controller.beginFrame(frame())).status).toBe("failed");
    }
    expect(surfaceRead).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled();
    expect(f.queue.submit).not.toHaveBeenCalled();
    unavailable = undefined;
    expect((await controller.beginFrame(frame())).status).toBe("committed");
    expect(setProbeClipmap).toHaveBeenCalledOnce();
    unavailable = "lighting is off";
    controller.suspendUnavailableCapture(); controller.suspendUnavailableCapture();
    expect(setProbeClipmap).toHaveBeenCalledTimes(2);
    expect(setProbeClipmap).toHaveBeenLastCalledWith();
    controller.dispose();
  });

  it("recaptures an already-filled volume when real lighting returns after an unavailable interval", async () => {
    const f = fixture(), setProbeClipmap = vi.fn(); let unavailable: string | undefined;
    const controller = new ProbeClipmapPbrController({ session: f.session, setProbeClipmap }, "lighting-restored", {
      ...options, frameBudget: 64, cameraCutBudget: 64, captureUnavailableReason: () => unavailable });
    await controller.beginFrame(frame());
    expect(controller.current?.frameStats.deferredCount).toBe(0);
    unavailable = "lighting is off"; controller.suspendUnavailableCapture();
    unavailable = undefined;
    await controller.beginFrame(frame());
    expect(controller.current?.frameStats.updateCount).toBe(64);
    expect(controller.current?.frameStats.updatesByClass.dirty).toBe(64);
    await controller.beginFrame(frame());
    expect(controller.current?.frameStats.updateCount).toBe(0);
    const calls = setProbeClipmap.mock.calls.length;
    f.rawSession.device = { ...f.device, queue: { ...f.queue } };
    unavailable = "replacement device"; controller.suspendUnavailableCapture();
    expect(setProbeClipmap).toHaveBeenCalledTimes(calls);
    controller.dispose();
  });
  it("reuses only the renderer-owned validated packet and validates an uncached replacement", () => {
    const f = fixture(), raw = packet(0), prepared = renderPacket.prepareRenderPacket(raw);
    const prepare = vi.spyOn(renderPacket, "prepareRenderPacket"), radiance = vi.fn();
    const cached = vi.fn((input: RenderPacket) => input === raw ? prepared : undefined);
    const controller = new ProbeClipmapPbrController({ session: f.session,
      setProbeClipmap: vi.fn(), preparedPacketFor: cached }, "gpu-owned", {
      ...options, sceneRadianceSync: radiance });
    raw.geometries[0]!.vertices[0] = Number.NaN;
    expect(controller.syncRenderPacket({ packet: raw, revision: 1 })).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(radiance).toHaveBeenCalledWith(raw, 1);
    expect(controller.sceneBounds?.min[0]).toBe(-2);
    const replacement = packet(4);
    replacement.geometries[0]!.vertices[0] = Number.NaN;
    expect(() => controller.syncRenderPacket({ packet: replacement, revision: 2 })).toThrow();
    expect(prepare).toHaveBeenCalledOnce();
    expect(radiance).toHaveBeenCalledOnce();
    expect(controller.sceneBounds?.min[0]).toBe(-2);
    controller.dispose();
    expect(f.resources.size).toBe(0);
  });

});
