import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverSceneRouteRead } from "./sceneRouteRecovery";
import { networkStatusMonitor } from "../appStatus/networkStatusMonitor";

const unavailable = Object.assign(new Error("Bad Gateway"), { status: 502 });
let cleanup: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget()); });
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("scene route read recovery", () => {
  it("recovers transient failures and applies exactly once", async () => {
    const read = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue("snapshot");
    const apply = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    cleanup = recoverSceneRouteRead({ read, apply, onError });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledExactlyOnceWith("snapshot");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
  it("bounds backoff and permits only one additional connection recovery attempt", async () => {
    const read = vi.fn().mockRejectedValue(unavailable);
    const onError = vi.fn();
    cleanup = recoverSceneRouteRead({ read, apply: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(7000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);
    networkStatusMonitor.noteTransportDisconnected();
    read.mockResolvedValue("snapshot");
    networkStatusMonitor.recordSuccess();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(5);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(5);
  });
  it.each([401, 403, 404])("does not retry permanent HTTP %s", async status => {
    const read = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { status }));
    cleanup = recoverSceneRouteRead({ read, apply: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(10000);
    window.dispatchEvent(new Event("online"));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not replay a failed application of a fetched snapshot", async () => {
    const read = vi.fn().mockResolvedValue("snapshot");
    const apply = vi.fn().mockRejectedValue(unavailable);
    cleanup = recoverSceneRouteRead({ read, apply, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(10000);
    window.dispatchEvent(new Event("online"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("cancels pending retries on navigation", async () => {
    const read = vi.fn().mockRejectedValue(unavailable);
    cleanup = recoverSceneRouteRead({ read, apply: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("ignores late responses after navigation", async () => {
    let resolve!: (value: string) => void;
    const read = () => new Promise<string>(done => { resolve = done; });
    const apply = vi.fn();
    cleanup = recoverSceneRouteRead({ read, apply, onError: vi.fn() });
    cleanup();
    resolve("old-scene");
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
