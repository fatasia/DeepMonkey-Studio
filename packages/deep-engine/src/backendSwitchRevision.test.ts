import { describe, expect, it, vi } from "vitest";
import { BackendSwitchCoordinator, type SwitchableBackend } from "./backendSwitch.js";

function backend(id: string) { return { id, dispose: vi.fn() }; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("BackendSwitchCoordinator revision barrier", () => {
  it("re-synchronizes when author state advances before the frame boundary", async () => {
    const state = { revision: 7, scriptTicks: 12 };
    const old = backend("three"), next = backend("deep");
    const revisions: number[] = [];
    let boundaries = 0;
    const coordinator = new BackendSwitchCoordinator(old, {
      state,
      prepare: async (_, received) => { expect(received).toBe(state); return next; },
      revisionBarrier: {
        read: value => value.revision,
        catchUp: async (candidate, received, revision) => {
          expect(candidate).toBe(next); expect(received).toBe(state);
          revisions.push(revision as number); return revision;
        },
      },
      atFrameBoundary: async publish => {
        boundaries++;
        if (boundaries === 1) { state.revision++; state.scriptTicks++; }
        publish();
      },
    });
    await expect(coordinator.switchTo("deep")).resolves.toMatchObject({ status: "switched", activeId: "deep" });
    expect(revisions).toEqual([7, 8]);
    expect(state).toEqual({ revision: 8, scriptTicks: 13 });
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).not.toHaveBeenCalled();
  });

  it("rejects a candidate that reports a different applied revision", async () => {
    const old = backend("three"), next = backend("deep");
    const coordinator = new BackendSwitchCoordinator(old, {
      state: { revision: "scene-9" }, prepare: async () => next,
      revisionBarrier: { read: state => state.revision, catchUp: async () => "scene-8" },
      atFrameBoundary: async publish => publish(),
    });
    await expect(coordinator.switchTo("deep")).resolves.toMatchObject({
      status: "failed", activeId: "three", error: "Prepared backend did not accept the requested author revision.",
    });
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(old.dispose).not.toHaveBeenCalled();
  });

  it("times out a non-cooperative catch-up and retires its candidate", async () => {
    vi.useFakeTimers();
    try {
      const old = backend("three"), next = backend("deep");
      const coordinator = new BackendSwitchCoordinator(old, {
        state: { revision: 1 }, timeoutMs: 20, prepare: async () => next,
        revisionBarrier: { read: state => state.revision, catchUp: () => new Promise(() => {}) },
        atFrameBoundary: async publish => publish(),
      });
      const switching = coordinator.switchTo("deep");
      await vi.advanceTimersByTimeAsync(21);
      await expect(switching).resolves.toMatchObject({ status: "failed", activeId: "three",
        error: "Backend preparation timed out." });
      expect(next.dispose).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("cancels catch-up when a newer target wins and ignores the late result", async () => {
    const old = backend("three"), first = backend("deep-a"), newest = backend("deep-b");
    const gate = deferred<number>();
    const coordinator = new BackendSwitchCoordinator(old, {
      state: { revision: 4 },
      prepare: async id => id === "deep-a" ? first : newest,
      revisionBarrier: {
        read: state => state.revision,
        catchUp: candidate => candidate === first ? gate.promise : Promise.resolve(4),
      },
      atFrameBoundary: async publish => publish(),
    });
    const stale = coordinator.switchTo("deep-a");
    await vi.waitFor(() => expect(first.dispose).not.toHaveBeenCalled());
    await expect(coordinator.switchTo("deep-b")).resolves.toMatchObject({ status: "switched", activeId: "deep-b" });
    await expect(stale).resolves.toMatchObject({ status: "cancelled" });
    expect(first.dispose).toHaveBeenCalledOnce();
    gate.resolve(4);
    await Promise.resolve();
    expect(coordinator.active).toBe(newest);
  });
});
