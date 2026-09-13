import { describe, expect, it, vi } from "vitest";
import { BackendPreferenceController, type BackendPreferenceStore } from "./backendPreference.js";
import { BackendSwitchCoordinator } from "./backendSwitch.js";

function backend(id: string) { return { id, dispose: vi.fn() }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(storeChanges: Partial<BackendPreferenceStore> = {}) {
  const created = [backend("three")];
  const coordinator = new BackendSwitchCoordinator(created[0]!, {
    state: { revision: 0 },
    prepare: async id => { const value = backend(id); created.push(value); return value; },
    atFrameBoundary: async publish => publish(),
  });
  const store: BackendPreferenceStore = {
    load: vi.fn(async () => null), save: vi.fn(async () => {}), ...storeChanges,
  };
  return { controller: new BackendPreferenceController(coordinator, store, ["three", "deep-webgpu"]),
    coordinator, created, store };
}

describe("BackendPreferenceController", () => {
  it("persists a user choice only after its frame-boundary publication", async () => {
    const gate = deferred<void>();
    let publish!: () => void;
    const first = backend("three"), next = backend("deep-webgpu");
    const coordinator = new BackendSwitchCoordinator(first, {
      state: {}, prepare: async () => next,
      atFrameBoundary: async commit => { publish = commit; await gate.promise; },
    });
    const store = { load: vi.fn(async () => null), save: vi.fn(async () => {}) };
    const controller = new BackendPreferenceController(coordinator, store, ["three", "deep-webgpu"]);
    const selecting = controller.select("deep-webgpu");
    await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
    expect(controller.snapshot).toMatchObject({ activeId: "three", desiredId: "deep-webgpu",
      persistedId: "three", phase: "switching" });
    expect(store.save).not.toHaveBeenCalled();
    publish(); gate.resolve();
    await expect(selecting).resolves.toMatchObject({ status: "applied",
      snapshot: { activeId: "deep-webgpu", desiredId: "deep-webgpu",
        persistedId: "deep-webgpu", phase: "idle" } });
    expect(store.save).toHaveBeenCalledExactlyOnceWith("deep-webgpu");
  });

  it("keeps the usable backend and stored choice when a user switch fails", async () => {
    const first = backend("three");
    const coordinator = new BackendSwitchCoordinator(first, {
      state: {}, prepare: async () => { throw new Error("adapter unavailable"); },
      atFrameBoundary: async publish => publish(),
    });
    const store = { load: vi.fn(async () => null), save: vi.fn(async () => {}) };
    const controller = new BackendPreferenceController(coordinator, store, ["three", "deep-webgpu"]);
    await expect(controller.select("deep-webgpu")).resolves.toMatchObject({ status: "failed",
      snapshot: { activeId: "three", desiredId: "deep-webgpu", persistedId: "three", phase: "error",
        error: "adapter unavailable" } });
    expect(store.save).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("falls back on startup while retaining an unavailable stored preference", async () => {
    const first = backend("three");
    const coordinator = new BackendSwitchCoordinator(first, { state: {},
      prepare: async () => { throw new Error("project unsupported"); },
      atFrameBoundary: async publish => publish() });
    const store = { load: vi.fn(async () => "deep-webgpu"), save: vi.fn(async () => {}) };
    const controller = new BackendPreferenceController(coordinator, store, ["three", "deep-webgpu"]);
    await expect(controller.initialize()).resolves.toMatchObject({ status: "fallback",
      snapshot: { activeId: "three", desiredId: "deep-webgpu", persistedId: "deep-webgpu",
        phase: "fallback", error: "project unsupported" } });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("reports persistence failure without rolling back an active renderer", async () => {
    const { controller, coordinator } = fixture({ save: vi.fn(async () => { throw new Error("quota"); }) });
    await expect(controller.select("deep-webgpu")).resolves.toMatchObject({ status: "persistence-failed",
      snapshot: { activeId: "deep-webgpu", desiredId: "deep-webgpu", persistedId: "three",
        phase: "error", error: "Renderer preference could not be saved: quota" } });
    expect(coordinator.active.id).toBe("deep-webgpu");
  });

  it("orders concurrent persistence and exposes only the latest selection", async () => {
    const firstSave = deferred<void>();
    const calls: string[] = [];
    const { controller } = fixture({ save: vi.fn(async id => {
      calls.push(id); if (id === "deep-webgpu") await firstSave.promise;
    }) });
    const deep = controller.select("deep-webgpu");
    await vi.waitFor(() => expect(calls).toEqual(["deep-webgpu"]));
    const three = controller.select("three");
    firstSave.resolve();
    await expect(deep).resolves.toMatchObject({ status: "superseded" });
    await expect(three).resolves.toMatchObject({ status: "applied",
      snapshot: { activeId: "three", desiredId: "three", persistedId: "three", phase: "idle" } });
    expect(calls).toEqual(["deep-webgpu", "three"]);
  });

  it("rejects unknown targets and safely ignores corrupt stored values", async () => {
    const { controller, store } = fixture({ load: vi.fn(async () => "webgl") });
    await expect(controller.initialize()).resolves.toMatchObject({ status: "fallback",
      snapshot: { activeId: "three", desiredId: "three", persistedId: "three", phase: "fallback" } });
    await expect(controller.select("webgl")).rejects.toThrow("Unknown renderer backend");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not let a late startup read overwrite an explicit user choice", async () => {
    const load = deferred<unknown>();
    const { controller } = fixture({ load: vi.fn(() => load.promise) });
    const startup = controller.initialize();
    await expect(controller.select("deep-webgpu")).resolves.toMatchObject({ status: "applied" });
    load.resolve("three");
    await expect(startup).resolves.toMatchObject({ status: "superseded",
      snapshot: { activeId: "deep-webgpu", desiredId: "deep-webgpu", persistedId: "deep-webgpu" } });
  });
});
