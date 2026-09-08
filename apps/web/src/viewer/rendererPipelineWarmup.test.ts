import { describe, expect, it, vi } from "vitest";
import { RendererPipelineWarmupScheduler } from "./rendererPipelineWarmup";

describe("RendererPipelineWarmupScheduler", () => {
  it("does not execute a cancelled callback even when its host delivers it late", async () => {
    let callback!: () => void;
    const cancel = vi.fn(), task = vi.fn();
    const scheduler = new RendererPipelineWarmupScheduler(run => { callback = run; return 7; }, cancel);
    scheduler.request(task);
    scheduler.dispose(); scheduler.dispose(); callback();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(7);
    expect(task).not.toHaveBeenCalled();
    expect(scheduler.snapshot().status).toBe("idle");
  });

  it.each(["resolve", "reject"] as const)("ignores late %s after disposal and rejects new requests", async outcome => {
    const callbacks: Array<() => void> = [];
    let finish!: () => void;
    const waiting = new Promise<void>((resolve, reject) => { finish = outcome === "resolve" ? resolve : () => reject(new Error("late compile")); });
    const scheduler = new RendererPipelineWarmupScheduler(run => { callbacks.push(run); return callbacks.length; }, vi.fn());
    scheduler.request(() => waiting); callbacks.shift()?.();
    expect(scheduler.snapshot().status).toBe("running");
    scheduler.dispose(); finish();
    await Promise.resolve(); await Promise.resolve();
    expect(scheduler.snapshot()).toMatchObject({ status: "idle", completedRuns: 0 });
    expect(scheduler.snapshot().lastError).toBeUndefined();
    scheduler.request(vi.fn());
    expect(callbacks).toHaveLength(0);
  });

  it("coalesces pending requests and runs only the latest pipeline state", async () => {
    const callbacks: Array<() => void> = [];
    const executed: string[] = [];
    const scheduler = new RendererPipelineWarmupScheduler(
      (run) => { callbacks.push(run); return callbacks.length; },
      vi.fn(),
      () => 10,
    );

    scheduler.request(() => { executed.push("stale"); });
    scheduler.request(() => { executed.push("latest"); });
    expect(scheduler.snapshot().status).toBe("scheduled");

    callbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toEqual(["latest"]);
    expect(scheduler.snapshot()).toMatchObject({ status: "ready", completedRuns: 1, lastDurationMs: 0 });
  });

  it("records failure evidence without breaking later warmups", async () => {
    const callbacks: Array<() => void> = [];
    const scheduler = new RendererPipelineWarmupScheduler(
      (run) => { callbacks.push(run); return callbacks.length; },
      vi.fn(),
    );
    scheduler.request(() => { throw new Error("shader compile failed"); });
    callbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.snapshot()).toMatchObject({ status: "failed", lastError: "shader compile failed" });

    scheduler.request(() => undefined);
    callbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.snapshot()).toMatchObject({ status: "ready", completedRuns: 1 });
  });

  it("records a cached pipeline without counting another compilation", async () => {
    const callbacks: Array<() => void> = [];
    const scheduler = new RendererPipelineWarmupScheduler(
      (run) => { callbacks.push(run); return callbacks.length; },
      vi.fn(),
    );
    scheduler.request(() => false);
    callbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.snapshot()).toMatchObject({ status: "ready", completedRuns: 0, skippedRuns: 1 });
  });
});
