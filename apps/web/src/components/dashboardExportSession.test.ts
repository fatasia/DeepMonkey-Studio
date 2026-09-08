import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardExportSession } from "./dashboardExportSession";

afterEach(() => vi.useRealTimers());
describe("dashboard export session", () => {
  it("announces busy immediately and prevents duplicate submissions", async () => {
    const notify = vi.fn(), session = createDashboardExportSession(notify);
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = session.run(work, "timeout");
    expect(notify).toHaveBeenLastCalledWith({ busy: true, error: "", completed: false });
    await session.run(work, "timeout");
    expect(work).toHaveBeenCalledTimes(1);
    finish(); await pending;
    expect(notify).toHaveBeenLastCalledWith({ busy: false, error: "", completed: true });
  });
  it("silently cancels on page exit, ignores late failures, and permits a new request", async () => {
    const notify = vi.fn(), session = createDashboardExportSession(notify);
    let reject!: (error: Error) => void, firstSignal!: AbortSignal;
    const pending = session.run(signal => { firstSignal = signal; return new Promise<void>((_, fail) => { reject = fail; }); }, "timeout");
    session.cancel(true);
    expect(firstSignal.aborted).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    await session.run(async () => {}, "timeout");
    reject(new Error("late")); await pending;
    expect(notify).toHaveBeenLastCalledWith({ busy: false, error: "", completed: true });
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it("reports a timeout, aborts download permission and ignores late success", async () => {
    vi.useFakeTimers();
    const notify = vi.fn(), session = createDashboardExportSession(notify);
    let finish!: () => void, signal!: AbortSignal;
    const pending = session.run(value => { signal = value; return new Promise<void>(resolve => { finish = resolve; }); }, "导出超时");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(true);
    expect(notify).toHaveBeenLastCalledWith({ busy: false, error: "导出超时", completed: false });
    finish(); await pending;
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("releases cancellation timers and reports real failure for retry", async () => {
    vi.useFakeTimers();
    const notify = vi.fn(), session = createDashboardExportSession(notify);
    await session.run(async () => { throw new Error("编码失败"); }, "timeout");
    expect(notify).toHaveBeenLastCalledWith({ busy: false, error: "编码失败", completed: false });
    expect(vi.getTimerCount()).toBe(0);
    const pending = session.run(async () => {}, "timeout");
    session.cancel(); await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(notify).toHaveBeenLastCalledWith({ busy: false, error: "", completed: false });
  });
});
