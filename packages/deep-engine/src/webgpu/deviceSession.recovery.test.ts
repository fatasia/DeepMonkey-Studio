import { describe, expect, it, vi } from "vitest";
import { DeviceSession } from "./deviceSession.js";
import type { DeviceRecoveryOptions } from "./deviceRecovery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** C13 恢复测试夹具：adapter 可按队列发放多台 device，每台带独立 lost promise 与事件源。 */
function recoveryFixture(recovery?: DeviceRecoveryOptions) {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, COPY_SRC: 1 });
  const makeDevice = () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const bus = new EventTarget();
    return { lost: lost.promise, fail: (info: Partial<GPUDeviceLostInfo>) => lost.resolve(info as GPUDeviceLostInfo),
      error: (name: string, message: string) => {
        const event = new Event("uncapturederror", { cancelable: true });
        Object.defineProperty(event, "error", { value: { name, message } });
        bus.dispatchEvent(event);
      },
      limits: { maxTextureDimension2D: 4096 }, destroy: vi.fn(),
      addEventListener: vi.fn(bus.addEventListener.bind(bus)), removeEventListener: vi.fn(bus.removeEventListener.bind(bus)) };
  };
  const first = makeDevice();
  const supplied: Array<ReturnType<typeof makeDevice>> = [first];
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  const canvas = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: vi.fn(() => context) };
  const adapter = { features: new Set<string>(), requestDevice: vi.fn(async () => {
    const device = supplied.at(-1)!;
    return device as unknown as GPUDevice;
  }) };
  const gpu = { requestAdapter: vi.fn(async () => adapter as unknown as GPUAdapter), getPreferredCanvasFormat: () => "bgra8unorm" };
  const controller = new AbortController();
  const open = () => DeviceSession.open(canvas as unknown as HTMLCanvasElement, gpu as unknown as GPU,
    controller.signal, undefined, recovery);
  const supplyNext = () => { const next = makeDevice(); supplied.push(next); return next; };
  return { first, supplied, context, canvas, adapter, gpu, controller, open, supplyNext, makeDevice };
}

describe("C13 typed device-lost recovery (opt-in)", () => {
  it.each(["unknown", "destroyed"])("notifies the idle product fallback once for %s loss with recovery omitted", async reason => {
    const f = recoveryFixture(), session = await f.open();
    const fatal = vi.fn(), recreated = vi.fn();
    session.onFatalLoss(fatal); session.onDeviceRecreated(recreated);
    f.first.fail({ reason: reason as GPUDeviceLostReason, message: "actual host loss" });
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(session.state).toBe("lost");
    expect(fatal).toHaveBeenCalledWith({ kind: "lost", message: `device-lost/${reason}: actual host loss` });
    expect(session.diagnostics).toEqual([{ kind: "lost", message: "actual host loss" }]);
    f.first.fail({ reason: "unknown", message: "late duplicate" });
    f.first.error("GPUInternalError", "late error");
    await Promise.resolve();
    expect(fatal).toHaveBeenCalledOnce(); expect(recreated).not.toHaveBeenCalled();
    expect(f.adapter.requestDevice).toHaveBeenCalledOnce();
    session.dispose(); expect(session.state).toBe("disposed");
  });

  it("allows the fallback consumer to dispose reentrantly and stays silent on late loss", async () => {
    const f = recoveryFixture(), session = await f.open();
    const fatal = vi.fn(() => session.dispose()); session.onFatalLoss(fatal);
    f.first.fail({ reason: "destroyed", message: "destroy while renderer is resident" });
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(session.state).toBe("disposed");
    f.first.fail({ reason: "unknown", message: "late callback" }); await Promise.resolve();
    expect(fatal).toHaveBeenCalledOnce(); expect(f.adapter.requestDevice).toHaveBeenCalledOnce();
  });

  it("recovers in-session from an unknown device loss: new device, surface reconfigured, resources retired, frames resumable", async () => {
    const f = recoveryFixture({ maxAttempts: 2, backoffMs: 1 });
    const session = await f.open();
    const recreated: number[] = [];
    session.onDeviceRecreated((epoch) => recreated.push(epoch));
    const retired = { size: 64, destroy: vi.fn() };
    session.own(retired);
    const replacement = f.supplyNext();
    f.first.fail({ reason: "unknown", message: "driver reset" });
    // lost 回调在微任务中落地；等待 epoch 前进而非 state（初始即为 ready）。
    await vi.waitFor(() => expect(session.recovery?.epoch).toBe(1));
    expect(session.device).toBe(replacement as unknown as GPUDevice);
    expect(session.recovery).toMatchObject({ phase: "healthy", epoch: 1, attempts: 0 });
    // 旧资源随失效设备退役（不调 destroy），账面清零、无僵尸句柄；消费方收到重建通知。
    expect(session.resourceCount).toBe(0); expect(session.retiredResources).toBe(1);
    expect(session.resourceMemory).toMatchObject({ estimatedBytes: 0 });
    expect(recreated).toEqual([1]);
    expect(retired.destroy).not.toHaveBeenCalled();
    expect(f.context.configure).toHaveBeenLastCalledWith(expect.objectContaining({ device: replacement }));
    expect(session.recoveryEvents.map((event) => event.type)).toContain("recovered");
    expect(session.recoveryEvents[0]).toMatchObject({ type: "classified", code: "device-lost/unknown" });
    // 恢复后的会话照常工作：帧循环可继续出（own/resize 正常）。
    session.own({ size: 32, destroy: vi.fn() });
    expect(session.resize(800, 600, 1)).toEqual({ width: 800, height: 600 });
    session.dispose();
  });

  it("treats out-of-memory uncaptured errors as recoverable and rebuilds the session", async () => {
    const f = recoveryFixture({ maxAttempts: 2, backoffMs: 1 });
    const session = await f.open();
    const replacement = f.supplyNext();
    f.first.error("GPUOutOfMemoryError", "texture allocation failed");
    await vi.waitFor(() => expect(session.state).toBe("ready"));
    expect(session.recoveryEvents[0]).toMatchObject({ type: "classified", code: "uncaptured/out-of-memory" });
    expect(session.device).toBe(replacement as unknown as GPUDevice);
    session.dispose();
  });

  it("keeps validation errors in degraded without a recovery attempt, session stays usable", async () => {
    const f = recoveryFixture({ maxAttempts: 2, backoffMs: 1 });
    const session = await f.open();
    session.own({ size: 64, destroy: vi.fn() });
    f.first.error("GPUValidationError", "bad bind group");
    expect(session.state).toBe("degraded");
    expect(session.recovery).toMatchObject({ phase: "degraded", attempts: 0, epoch: 0 });
    expect(session.hasErrors).toBe(true);
    // degraded = 设备仍活：所有权与 surface 操作照常（渲染继续），与 recovering/lost 相反。
    expect(session.own({ size: 8, destroy: vi.fn() })).toBeDefined();
    expect(session.resize(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(f.adapter.requestDevice).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("retries failed recovery attempts with backoff before succeeding", async () => {
    const f = recoveryFixture({ maxAttempts: 3, backoffMs: 2 });
    const session = await f.open();
    f.supplyNext();
    f.adapter.requestDevice.mockRejectedValueOnce(new Error("device creation busy"));
    f.first.fail({ reason: "unknown", message: "TDR" });
    await vi.waitFor(() => expect(session.recovery?.epoch).toBe(1));
    expect(session.recovery).toMatchObject({ phase: "healthy", epoch: 1, attempts: 0, maxAttempts: 3 });
    const attempts = session.recoveryEvents.filter((event) => event.type === "attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ code: "recovery/adapter-unavailable", attempt: 1 });
    expect(f.supplied).toHaveLength(2);
    session.dispose();
  });

  it("hands off exactly once to the fallback chain after exhausting recovery, then stays terminal", async () => {
    const f = recoveryFixture({ maxAttempts: 2, backoffMs: 1 });
    const session = await f.open();
    const fatal: string[] = [];
    session.onFatalLoss((reason) => fatal.push(reason.message));
    f.adapter.requestDevice.mockRejectedValue(new Error("adapter is gone"));
    f.first.fail({ reason: "unknown", message: "driver reset" });
    await vi.waitFor(() => expect(session.state).toBe("lost"));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain("recovery/exhausted");
    expect(session.recovery).toMatchObject({ phase: "lost", attempts: 2, maxAttempts: 2 });
    expect(session.recoveryEvents.filter((event) => event.type === "attempt")).toHaveLength(2);
    // 终态幂等：迟到的 lost 与重复通知不再触发（回退链单次交接）。
    f.first.fail({ reason: "unknown", message: "late duplicate" });
    await Promise.resolve();
    expect(fatal).toHaveLength(1);
    expect(() => session.own({ destroy: vi.fn() })).toThrow("not ready");
    expect(session.resize(800, 600, 1)).toBeUndefined();
    session.dispose();
    expect(session.state).toBe("disposed");
  });

  it("counts a recovered-lost device handed back by the adapter as a failed attempt", async () => {
    const f = recoveryFixture({ maxAttempts: 3, backoffMs: 1 });
    const session = await f.open();
    f.first.fail({ reason: "unknown", message: "reset" });
    // 恢复首次尝试从 adapter 拿回的是同一台已丢失设备：计一次失败而不是误判成功。
    await vi.waitFor(() => expect(session.recoveryEvents.some((event) => event.type === "attempt")));
    f.supplied.push(f.makeDevice());
    await vi.waitFor(() => expect(session.state).toBe("ready"));
    expect(session.device).toBe(f.supplied.at(-1) as unknown as GPUDevice);
    expect(session.recoveryEvents.filter((event) => event.type === "attempt")).toHaveLength(1);
    session.dispose();
  });

  it("does not recover after an explicit dispose and stays silent on late destroyed loss", async () => {
    const f = recoveryFixture();
    const session = await f.open();
    const fatal = vi.fn(); session.onFatalLoss(fatal);
    session.dispose();
    f.first.fail({ reason: "destroyed", message: "intentional" });
    await Promise.resolve();
    expect(session.state).toBe("disposed");
    expect(session.recoveryEvents).toEqual([]);
    expect(f.adapter.requestDevice).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
  });

  it("cancels a pending backoff retry on dispose and no further devices are requested", async () => {
    const f = recoveryFixture({ maxAttempts: 3, backoffMs: 30 });
    const session = await f.open();
    f.adapter.requestDevice.mockRejectedValueOnce(new Error("busy"));
    f.first.fail({ reason: "unknown", message: "reset" });
    await vi.waitFor(() => expect(session.recoveryEvents.some((event) => event.type === "attempt")));
    expect(session.state).toBe("recovering");
    session.dispose();
    const calls = f.adapter.requestDevice.mock.calls.length;
    await new Promise((done) => setTimeout(done, 60));
    expect(f.adapter.requestDevice.mock.calls.length).toBe(calls);
    expect(session.state).toBe("disposed");
  });

  it("discards a late recovery success that lands after dispose instead of reviving the session", async () => {
    const f = recoveryFixture({ maxAttempts: 2, backoffMs: 1 });
    const session = await f.open();
    const replacement = f.supplyNext();
    const pending = deferred<GPUDevice>();
    f.adapter.requestDevice.mockReturnValueOnce(pending.promise);
    f.first.fail({ reason: "unknown", message: "reset" });
    await vi.waitFor(() => expect(session.state).toBe("recovering"));
    session.dispose();
    pending.resolve(replacement as unknown as GPUDevice);
    await Promise.resolve(); await Promise.resolve();
    // 迟到的新设备被销毁、状态保持 disposed、无重建通知。
    expect(replacement.destroy).toHaveBeenCalledOnce();
    expect(session.state).toBe("disposed");
    expect(session.recovery?.epoch ?? 0).toBe(0);
    expect(f.context.configure).toHaveBeenCalledTimes(1); // 仅 open 时那次
  });
});
