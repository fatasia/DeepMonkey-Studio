import { describe, expect, it, vi } from "vitest";
import { StudioDeepFrameQueue } from "./StudioDeepFrameQueue";

function gate() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function turns() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("shared Deep GPU submission queue", () => {
  it("bounds one thousand camera inputs and replays only the newest view", async () => {
    const backend = {}, fences = [gate(), gate(), gate()], views: number[] = [];
    let next = 0;
    const queue = new StudioDeepFrameQueue(2, value => value === backend, vi.fn(), vi.fn());
    for (let i = 0; i < 1000; i++) queue.submit(backend, () => { views.push(i); return true; }, () => fences[next++]!.promise);
    expect(views).toEqual([0, 1]);
    expect(queue.stats).toMatchObject({ inFlight: 2, maxInFlight: 2, coalesced: 998, pendingLatest: true });
    fences[0]!.resolve(); await turns();
    expect(views).toEqual([0, 1, 999]);
    expect(queue.stats).toMatchObject({ inFlight: 2, pendingLatest: false });
    fences[1]!.resolve(); fences[2]!.resolve(); await turns();
    expect(queue.stats.inFlight).toBe(0);
  });

  it("counts settling against the same limit without replacing pending camera input", async () => {
    const backend = {}, completion = gate(), draw = vi.fn(() => true);
    const queue = new StudioDeepFrameQueue(2, () => true, vi.fn(), vi.fn());
    queue.submit(backend, draw, () => completion.promise, false);
    queue.submit(backend, draw, () => completion.promise);
    const latest = vi.fn(() => true);
    expect(queue.submit(backend, latest, () => Promise.resolve())).toBe(false);
    for (let i = 0; i < 1000; i++) expect(queue.submit(backend, draw, () => completion.promise, false)).toBe(false);
    expect(draw).toHaveBeenCalledTimes(2); expect(latest).not.toHaveBeenCalled();
    completion.resolve(); await turns(); expect(latest).toHaveBeenCalledOnce();
  });

  it("ignores old completion and errors across a backend generation reset", async () => {
    const first = {}, second = {}, completion = gate(); let current = first;
    const error = vi.fn(), stale = vi.fn(() => true);
    const queue = new StudioDeepFrameQueue(1, backend => backend === current, error, vi.fn());
    queue.submit(first, () => true, () => completion.promise);
    queue.submit(first, stale, () => completion.promise);
    queue.reset(); current = second;
    const next = gate(); queue.submit(second, () => true, () => next.promise);
    completion.reject(new Error("old device lost")); await turns();
    expect(error).not.toHaveBeenCalled(); expect(stale).not.toHaveBeenCalled();
    expect(queue.stats.inFlight).toBe(1);
    next.resolve(); await turns(); expect(queue.stats.inFlight).toBe(0);
  });

  it("clears pending work on GPU rejection and propagates encode failure", async () => {
    const backend = {}, completion = gate(), error = vi.fn(), stale = vi.fn(() => true);
    const queue = new StudioDeepFrameQueue(1, () => true, error, vi.fn());
    queue.submit(backend, () => true, () => completion.promise);
    queue.submit(backend, stale, () => completion.promise);
    completion.reject(new Error("GPU queue lost")); await turns();
    expect(error).toHaveBeenCalledOnce(); expect(stale).not.toHaveBeenCalled();
    expect(queue.stats).toMatchObject({ inFlight: 0, pendingLatest: false });
    expect(() => queue.submit(backend, () => { throw new Error("encode failed"); }, () => Promise.resolve())).toThrow("encode failed");
    expect(queue.stats.inFlight).toBe(0);
  });
});
