import { describe, expect, it, vi } from "vitest";
import { DeviceSession } from "./deviceSession.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, COPY_SRC: 1 });
  const lost = deferred<GPUDeviceLostInfo>();
  const events = new EventTarget();
  const device = {
    lost: lost.promise, limits: { maxTextureDimension2D: 4096 }, destroy: vi.fn(),
    addEventListener: vi.fn(events.addEventListener.bind(events)), removeEventListener: vi.fn(events.removeEventListener.bind(events)),
  };
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  const canvas = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: vi.fn(() => context) };
  const adapter = { features: new Set<string>(), requestDevice: vi.fn(async () => device as unknown as GPUDevice) };
  const gpu = { requestAdapter: vi.fn(async () => adapter as unknown as GPUAdapter), getPreferredCanvasFormat: () => "bgra8unorm" };
  const controller = new AbortController();
  const open = (budget?: number) => DeviceSession.open(canvas as unknown as HTMLCanvasElement, gpu as unknown as GPU, controller.signal, budget);
  return { lost, events, device, context, canvas, adapter, gpu, controller, open };
}

describe("DeviceSession ownership and initialization failures", () => {
  it("rejects inadmissible ownership without destroying the active resource", async () => {
    const f = fixture(), session = await f.open(64);
    const active = { size: 48, destroy: vi.fn() }, candidate = { size: 32, destroy: vi.fn() };
    session.own(active); session.own(active);
    expect(() => session.own(candidate)).toThrow(/ownership budget exceeded/);
    expect(candidate.destroy).toHaveBeenCalledOnce(); expect(active.destroy).not.toHaveBeenCalled();
    expect(session.resourceMemory).toMatchObject({ estimatedBytes: 48, peakEstimatedBytes: 48,
      admission: { budgetBytes: 64, rejectedCount: 1 } });
    const unknown = { destroy: vi.fn() };
    expect(() => session.own(unknown)).toThrow(/known resource sizes/);
    expect(unknown.destroy).toHaveBeenCalledOnce();
    session.release(active); session.own({ size: 64, destroy: vi.fn() });
    session.dispose(); expect(session.resourceMemory.estimatedBytes).toBe(0);
  });
  it("rejects malformed budgets before requesting a GPU adapter", async () => {
    const f = fixture();
    await expect(f.open(Infinity)).rejects.toThrow(/positive safe integer/);
    expect(f.gpu.requestAdapter).not.toHaveBeenCalled();
  });
  it("reports simultaneous candidate bytes at the ownership boundary and clears on dispose", async () => {
    const f = fixture(), session = await f.open();
    const old = { size: 32, destroy: vi.fn() }, candidate = { size: 64, destroy: vi.fn() };
    session.own(old); session.own(old); session.own(candidate);
    expect(session.resourceMemory).toMatchObject({ estimatedBytes: 96, peakEstimatedBytes: 96, resourceCount: 2 });
    session.release(candidate); expect(session.resourceMemory.estimatedBytes).toBe(32);
    session.dispose();
    expect(session.resourceMemory).toMatchObject({ estimatedBytes: 0, peakEstimatedBytes: 96, resourceCount: 0 });
    expect(old.destroy).toHaveBeenCalledOnce(); expect(candidate.destroy).toHaveBeenCalledOnce();
  });
  it("falls back to core rendering if optional timestamp device creation is rejected", async () => {
    const f = fixture(); f.adapter.features.add("timestamp-query");
    f.adapter.requestDevice.mockRejectedValueOnce(new Error("optional feature rejected"));
    const session = await f.open();
    expect(f.adapter.requestDevice).toHaveBeenNthCalledWith(1, { label: "Deep Engine isolated device", requiredFeatures: ["timestamp-query"] });
    expect(f.adapter.requestDevice).toHaveBeenNthCalledWith(2, { label: "Deep Engine core device" });
    session.dispose();
  });
  it("requests every supported portable texture-compression family on the isolated device", async () => {
    const f = fixture();
    f.adapter.features.add("texture-compression-bc");
    f.adapter.features.add("texture-compression-astc");
    const session = await f.open();
    expect(f.adapter.requestDevice).toHaveBeenCalledWith({
      label: "Deep Engine isolated device",
      requiredFeatures: ["texture-compression-bc", "texture-compression-astc"],
    });
    session.dispose();
  });
  it("does not require optional device features and only configures a changed surface", async () => {
    const f = fixture(); const session = await f.open();
    expect(f.adapter.requestDevice).toHaveBeenCalledWith({ label: "Deep Engine isolated device" });
    expect(f.context.configure).toHaveBeenCalledTimes(1);
    expect(f.context.configure).toHaveBeenLastCalledWith({ device: f.device, format: "bgra8unorm",
      alphaMode: "opaque", usage: 17 });
    expect(session.resize(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(f.context.configure).toHaveBeenCalledTimes(1);
    expect(session.resize(0, 600, 1)).toBeUndefined();
    expect(session.resize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
    expect(f.context.configure).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("keeps devices and resources isolated across two sessions", async () => {
    const a = fixture(), b = fixture();
    const first = await a.open(), second = await b.open();
    const firstResource = { destroy: vi.fn() }, secondResource = { destroy: vi.fn() };
    first.own(firstResource); second.own(secondResource);
    first.dispose(); first.dispose();
    expect(firstResource.destroy).toHaveBeenCalledTimes(1);
    expect(a.device.destroy).toHaveBeenCalledTimes(1);
    expect(b.device.destroy).not.toHaveBeenCalled();
    expect(secondResource.destroy).not.toHaveBeenCalled();
    expect(second.state).toBe("ready");
    second.dispose(); expect(secondResource.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases late devices exactly once when requestDevice cannot be cancelled", async () => {
    const f = fixture(), pending = deferred<GPUDevice>();
    f.adapter.requestDevice.mockReturnValue(pending.promise);
    const opening = f.open();
    await vi.waitFor(() => expect(f.adapter.requestDevice).toHaveBeenCalledOnce());
    f.controller.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve(f.device as unknown as GPUDevice);
    await Promise.resolve(); await Promise.resolve();
    expect(f.device.destroy).toHaveBeenCalledTimes(1);
    expect(f.canvas.getContext).not.toHaveBeenCalled();
  });

  it("does not request a device if cancelled while waiting for an adapter", async () => {
    const f = fixture(), pending = deferred<GPUAdapter>();
    f.gpu.requestAdapter.mockReturnValue(pending.promise);
    const opening = f.open(); f.controller.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve(f.adapter as unknown as GPUAdapter); await Promise.resolve();
    expect(f.adapter.requestDevice).not.toHaveBeenCalled();
  });

  it("handles unavailable GPU, missing adapters, pre-abort and device rejection", async () => {
    const f = fixture();
    await expect(DeviceSession.open(f.canvas as unknown as HTMLCanvasElement, undefined, f.controller.signal)).rejects.toThrow("unavailable");
    f.gpu.requestAdapter.mockResolvedValueOnce(null as unknown as GPUAdapter);
    await expect(f.open()).rejects.toThrow("No WebGPU adapter");
    f.adapter.requestDevice.mockRejectedValueOnce(new Error("driver rejected"));
    await expect(f.open()).rejects.toThrow("driver rejected");
    f.controller.abort();
    await expect(f.open()).rejects.toMatchObject({ name: "AbortError" });
    expect(f.device.destroy).not.toHaveBeenCalled();
  });

  it("cleans up a device when canvas acquisition or configuration fails", async () => {
    const a = fixture();
    a.canvas.getContext.mockReturnValue(null as unknown as typeof a.context);
    await expect(a.open()).rejects.toThrow("Canvas");
    expect(a.device.destroy).toHaveBeenCalledTimes(1);
    const b = fixture(); b.context.configure.mockImplementation(() => { throw new Error("configure failed"); });
    await expect(b.open()).rejects.toThrow("configure failed");
    expect(b.device.removeEventListener).toHaveBeenCalledOnce();
    expect(b.context.unconfigure).toHaveBeenCalledOnce();
    expect(b.device.destroy).toHaveBeenCalledTimes(1);
  });

  it("captures device errors and rejects use after loss without changing a disposed state", async () => {
    const f = fixture(); const session = await f.open();
    const event = new Event("uncapturederror", { cancelable: true });
    Object.defineProperty(event, "error", { value: { message: "validation failed" } }); f.events.dispatchEvent(event);
    expect(session.diagnostics).toEqual([{ kind: "error", message: "validation failed" }]);
    f.lost.resolve({ reason: "unknown", message: "driver reset" } as GPUDeviceLostInfo); await Promise.resolve();
    expect(session.state).toBe("lost"); expect(session.resize(800, 600, 1)).toBeUndefined();
    const late = { destroy: vi.fn() };
    expect(() => session.own(late)).toThrow("not ready"); expect(late.destroy).toHaveBeenCalledOnce();
    session.dispose(); expect(session.state).toBe("disposed");
    const other = fixture(), disposed = await other.open(); disposed.dispose();
    other.lost.resolve({ reason: "destroyed", message: "intentional" } as GPUDeviceLostInfo); await Promise.resolve();
    expect(disposed.state).toBe("disposed"); expect(disposed.diagnostics).toEqual([]);
  });

  it("clears all ownership even when one resource fails to release", async () => {
    const f = fixture(); const session = await f.open();
    const bad = { destroy: vi.fn(() => { throw new Error("bad release"); }) }, good = { destroy: vi.fn() };
    session.own(bad); session.own(good); session.dispose();
    expect(good.destroy).toHaveBeenCalledOnce(); expect(session.resourceCount).toBe(0);
    expect(f.device.destroy).toHaveBeenCalledOnce(); expect(session.diagnostics[0]?.message).toContain("bad release");
  });

  it("releases a retired resize resource only once and keeps other resources owned", async () => {
    const f = fixture(); const session = await f.open();
    const a = { destroy: vi.fn() }, b = { destroy: vi.fn() };
    session.own(a); session.own(a); session.own(b); session.release(a); session.release(a);
    expect(a.destroy).toHaveBeenCalledOnce(); expect(session.resourceCount).toBe(1);
    session.dispose(); expect(a.destroy).toHaveBeenCalledOnce(); expect(b.destroy).toHaveBeenCalledOnce();
  });
});
