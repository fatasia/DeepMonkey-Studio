import { describe, expect, it, vi } from "vitest";
import { PipelineWarmupQueue, type WarmupScheduler } from "./pipelineWarmup.js";

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)); }

describe("C26 pipeline warmup queue", () => {
  it("starts nothing while paused and drains everything after resume", async () => {
    const queue = new PipelineWarmupQueue({ concurrency: 4 });
    const created: string[] = [];
    const jobs = Array.from({ length: 3 }, (_, index) => queue.enqueue({
      fingerprint: `f${index}`, label: `p${index}`, priority: "background",
      create: async () => { created.push(`p${index}`); return index; },
    }));
    await tick();
    expect(created).toEqual([]);
    expect(queue.stats).toMatchObject({ pending: 3, inFlight: 0, paused: true });
    queue.resume();
    expect(await Promise.all(jobs)).toEqual([0, 1, 2]);
    expect(created).toEqual(["p0", "p1", "p2"]);
  });

  it("drains first-frame tasks before background even when enqueued later", async () => {
    const order: string[] = [];
    const queue = new PipelineWarmupQueue({ concurrency: 1 });
    const background = queue.enqueue({ fingerprint: "b", label: "background", priority: "background",
      create: async () => { order.push("background"); return "b"; } });
    const firstFrame = queue.enqueue({ fingerprint: "f", label: "first-frame", priority: "first-frame",
      create: async () => { order.push("first-frame"); return "f"; } });
    queue.resume();
    expect(await firstFrame).toBe("f");
    expect(order).toEqual(["first-frame"]);
    expect(await background).toBe("b");
    expect(order).toEqual(["first-frame", "background"]);
  });

  it("caps concurrent compiles so background work yields device headroom (T11 contention guard)", async () => {
    let inFlight = 0, peak = 0;
    const queue = new PipelineWarmupQueue({ concurrency: 2 });
    const pending = Array.from({ length: 6 }, (_, index) => queue.enqueue({
      fingerprint: `f${index}`, label: `p${index}`, priority: "background",
      create: async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
        return index;
      },
    }));
    queue.resume();
    expect(await Promise.all(pending)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("runs idle-priority tasks only through the injected idle scheduler", async () => {
    const windows: Array<() => void> = [];
    const scheduler: WarmupScheduler = vi.fn(callback => { windows.push(callback); return () => undefined; });
    const queue = new PipelineWarmupQueue({ concurrency: 2, idleScheduling: true, scheduler });
    const order: string[] = [];
    const backgroundDone = queue.enqueue({ fingerprint: "b", label: "background", priority: "background",
      create: async () => { order.push("background"); return true; } });
    const idleDone = queue.enqueue({ fingerprint: "i", label: "idle", priority: "idle",
      create: async () => { order.push("idle"); return true; } });
    queue.resume();
    await backgroundDone;
    expect(order).toEqual(["background"]);
    expect(windows).toHaveLength(1);
    windows[0]!();
    expect(await idleDone).toBe(true);
    expect(order).toEqual(["background", "idle"]);
  });

  it("keeps the queue alive when one background compile fails; rejections stay per-task", async () => {
    const queue = new PipelineWarmupQueue({ concurrency: 2 });
    const failing = queue.enqueue({ fingerprint: "bad", label: "bad", priority: "background",
      create: async () => { throw new Error("compile exploded"); } });
    const healthy = queue.enqueue({ fingerprint: "ok", label: "ok", priority: "background",
      create: async () => "ok" });
    queue.resume();
    await expect(failing).rejects.toThrow("compile exploded");
    expect(await healthy).toBe("ok");
    expect(queue.stats).toMatchObject({ pending: 0, inFlight: 0 });
  });

  it("does not start paused tasks enqueued after resume; resume pumps them once", async () => {
    const queue = new PipelineWarmupQueue({ concurrency: 1 });
    queue.resume();
    const created: string[] = [];
    const job = queue.enqueue({ fingerprint: "late", label: "late", priority: "background",
      create: async () => { created.push("late"); return true; } });
    await tick();
    expect(created).toEqual(["late"]);
    queue.pause();
    const held = queue.enqueue({ fingerprint: "held", label: "held", priority: "background",
      create: async () => { created.push("held"); return true; } });
    await tick();
    expect(created).toEqual(["late"]);
    queue.resume();
    expect(await held).toBe(true);
    expect(created).toEqual(["late", "held"]);
    void job;
  });
});
