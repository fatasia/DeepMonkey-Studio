import { describe, expect, it, vi } from "vitest";
import { PbrEnvironmentState } from "./pbrEnvironmentState.js";

const environment = (name: string) => ({ name, specular: {}, diffuse: {}, brdf: {}, sampler: {},
  dispose: vi.fn() });

describe("PBR environment frame-boundary state", () => {
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
