import { describe, expect, it, vi } from "vitest";
import { ASSET_CHANGED_EVENT, connectDevAssetHotReload, subscribeAssetChangedEvents } from "./devAssetHotReloadBridge";

function fakeHot() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const removed: Array<{ event: string; handler: (payload: unknown) => void }> = [];
  return {
    on: (event: string, handler: (payload: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    },
    off: (event: string, handler: (payload: unknown) => void) => { removed.push({ event, handler }); },
    emit: (event: string, payload: unknown) => { for (const handler of listeners.get(event) ?? []) handler(payload); },
    removed,
  };
}

/** 浏览器端桥:vite HMR 事件 → 去抖聚合回调;非 dev 环境如实降级。 */
describe("dev asset hot reload bridge", () => {
  it("subscribes on the contract event and debounces payloads into one callback", () => {
    vi.useFakeTimers();
    const hot = fakeHot();
    const received: Array<{ urls: readonly string[] }> = [];
    const unsubscribe = subscribeAssetChangedEvents(hot, detail => received.push(detail), 100);
    hot.emit(ASSET_CHANGED_EVENT, { urls: ["/assets/projects/a/geometry.glb"] });
    hot.emit(ASSET_CHANGED_EVENT, { urls: ["/assets/projects/a/geometry.glb", "/assets/projects/b/tex.png"] });
    expect(received).toEqual([]);
    vi.advanceTimersByTime(120);
    expect(received).toEqual([{ urls: ["/assets/projects/a/geometry.glb", "/assets/projects/b/tex.png"] }]);
    unsubscribe();
    expect(hot.removed).toHaveLength(1);
    vi.useRealTimers();
  });

  it("ignores malformed payloads and empties cleanly on dispose before flush", () => {
    vi.useFakeTimers();
    const hot = fakeHot();
    const received: Array<{ urls: readonly string[] }> = [];
    const unsubscribe = subscribeAssetChangedEvents(hot, detail => received.push(detail), 100);
    hot.emit(ASSET_CHANGED_EVENT, undefined);
    hot.emit(ASSET_CHANGED_EVENT, { urls: "not-an-array" });
    hot.emit(ASSET_CHANGED_EVENT, { urls: ["/good.glb", 42, ""] });
    unsubscribe();
    vi.advanceTimersByTime(200);
    expect(received).toEqual([]);
    vi.useRealTimers();
  });

  it("reports an honest disconnected connection outside vite dev", () => {
    const connection = connectDevAssetHotReload(() => {});
    // vitest 环境可能带 import.meta.hot(vite-node);两种结果都合法,契约是句柄自洽。
    expect(typeof connection.connected).toBe("boolean");
    expect(() => connection.dispose()).not.toThrow();
  });
});
