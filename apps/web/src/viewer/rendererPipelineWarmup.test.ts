import { describe, expect, it, vi } from "vitest";
import { RendererPipelineWarmupScheduler } from "./rendererPipelineWarmup";

describe("RendererPipelineWarmupScheduler", () => {
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
