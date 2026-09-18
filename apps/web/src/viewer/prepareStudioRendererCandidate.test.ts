import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareStudioRendererCandidate } from "./prepareStudioRendererCandidate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const controller = new AbortController();
  const module = deferred<string>();
  const backend = deferred<{ id: number }>();
  const prepared = deferred<void>();
  const options = {
    signal: controller.signal,
    timeoutMs: 100,
    loadModule: vi.fn(() => module.promise),
    create: vi.fn((_module: string, _signal: AbortSignal) => backend.promise),
    prepare: vi.fn((_value: { id: number }, _signal: AbortSignal) => prepared.promise),
    dispose: vi.fn(),
    removeCanvas: vi.fn(),
    onLateCleanupError: vi.fn(),
  };
  return { controller, module, backend, prepared, options };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe("prepareStudioRendererCandidate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

  it("transfers ownership only after preparation completes", async () => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    f.module.resolve("module");
    await flush();
    f.backend.resolve({ id: 1 });
    await flush();
    expect(f.options.prepare).toHaveBeenCalledTimes(1);
    f.prepared.resolve();
    expect(await task).toEqual({ status: "ready", value: { id: 1 } });
    f.controller.abort();
    expect(f.options.dispose).not.toHaveBeenCalled();
    expect(f.options.removeCanvas).not.toHaveBeenCalled();
  });

  it("does not load a module when cancelled before preparation", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await prepareStudioRendererCandidate(f.options)).toEqual({ status: "cancelled" });
    expect(f.options.loadModule).not.toHaveBeenCalled();
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
  });

  it("immediately cancels a stalled module and never creates from its late result", async () => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    f.controller.abort();
    expect(await task).toEqual({ status: "cancelled" });
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
    f.module.resolve("late");
    await flush();
    expect(f.options.create).not.toHaveBeenCalled();
  });

  it("times out a stalled module and keeps timeout distinct from cancellation", async () => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    await vi.advanceTimersByTimeAsync(100);
    expect(await task).toMatchObject({ status: "failed", error: expect.objectContaining({ message: expect.stringContaining("timed out") }) });
    f.controller.abort();
    f.module.resolve("late");
    await flush();
    expect(f.options.create).not.toHaveBeenCalled();
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "timeout"])("disposes a late created backend after %s", async (action) => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    f.module.resolve("module");
    await flush();
    const signal = f.options.create.mock.calls[0]![1];
    if (action === "cancel") f.controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    expect((await task).status).toBe(action === "cancel" ? "cancelled" : "failed");
    expect(signal.aborted).toBe(true);
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
    f.backend.resolve({ id: 2 });
    await flush();
    expect(f.options.dispose).toHaveBeenCalledExactlyOnceWith({ id: 2 });
    expect(f.options.prepare).not.toHaveBeenCalled();
  });

  it("bounds the entire prepare phase including a stalled frame boundary", async () => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    f.module.resolve("module");
    f.backend.resolve({ id: 3 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect((await task).status).toBe("failed");
    expect(f.options.dispose).toHaveBeenCalledExactlyOnceWith({ id: 3 });
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
    f.prepared.resolve();
    await flush();
    expect(f.options.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["module", "create", "prepare"])("reports %s failure and removes the candidate canvas", async (stage) => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    if (stage === "module") f.module.reject(new Error("failure"));
    else {
      f.module.resolve("module");
      await flush();
      if (stage === "create") f.backend.reject(new Error("failure"));
      else {
        f.backend.resolve({ id: 4 });
        await flush();
        f.prepared.reject(new Error("failure"));
      }
    }
    expect(await task).toMatchObject({ status: "failed", error: expect.objectContaining({ message: "failure" }) });
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
    expect(f.options.dispose).toHaveBeenCalledTimes(stage === "prepare" ? 1 : 0);
  });

  it("continues canvas removal when disposing the candidate fails", async () => {
    const f = fixture();
    f.options.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
    const task = prepareStudioRendererCandidate(f.options);
    f.module.resolve("module");
    f.backend.resolve({ id: 5 });
    await flush();
    f.controller.abort();
    expect(await task).toMatchObject({ status: "cancelled", error: expect.any(AggregateError) });
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
    f.prepared.reject(new Error("late preparation failure"));
    await flush();
  });

  it("reports late disposal failure without unhandled rejection", async () => {
    const f = fixture();
    f.options.dispose.mockImplementation(() => { throw new Error("late dispose failed"); });
    const task = prepareStudioRendererCandidate(f.options);
    f.module.resolve("module");
    await flush();
    f.controller.abort();
    await task;
    f.backend.resolve({ id: 6 });
    await flush();
    expect(f.options.onLateCleanupError).toHaveBeenCalledWith(expect.objectContaining({ message: "late dispose failed" }));
  });

  it("removes abort listeners immediately even when module loading never settles", async () => {
    const f = fixture();
    const remove = vi.spyOn(f.controller.signal, "removeEventListener");
    const task = prepareStudioRendererCandidate(f.options);
    f.controller.abort();
    await task;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures a synchronous loader failure", async () => {
    const f = fixture();
    f.options.loadModule.mockImplementation(() => { throw new Error("sync failure"); });
    expect(await prepareStudioRendererCandidate(f.options)).toMatchObject({
      status: "failed", error: expect.objectContaining({ message: "sync failure" }),
    });
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
  });

  it("consumes a late create rejection after cancellation", async () => {
    const f = fixture();
    const task = prepareStudioRendererCandidate(f.options);
    f.module.resolve("module");
    await flush();
    f.controller.abort();
    expect(await task).toEqual({ status: "cancelled" });
    f.backend.reject(new Error("late create failure"));
    await flush();
    expect(f.options.dispose).not.toHaveBeenCalled();
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent candidate resources independent", async () => {
    const first = fixture();
    const second = fixture();
    const oldTask = prepareStudioRendererCandidate(first.options);
    const newTask = prepareStudioRendererCandidate(second.options);
    first.module.resolve("old");
    second.module.resolve("new");
    await flush();
    first.controller.abort();
    second.backend.resolve({ id: 8 });
    second.prepared.resolve();
    expect(await newTask).toEqual({ status: "ready", value: { id: 8 } });
    expect(await oldTask).toEqual({ status: "cancelled" });
    first.backend.resolve({ id: 7 });
    await flush();
    expect(first.options.dispose).toHaveBeenCalledExactlyOnceWith({ id: 7 });
    expect(second.options.dispose).not.toHaveBeenCalled();
    expect(second.options.removeCanvas).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN, 300_001])("rejects invalid timeout %s without leaking the canvas", async (timeoutMs) => {
    const f = fixture();
    expect(await prepareStudioRendererCandidate({ ...f.options, timeoutMs })).toMatchObject({ status: "failed", error: expect.any(RangeError) });
    expect(f.options.removeCanvas).toHaveBeenCalledTimes(1);
    expect(f.options.loadModule).not.toHaveBeenCalled();
  });
});
