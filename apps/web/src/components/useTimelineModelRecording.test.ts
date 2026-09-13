import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";

const hooks = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useEffect: (effect: () => (() => void) | undefined) => { hooks.cleanup = effect(); } }));
import { useTimelineModelRecording } from "./useTimelineModelRecording";

afterEach(() => { hooks.cleanup?.(); hooks.cleanup = undefined; });

function fixture(selected = true) {
  let x = 1;
  const listeners = new Map<string, (event: { value: unknown }) => void>();
  const engine = {
    getSelected: () => selected ? ({ id: "model-1" }) : undefined,
    isModelLocked: () => false,
    getModelTransform: () => ({ position: { x } }),
    transform: {
      addEventListener: (name: string, callback: (event: { value: unknown }) => void) => listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
    },
  } as unknown as ViewerEngine;
  const record = vi.fn();
  useTimelineModelRecording(engine, "auto-key", record);
  return { listeners, record, move: (value: number) => { x = value; }, emit: (value: boolean) => listeners.get("dragging-changed")?.({ value }) };
}

describe("timeline model Auto Key", () => {
  it("records one model frame after a changed transform gesture", () => {
    const f = fixture();
    f.emit(true); f.move(2); f.emit(false);
    expect(f.record).toHaveBeenCalledExactlyOnceWith("model-1");
  });

  it("ignores no-op gestures and transform handles without a model selection", () => {
    const unchanged = fixture(); unchanged.emit(true); unchanged.emit(false);
    const light = fixture(false); light.emit(true); light.move(2); light.emit(false);
    expect(unchanged.record).not.toHaveBeenCalled();
    expect(light.record).not.toHaveBeenCalled();
  });

  it("detaches its listener when the director closes", () => {
    const f = fixture();
    hooks.cleanup?.();
    expect(f.listeners.size).toBe(0);
  });
});
