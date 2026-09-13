import { describe, expect, it, vi } from "vitest";
import { BackendSwitchCoordinator, type SwitchableBackend } from "./backendSwitch.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function backend(id: string) { return { id, dispose: vi.fn() }; }
const immediate = async (publish: () => void) => publish();

describe("BackendSwitchCoordinator", () => {
  it("round-trips twenty times with stable user state and exactly one retirement per backend", async () => {
    const created = [backend("three")];
    const state = { selected: "pump", unsaved: true, history: ["move"], script: { ticks: 0 } };
    const coordinator = new BackendSwitchCoordinator(created[0]!, {
      state, prepare: async (id) => { const next = backend(id); created.push(next); return next; },
      atFrameBoundary: immediate,
    });
    for (let index = 0; index < 20; index++) {
      state.script.ticks++;
      expect((await coordinator.switchTo(index % 2 === 0 ? "deep" : "three")).status).toBe("switched");
      expect(coordinator.state).toBe(state);
    }
    expect(state).toMatchObject({ selected: "pump", unsaved: true, history: ["move"], script: { ticks: 20 } });
    expect(created.slice(0, -1).every((item) => item.dispose.mock.calls.length === 1)).toBe(true);
    expect(created.at(-1)!.dispose).not.toHaveBeenCalled();
    coordinator.dispose();
    expect(created.every((item) => item.dispose.mock.calls.length === 1)).toBe(true);
  });
  it("completes a published switch even when the boundary host never resolves", async () => {
    const old = backend("three");
    const next = backend("deep");
    const coordinator = new BackendSwitchCoordinator(old, {
      state: {}, prepare: async () => next,
      atFrameBoundary: async (publish) => { publish(); await new Promise(() => {}); },
    });
    expect((await coordinator.switchTo("deep")).status).toBe("switched");
    expect(coordinator.active).toBe(next);
  });

  it("publishes the candidate surface before retiring the previous backend", async () => {
    const events: string[] = [];
    const old = { id: "three", dispose: vi.fn(() => events.push("retire-three")) };
    const next = backend("deep");
    const coordinator = new BackendSwitchCoordinator(old, {
      state: {}, prepare: async () => next,
      atFrameBoundary: immediate,
      publishSurface: (candidate, previous) => events.push(`surface:${previous.id}->${candidate.id}`),
    });
    expect(await coordinator.switchTo("deep")).toMatchObject({ status: "switched", activeId: "deep" });
    expect(events).toEqual(["surface:three->deep", "retire-three"]);
  });

  it("keeps the old backend active when the surface handoff fails", async () => {
    const old = backend("three"), next = backend("deep");
    const coordinator = new BackendSwitchCoordinator(old, {
      state: {}, prepare: async () => next, atFrameBoundary: immediate,
      publishSurface: () => { throw new Error("surface handoff failed"); },
    });
    expect(await coordinator.switchTo("deep")).toMatchObject({
      status: "failed", activeId: "three", error: "surface handoff failed",
    });
    expect(old.dispose).not.toHaveBeenCalled();
    expect(next.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces a host error after publication without losing the new renderer", async () => {
    const coordinator = new BackendSwitchCoordinator(backend("three"), {
      state: {}, prepare: async () => backend("deep"),
      atFrameBoundary: async (publish) => { publish(); throw new Error("host failure"); },
    });
    expect((await coordinator.switchTo("deep")).status).toBe("switched");
    await vi.waitFor(() => expect(coordinator.diagnostics).toContain("frame-boundary: host failure"));
  });
  it("keeps live state and the old renderer until publication at the frame boundary", async () => {
    const old = backend("three");
    const next = backend("deep");
    const state = { camera: [1, 2, 3], selection: ["pump"], scriptTicks: 4, unsaved: true };
    const boundary = deferred<void>();
    let publish!: () => void;
    const coordinator = new BackendSwitchCoordinator(old, {
      state, prepare: async (_, received) => { expect(received).toBe(state); return next; },
      atFrameBoundary: async (commit) => { publish = commit; await boundary.promise; },
    });
    const request = coordinator.switchTo("deep");
    await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
    expect(coordinator.active).toBe(old);
    expect(old.dispose).not.toHaveBeenCalled();
    state.scriptTicks++;
    publish(); boundary.resolve();
    expect((await request).status).toBe("switched");
    expect(coordinator.active).toBe(next);
    expect(coordinator.state).toBe(state);
    expect(state.scriptTicks).toBe(5);
    expect(old.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps the current renderer on preparation or frame boundary failure", async () => {
    for (const failPrepare of [true, false]) {
      const old = backend("three");
      const next = backend("deep");
      const coordinator = new BackendSwitchCoordinator(old, {
        state: {}, prepare: async () => { if (failPrepare) throw new Error("unsupported"); return next; },
        atFrameBoundary: async () => { throw new Error("surface lost"); },
      });
      expect((await coordinator.switchTo("deep")).status).toBe("failed");
      expect(coordinator.active).toBe(old);
      expect(old.dispose).not.toHaveBeenCalled();
      expect(next.dispose.mock.calls.length).toBe(failPrepare ? 0 : 1);
    }
  });

  it("cancels an in-flight switch back to the active choice and cleans late results", async () => {
    const old = backend("three");
    const late = backend("deep");
    const waiting = deferred<typeof late>();
    const prepare = vi.fn(() => waiting.promise);
    const coordinator = new BackendSwitchCoordinator(old, { state: {}, prepare, atFrameBoundary: immediate });
    const first = coordinator.switchTo("deep");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect((await coordinator.switchTo("three")).status).toBe("unchanged");
    expect((await first).status).toBe("cancelled");
    waiting.resolve(late);
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(coordinator.active).toBe(old);
  });

  it("allows only the latest request to publish", async () => {
    const old = backend("three");
    const late = backend("deep-a");
    const newest = backend("deep-b");
    const waiting = deferred<typeof late>();
    const prepare = vi.fn((id: string) => id === "deep-a" ? waiting.promise : Promise.resolve(newest));
    const coordinator = new BackendSwitchCoordinator(old, { state: {}, prepare, atFrameBoundary: immediate });
    const first = coordinator.switchTo("deep-a");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect((await coordinator.switchTo("deep-b")).status).toBe("switched");
    expect((await first).status).toBe("cancelled");
    waiting.resolve(late);
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(coordinator.active).toBe(newest);
    expect(old.dispose).toHaveBeenCalledOnce();
  });

  it("times out non-cooperative preparation without losing the active renderer", async () => {
    vi.useFakeTimers();
    try {
      const old = backend("three");
      const late = backend("deep");
      const waiting = deferred<typeof late>();
      const coordinator = new BackendSwitchCoordinator(old, {
        state: {}, timeoutMs: 20, prepare: () => waiting.promise, atFrameBoundary: immediate,
      });
      const pending = coordinator.switchTo("deep");
      await vi.advanceTimersByTimeAsync(21);
      expect(await pending).toMatchObject({ status: "failed", error: "Backend preparation timed out." });
      waiting.resolve(late);
      await vi.runAllTimersAsync();
      expect(late.dispose).toHaveBeenCalledOnce();
      expect(coordinator.active).toBe(old);
    } finally { vi.useRealTimers(); }
  });

  it("invalidates a delayed publish after timeout", async () => {
    vi.useFakeTimers();
    try {
      let publish!: () => void;
      const old = backend("three");
      const next = backend("deep");
      const coordinator = new BackendSwitchCoordinator(old, {
        state: {}, timeoutMs: 10, prepare: async () => next,
        atFrameBoundary: async (commit) => { publish = commit; await new Promise(() => {}); },
      });
      const request = coordinator.switchTo("deep");
      await vi.advanceTimersByTimeAsync(11);
      expect((await request).status).toBe("failed");
      publish();
      expect(coordinator.active).toBe(old);
      expect(next.dispose).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("reports cleanup errors without rolling back an already published backend", async () => {
    const old = backend("three");
    old.dispose.mockImplementation(() => { throw new Error("retirement failed"); });
    const next = backend("deep");
    const coordinator = new BackendSwitchCoordinator(old, { state: {}, prepare: async () => next, atFrameBoundary: immediate });
    expect(await coordinator.switchTo("deep")).toMatchObject({ status: "switched", cleanupErrors: ["three: retirement failed"] });
    coordinator.dispose(); coordinator.dispose();
    expect(next.dispose).toHaveBeenCalledOnce();
    expect((await coordinator.switchTo("three")).status).toBe("failed");
  });

  it("does not release the active backend if a factory returns it accidentally", async () => {
    const old = backend("three");
    const coordinator = new BackendSwitchCoordinator(old, { state: {}, prepare: async () => old, atFrameBoundary: immediate });
    expect((await coordinator.switchTo("deep")).status).toBe("failed");
    expect(old.dispose).not.toHaveBeenCalled();
  });

  it("cleans pending resources when the coordinator is disposed", async () => {
    const old = backend("three");
    const late = backend("deep");
    const waiting = deferred<SwitchableBackend>();
    const prepare = vi.fn(() => waiting.promise);
    const coordinator = new BackendSwitchCoordinator<{}, SwitchableBackend>(old, { state: {}, prepare, atFrameBoundary: immediate });
    const request = coordinator.switchTo("deep");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    coordinator.dispose();
    expect((await request).status).toBe("cancelled");
    waiting.resolve(late);
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(old.dispose).toHaveBeenCalledOnce();
  });
});
