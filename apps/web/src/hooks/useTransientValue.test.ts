import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransientRegistry } from "../viewer/transientChannel.js";
import { useTransientValue } from "./useTransientValue.js";

const store = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  notify: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (subscribe: (notify: () => void) => () => void, snapshot: () => unknown) => {
    store.cleanup = subscribe(store.notify);
    return snapshot();
  },
}));

afterEach(() => {
  store.cleanup?.();
  store.cleanup = undefined;
  store.notify.mockClear();
  vi.useRealTimers();
});

describe("useTransientValue", () => {
  it("取消节流期间的通知，卸载后不再触发回调", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const queue: Array<() => void> = [];
    const registry = createTransientRegistry({
      schedule: (task) => queue.push(task),
      cancel: () => undefined,
    });
    const channel = registry.channel<number>("count");
    channel.publish(0);
    expect(useTransientValue(channel, (value) => value, { throttleMs: 100 })).toBe(0);

    channel.publish(1);
    queue.shift()?.();
    expect(store.notify).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_010);
    channel.publish(2);
    queue.shift()?.();
    expect(vi.getTimerCount()).toBe(1);
    store.cleanup?.();
    vi.advanceTimersByTime(100);
    expect(store.notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    registry.dispose();
  });
});
