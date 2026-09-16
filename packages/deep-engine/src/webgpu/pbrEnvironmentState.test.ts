import { describe, expect, it, vi } from "vitest";
import { PbrEnvironmentState } from "./pbrEnvironmentState.js";

const environment = (name: string) => ({ name, specular: {}, diffuse: {}, brdf: {}, sampler: {},
  dispose: vi.fn() });

describe("PBR environment frame-boundary state", () => {
  it("retains the old environment until a frame succeeds and rolls back submission failures", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never), activate = vi.fn();
    await state.stage(async () => candidate as never);
    expect(() => state.runFrame(() => {
      expect(state.beginFrame(activate)).toBe(candidate);
      expect(initial.dispose).not.toHaveBeenCalled();
      throw Error("submission rejected");
    }, activate)).toThrow("submission rejected");
    expect(activate.mock.calls.map(call => call[0])).toEqual([candidate, initial]);
    expect(state.current).toBe(initial); expect(initial.dispose).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce(); state.dispose();
  });
  it("rolls back a zero-size frame and retires the old environment only after a successful frame", async () => {
    const initial = environment("initial"), cancelled = environment("cancelled"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never);
    await state.stage(async () => cancelled as never);
    expect(state.runFrame(() => { state.beginFrame(); return undefined; }, () => {})).toBeUndefined();
    expect(state.current).toBe(initial); expect(cancelled.dispose).toHaveBeenCalledOnce();
    await state.stage(async () => candidate as never);
    expect(state.runFrame(() => { state.beginFrame(); expect(initial.dispose).not.toHaveBeenCalled(); return 1; }, () => {})).toBe(1);
    expect(state.current).toBe(candidate); expect(initial.dispose).toHaveBeenCalledOnce(); state.dispose();
  });
  it("releases a failed candidate even if restoring bindings throws", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never);
    await state.stage(async () => candidate as never);
    expect(() => state.runFrame(() => { state.beginFrame(); throw Error("submit failed"); },
      () => { throw Error("restore failed"); })).toThrow("PBR environment frame failed");
    expect(state.current).toBe(initial); expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(initial.dispose).not.toHaveBeenCalled(); state.dispose();
  });
  it("does not destroy a committed candidate when retirement throws", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never), restore = vi.fn();
    initial.dispose.mockImplementationOnce(() => { throw Error("retirement failed"); });
    await state.stage(async () => candidate as never);
    expect(() => state.runFrame(() => { state.beginFrame(); return 1; }, restore)).toThrow("retirement failed");
    expect(state.current).toBe(candidate); expect(candidate.dispose).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled(); state.dispose();
  });
  it("does not publish or leak a candidate if activation disposes the state", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never);
    await state.stage(async () => candidate as never);
    expect(state.publish(() => state.dispose())).toBeUndefined();
    expect(initial.dispose).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    state.dispose();
    expect(initial.dispose).toHaveBeenCalledOnce();
  });

  it("still releases the active environment if pending cleanup throws", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    candidate.dispose.mockImplementation(() => { throw new Error("pending cleanup"); });
    const state = new PbrEnvironmentState(initial as never);
    await state.stage(async () => candidate as never);
    expect(() => state.dispose()).toThrow("PBR environment cleanup failed");
    expect(initial.dispose).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    state.dispose();
    expect(initial.dispose).toHaveBeenCalledOnce();
  });
  it("cancels a staged environment before publication without touching the active frame", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never), controller = new AbortController();
    await state.stage(async () => candidate as never, controller.signal);
    controller.abort();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(state.current).toBe(initial);
    expect(state.publish()).toBeUndefined();
    expect(initial.dispose).not.toHaveBeenCalled();
    state.dispose();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("detaches cancellation after publication and when a newer candidate replaces it", async () => {
    const state = new PbrEnvironmentState(environment("initial") as never);
    const first = environment("first"), second = environment("second");
    const old = new AbortController(), current = new AbortController();
    await state.stage(async () => first as never, old.signal);
    await state.stage(async () => second as never, current.signal);
    old.abort();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(state.publish()).toBe(second);
    current.abort();
    expect(second.dispose).not.toHaveBeenCalled();
    state.dispose();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("does not replace a staged candidate or invoke the factory for an already cancelled request", async () => {
    const state = new PbrEnvironmentState(environment("initial") as never), candidate = environment("candidate");
    await state.stage(async () => candidate as never);
    const controller = new AbortController(); controller.abort();
    const factory = vi.fn(async () => environment("cancelled") as never);
    await expect(state.stage(factory, controller.signal)).rejects.toThrow("cancelled");
    expect(factory).not.toHaveBeenCalled();
    expect(state.publish()).toBe(candidate);
    state.dispose();
  });
  it("keeps the active environment until a complete candidate is published", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never);
    expect(await state.stage(async () => candidate as never)).toBe("staged");
    expect(state.current).toBe(initial);
    expect(state.publish()).toBe(candidate);
    expect(initial.dispose).toHaveBeenCalledOnce();
    expect(state.publish()).toBeUndefined();
    state.dispose();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("aborts and disposes a late superseded candidate", async () => {
    const initial = environment("initial"), late = environment("late"), current = environment("current");
    const state = new PbrEnvironmentState(initial as never);
    let finish!: (value: never) => void, firstSignal: AbortSignal | undefined;
    const first = state.stage(signal => { firstSignal = signal;
      return new Promise(resolve => { finish = resolve; }); });
    expect(await state.stage(async () => current as never)).toBe("staged");
    expect(firstSignal?.aborted).toBe(true);
    finish(late as never);
    expect(await first).toBe("superseded");
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(state.publish()).toBe(current);
  });

  it("treats an abort-aware superseded factory as superseded", async () => {
    const state = new PbrEnvironmentState(environment("initial") as never);
    const first = state.stage(signal => new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    await state.stage(async () => environment("current") as never);
    await expect(first).resolves.toBe("superseded");
    state.dispose();
  });

  it("preserves last-known-good state on factory failure and disposes an unpublished candidate", async () => {
    const initial = environment("initial"), pending = environment("pending");
    const state = new PbrEnvironmentState(initial as never);
    await state.stage(async () => pending as never);
    await expect(state.stage(async () => { throw new Error("compile failed"); })).rejects.toThrow("compile failed");
    expect(state.current).toBe(initial);
    expect(state.publish()).toBeUndefined();
    expect(pending.dispose).toHaveBeenCalledOnce();
    state.dispose();
    expect(initial.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the active environment when frame-boundary activation fails", async () => {
    const initial = environment("initial"), candidate = environment("candidate");
    const state = new PbrEnvironmentState(initial as never);
    await state.stage(async () => candidate as never);
    expect(() => state.publish(() => { throw new Error("binding failed"); })).toThrow("binding failed");
    expect(state.current).toBe(initial);
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });
});
