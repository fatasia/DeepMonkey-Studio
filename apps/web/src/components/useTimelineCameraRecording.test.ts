import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";

const hooks = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useEffect: (effect: () => (() => void) | undefined) => { hooks.cleanup = effect(); } }));
import { useTimelineCameraRecording } from "./useTimelineCameraRecording";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { hooks.cleanup?.(); hooks.cleanup = undefined; vi.useRealTimers(); });

function fixture() {
  let x = 1;
  const listeners = new Map<string, () => void>();
  const engine = { getCameraState: () => ({ position: { x } }), orbit: {
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } } as unknown as ViewerEngine;
  const record = vi.fn();
  useTimelineCameraRecording(engine, "frame", record);
  return { record, listeners, emit: (name: string) => listeners.get(name)?.(), move: (value: number) => { x = value; } };
}

describe("selected timeline camera recording", () => {
  it("ignores camera seeks and no-op gestures", () => {
    const f = fixture();
    f.move(2); f.emit("change"); f.emit("end"); vi.advanceTimersByTime(300);
    f.emit("start"); f.emit("end"); vi.advanceTimersByTime(300);
    expect(f.record).not.toHaveBeenCalled();
  });
  it("records the settled gesture once, not during a long drag or damping", () => {
    const f = fixture(); f.emit("start"); f.move(2); f.emit("change");
    vi.advanceTimersByTime(500); expect(f.record).not.toHaveBeenCalled();
    f.emit("end"); vi.advanceTimersByTime(100); f.move(3); f.emit("change");
    vi.advanceTimersByTime(159); expect(f.record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(f.record).toHaveBeenCalledExactlyOnceWith({ position: { x: 3 } });
  });
  it("cancels late writes when the selected frame or panel is left", () => {
    const f = fixture(); f.emit("start"); f.move(4); f.emit("end");
    hooks.cleanup?.(); vi.advanceTimersByTime(300);
    expect(f.listeners.size).toBe(0); expect(f.record).not.toHaveBeenCalled();
  });
});
