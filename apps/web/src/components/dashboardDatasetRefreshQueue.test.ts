import { describe, expect, it, vi } from "vitest";
import { DashboardDatasetRefreshQueue } from "./dashboardDatasetRefreshQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("scoped dashboard refresh queue", () => {
  it("coalesces writes behind an old query and awaits the new query, not the old result", async () => {
    const old = deferred(), fresh = deferred();
    const query = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const queue = new DashboardDatasetRefreshQueue(query);
    const initial = queue.request("a");
    const firstWrite = queue.request("a", true), secondWrite = queue.request("a", true);
    expect(firstWrite).toBe(secondWrite);
    let settled = false; void firstWrite.then(() => { settled = true; });
    old.resolve(); expect(await initial).toBe("ready");
    await Promise.resolve(); expect(query).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
    fresh.resolve(); expect(await firstWrite).toBe("ready"); expect(await secondWrite).toBe("ready");
    expect(query.mock.calls).toEqual([["a"], ["a"]]);
  });

  it("propagates the new query failure and permits an explicit read-only retry", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue(undefined);
    const queue = new DashboardDatasetRefreshQueue(query);
    expect(await queue.request("a", true)).toBe("error");
    expect(await queue.request("a", true)).toBe("ready");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not let failure of the old query replace the fresh query result", async () => {
    const old = deferred();
    const query = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(undefined);
    const queue = new DashboardDatasetRefreshQueue(query);
    const initial = queue.request("a"), fresh = queue.request("a", true);
    old.reject(new Error("old failure"));
    expect(await initial).toBe("error"); expect(await fresh).toBe("ready");
  });

  it("allows independent products but coalesces polling without scheduling an extra read", async () => {
    const a = deferred(), b = deferred();
    const query = vi.fn((key: string) => key === "a" ? a.promise : b.promise);
    const queue = new DashboardDatasetRefreshQueue(query);
    const first = queue.request("a"); expect(queue.request("a")).toBe(first);
    const other = queue.request("b"); a.resolve(); b.resolve();
    expect(await first).toBe("ready"); expect(await other).toBe("ready"); expect(query).toHaveBeenCalledTimes(2);
  });

  it("cancels queued and in-flight outcomes on unmount without issuing a late read", async () => {
    const old = deferred(), query = vi.fn(() => old.promise);
    const queue = new DashboardDatasetRefreshQueue(query);
    const initial = queue.request("a"), queued = queue.request("a", true);
    await Promise.resolve(); queue.dispose();
    expect(await queued).toBe("cancelled"); old.resolve(); expect(await initial).toBe("cancelled");
    expect(await queue.request("a", true)).toBe("cancelled"); expect(query).toHaveBeenCalledTimes(1);
  });

  it("avoids starting a scheduled query after immediate disposal", async () => {
    const query = vi.fn(); const queue = new DashboardDatasetRefreshQueue(query);
    const read = queue.request("a"); queue.dispose();
    expect(await read).toBe("cancelled"); expect(query).not.toHaveBeenCalled();
  });
});
