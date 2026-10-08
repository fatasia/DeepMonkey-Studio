import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioDeepInactiveCandidate, STUDIO_DEEP_INACTIVE_MAX_BYTES } from "./StudioDeepInactiveCandidate";

afterEach(() => vi.useRealTimers());
describe("bounded inactive Deep owner", () => {
  it("retains a scene-lifetime candidate without timed eviction and still invalidates edits", () => {
    vi.useFakeTimers(); const cache = new StudioDeepInactiveCandidate<object>(null);
    const candidate = {}, dispose = vi.fn(); let valid = true;
    cache.retain(candidate, 1024, () => valid, dispose, () => vi.fn());
    vi.advanceTimersByTime(600_000); expect(cache.available).toBe(true);
    valid = false; expect(cache.available).toBe(false); expect(dispose).toHaveBeenCalledOnce();
  });
  it("transfers one healthy candidate and cancels idle/loss listeners", () => {
    vi.useFakeTimers(); const cache = new StudioDeepInactiveCandidate<object>();
    const candidate = {}, dispose = vi.fn(), unsubscribe = vi.fn();
    expect(cache.retain(candidate, 1024, () => true, dispose, () => unsubscribe)).toBe(true);
    expect(cache.take()).toBe(candidate); vi.advanceTimersByTime(30_000);
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(dispose).not.toHaveBeenCalled();
  });
  it("retires a changed scene, lost device, replaced candidate or expired idle owner exactly once", () => {
    vi.useFakeTimers(); const cache = new StudioDeepInactiveCandidate<object>();
    const first = vi.fn(), second = vi.fn(), third = vi.fn(); let valid = true, lost!: () => void;
    cache.retain({}, 1024, () => valid, first, invalidate => { lost = invalidate; return vi.fn(); });
    valid = false; cache.check(); lost(); expect(first).toHaveBeenCalledOnce();
    cache.retain({}, 1024, () => true, second, () => vi.fn());
    cache.retain({}, 1024, () => true, third, () => vi.fn()); expect(second).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000); cache.clear(); expect(third).toHaveBeenCalledOnce();
  });
  it("rejects oversized owners without taking ownership", () => {
    const cache = new StudioDeepInactiveCandidate<object>(), dispose = vi.fn();
    expect(cache.retain({}, STUDIO_DEEP_INACTIVE_MAX_BYTES + 1, () => true, dispose, () => vi.fn())).toBe(false);
    expect(cache.take()).toBeUndefined(); expect(dispose).not.toHaveBeenCalled();
  });
  it.each([312_465_992, 384 * 1024 * 1024])("keeps a measured %s-byte candidate in the single 30-second slot", bytes => {
    vi.useFakeTimers(); const cache = new StudioDeepInactiveCandidate<object>(), candidate = {}, dispose = vi.fn();
    expect(STUDIO_DEEP_INACTIVE_MAX_BYTES).toBe(384 * 1024 * 1024);
    expect(cache.retain(candidate, bytes, () => true, dispose, () => vi.fn())).toBe(true);
    vi.advanceTimersByTime(29_999); expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(dispose).toHaveBeenCalledOnce();
    expect(cache.take()).toBeUndefined();
  });
  it("retires a candidate when its author state can no longer be read", () => {
    const cache = new StudioDeepInactiveCandidate<object>(), dispose = vi.fn(); let readable = true;
    cache.retain({}, 1024, () => { if (!readable) throw new Error("invalid scene"); return true; }, dispose, () => vi.fn());
    readable = false; expect(cache.take()).toBeUndefined(); expect(dispose).toHaveBeenCalledOnce();
  });
});
