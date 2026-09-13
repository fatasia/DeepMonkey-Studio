import { describe, expect, it, vi } from "vitest";
import { createProbeRunner } from "../../lab/probeExecution.js";

function tracked() {
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const clean = () => {
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
  };
  return { controller, add, remove, clean };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Lab GPU probe execution", () => {
  it("does not report progress, install listeners or run after pre-cancellation", async () => {
    const state = tracked(), reason = new Error("already cancelled"), run = vi.fn(), progress = vi.fn();
    state.controller.abort(reason);
    await expect(createProbeRunner(state.controller.signal, progress)("readback", run)).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  });
  it("rejects while readback remains pending and removes the listener", async () => {
    const state = tracked(), readback = deferred<boolean>();
    const result = createProbeRunner(state.controller.signal)("pending-readback", () => readback.promise);
    state.controller.abort();
    await expect(result).rejects.toThrow("pending-readback: GPU verification cancelled or timed out.");
    state.clean();
    readback.reject(new Error("late GPU failure"));
    await Promise.resolve(); // The cancelled operation remains observed; no unhandled rejection.
  });
  it("honors the 30-second deadline even if GPU work never settles", async () => {
    vi.useFakeTimers();
    try {
      const state = tracked();
      const result = createProbeRunner(state.controller.signal)("timeout", () => new Promise<never>(() => {}));
      const rejected = expect(result).rejects.toThrow("timeout: GPU verification cancelled or timed out.");
      setTimeout(() => state.controller.abort(), 30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected; state.clean();
    } finally { vi.useRealTimers(); }
  });
  it("does not start GPU work if reporting progress cancels preparation", async () => {
    const state = tracked(), run = vi.fn(() => new Promise<never>(() => {}));
    const runner = createProbeRunner(state.controller.signal, () => state.controller.abort());
    await expect(runner("progress-cancel", run)).rejects.toThrow(/cancelled/);
    expect(run).not.toHaveBeenCalled(); state.clean();
  }, 500);
  it("does not falsely pass when synchronous work aborts before returning success", async () => {
    const state = tracked();
    const result = createProbeRunner(state.controller.signal)("sync-cancel", () => {
      state.controller.abort(); return { success: true };
    });
    await expect(result).rejects.toThrow(/cancelled/); state.clean();
  });
  it("observes synchronous abort followed by throw without a detached rejection", async () => {
    const state = tracked();
    const result = createProbeRunner(state.controller.signal)("abort-throw", () => {
      state.controller.abort(); throw new Error("late synchronous failure");
    });
    await expect(result).rejects.toThrow(/cancelled/); state.clean();
  });
  it.each(["synchronous", "asynchronous"] as const)("propagates %s failures and cleans up", async mode => {
    const state = tracked(), error = new Error(`${mode} GPU validation failure`);
    const run = mode === "synchronous" ? () => { throw error; } : () => Promise.reject(error);
    await expect(createProbeRunner(state.controller.signal)("failure", run)).rejects.toBe(error);
    state.clean();
  });
  it("propagates progress failures without starting GPU work or leaking listeners", async () => {
    const state = tracked(), run = vi.fn(), error = new Error("progress failure");
    const runner = createProbeRunner(state.controller.signal, () => { throw error; });
    await expect(runner("progress", run)).rejects.toBe(error);
    expect(run).not.toHaveBeenCalled();
    if (state.add.mock.calls.length) state.clean();
    else expect(state.remove).not.toHaveBeenCalled();
  });
  it.each([false, { success: false }, { success: true }])("returns the exact probe result without manufacturing success: %j", async value => {
    const state = tracked(), progress = vi.fn();
    const result = await createProbeRunner(state.controller.signal, progress)("result", () => value);
    expect(result).toBe(value); expect(progress).toHaveBeenCalledExactlyOnceWith("result"); state.clean();
    state.controller.abort(); // Completed work is no longer subscribed to cancellation.
    expect(state.remove).toHaveBeenCalledTimes(1);
  });
  it("cleans up after asynchronous success", async () => {
    const state = tracked(), work = deferred<number>();
    const result = createProbeRunner(state.controller.signal)("async-result", () => work.promise);
    expect(state.remove).not.toHaveBeenCalled();
    work.resolve(17);
    await expect(result).resolves.toBe(17); state.clean();
  });
  it("handles an optional signal while preserving errors and return values", async () => {
    const runner = createProbeRunner(), error = new Error("GPU failure");
    await expect(runner("normal", () => 17)).resolves.toBe(17);
    await expect(runner("failed", () => Promise.reject(error))).rejects.toBe(error);
  });
});
