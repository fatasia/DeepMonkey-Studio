import { describe, expect, it, vi } from "vitest";
import { TemporalFrameSettler } from "./temporalFrameSettler";

function setup(count?: number, initialDelayFrames = 0) {
  const frames = new Map<number, FrameRequestCallback>();
  const visibility = new Set<() => void>();
  let nextId = 0;
  let visible = true;
  const onError = vi.fn(), onSettled = vi.fn();
  const settler = new TemporalFrameSettler({
    ...(count === undefined ? {} : { frames: count }), initialDelayFrames, onError, onSettled,
    requestFrame: (callback) => { frames.set(++nextId, callback); return nextId; },
    cancelFrame: (id) => { frames.delete(id); },
    isVisible: () => visible,
    subscribeVisibility: (callback) => { visibility.add(callback); return () => { visibility.delete(callback); }; },
  });
  const frame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(16));
  };
  return { settler, frames, visibility, frame, onError, onSettled,
    hide: () => { visible = false; [...visibility].forEach((callback) => callback()); },
    show: () => { visible = true; [...visibility].forEach((callback) => callback()); },
  };
}

describe("temporal frame settler", () => {
  it("notifies idle only after a completed sequence, never cancellation", () => {
    const context = setup(2); context.settler.restart(vi.fn());
    context.frame(); expect(context.onSettled).not.toHaveBeenCalled();
    context.frame(); expect(context.onSettled).toHaveBeenCalledOnce();
    context.settler.restart(vi.fn()); context.settler.cancel();
    context.frame(); expect(context.onSettled).toHaveBeenCalledOnce();
  });
  it("continuous author restarts consume only delay frames then settle all 16 frames", () => {
    const context = setup(16, 1); const render = vi.fn();
    context.settler.restart(render);
    for (let index = 0; index < 100; index++) {
      context.frame();
      context.settler.restart(render);
    }
    expect(render).not.toHaveBeenCalled();
    context.frame();
    expect(render).not.toHaveBeenCalled();
    for (let index = 0; index < 16; index++) context.frame();
    expect(render).toHaveBeenCalledTimes(16);
    expect(context.frames.size).toBe(0);
  });

  it("hidden time consumes neither initial delay nor render budget", () => {
    const context = setup(1, 4); const render = vi.fn();
    context.hide(); context.settler.restart(render);
    for (let index = 0; index < 10; index++) context.frame();
    context.show();
    for (let index = 0; index < 4; index++) context.frame();
    expect(render).not.toHaveBeenCalled();
    context.frame();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 0.5, NaN, Infinity, 5])("rejects invalid delay %s", (initialDelayFrames) => {
    expect(() => new TemporalFrameSettler({ initialDelayFrames, onError: vi.fn() })).toThrow(RangeError);
  });
  it("renders exactly 16 committed frames then removes all scheduling", () => {
    const context = setup();
    const render = vi.fn();
    context.settler.restart(render);
    expect(render).not.toHaveBeenCalled();
    for (let index = 0; index < 20; index++) context.frame();
    expect(render).toHaveBeenCalledTimes(16);
    expect(context.frames.size).toBe(0);
    expect(context.visibility.size).toBe(0);
  });

  it("restart resets the budget and stale RAF cannot consume the new generation", () => {
    const context = setup(2);
    const old = vi.fn(); const current = vi.fn();
    context.settler.restart(old);
    const stale = [...context.frames.values()][0]!;
    context.frame();
    context.settler.restart(current);
    stale(16);
    expect(context.frames.size).toBe(1);
    context.frame(); context.frame(); context.frame();
    expect(old).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it("cancel invalidates a callback already removed from the native RAF queue", () => {
    const context = setup(); const render = vi.fn();
    context.settler.restart(render);
    const stale = [...context.frames.values()][0]!;
    context.settler.cancel(); context.settler.cancel(); stale(16);
    expect(render).not.toHaveBeenCalled();
    expect(context.frames.size).toBe(0);
    expect(context.visibility.size).toBe(0);
  });

  it("hidden documents keep no RAF loop and resume the unspent budget", () => {
    const context = setup(3); const render = vi.fn();
    context.hide(); context.settler.restart(render);
    expect(context.frames.size).toBe(0);
    context.show(); context.frame(); context.hide();
    for (let index = 0; index < 100; index++) context.frame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(context.frames.size).toBe(0);
    context.show(); context.show();
    expect(context.frames.size).toBe(1);
    context.frame(); context.frame();
    expect(render).toHaveBeenCalledTimes(3);
    expect(context.visibility.size).toBe(0);
  });

  it("render may cancel itself without scheduling a trailing frame", () => {
    const context = setup();
    context.settler.restart(() => context.settler.cancel());
    context.frame();
    expect(context.frames.size).toBe(0);
    expect(context.visibility.size).toBe(0);
  });

  it("a hidden-period late callback cannot steal the resumed RAF ticket", () => {
    const context = setup(2); const render = vi.fn();
    context.settler.restart(render);
    const stale = [...context.frames.values()][0]!;
    context.hide(); context.show(); stale(16);
    expect(render).not.toHaveBeenCalled();
    expect(context.frames.size).toBe(1);
    context.frame(); context.frame();
    expect(render).toHaveBeenCalledTimes(2);
    expect(context.frames.size).toBe(0);
  });

  it("render may restart without decrementing or duplicating the new budget", () => {
    const context = setup(2); const next = vi.fn();
    context.settler.restart(() => context.settler.restart(next));
    context.frame();
    expect(context.frames.size).toBe(1);
    context.frame(); context.frame();
    expect(next).toHaveBeenCalledTimes(2);
    expect(context.frames.size).toBe(0);
  });

  it("failure stops the current run and reports the original error once", () => {
    const context = setup(); const error = new Error("device lost");
    context.settler.restart(() => { throw error; });
    context.frame(); context.frame();
    expect(context.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(context.frames.size).toBe(0);
    expect(context.visibility.size).toBe(0);
  });

  it("an old callback that restarts then throws neither cancels nor reports into the replacement", () => {
    const context = setup(1); const next = vi.fn(); const error = new Error("old");
    context.settler.restart(() => { context.settler.restart(next); throw error; });
    context.frame(); context.frame();
    expect(next).toHaveBeenCalledTimes(1);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("render cancellation followed by a throw is retired with its generation", () => {
    const context = setup();
    context.settler.restart(() => { context.settler.cancel(); throw new Error("retired"); });
    context.frame();
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.frames.size).toBe(0);
    expect(context.visibility.size).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 121])("rejects an invalid finite frame budget %s", (frames) => {
    expect(() => new TemporalFrameSettler({ frames, onError: vi.fn() })).toThrow(RangeError);
  });
});
