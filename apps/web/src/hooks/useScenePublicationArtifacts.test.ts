import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import type { PreparedSceneClientPackage } from "../delivery/sceneClientPackage";
import { createSceneArtifactRecord } from "../controllers/scenePublicationArtifactRecord";

const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: [] as Array<() => void>,
  setups: [] as Array<() => void>, cleanups: [] as Array<(() => void) | undefined>, restore: vi.fn(), save: vi.fn(), history: vi.fn(), exportPackage: vi.fn() }));
vi.mock("react", () => ({
  useRef: (value: unknown) => harness.cells[harness.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = harness.cursor++, cells = harness.cells; if (!(index in cells)) cells[index] = initial;
    return [cells[index], (value: unknown) => { cells[index] = value; }];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = harness.cursor++, prior = harness.cells[index] as { deps: unknown[]; callback: unknown } | undefined;
    if (!prior || prior.deps.some((value, slot) => !Object.is(value, deps[slot]))) harness.cells[index] = { callback, deps };
    return (harness.cells[index] as { callback: unknown }).callback;
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = harness.cursor++, prior = harness.cells[index] as unknown[] | undefined;
    if (!prior || prior.some((value, slot) => !Object.is(value, deps[slot]))) {
      harness.cells[index] = deps;
      harness.setups[index] = () => { harness.cleanups[index]?.(); harness.cleanups[index] = effect() || undefined; };
      harness.effects.push(harness.setups[index]!);
    }
  },
}));
vi.mock("../api", () => ({ api: { listScenePublications: harness.history } }));
vi.mock("../delivery/sceneClientPackage", () => ({ exportSceneClientPackage: harness.exportPackage }));
vi.mock("../controllers/scenePublicationArtifactStore", () => ({ restoreSceneArtifactRecords: harness.restore, saveSceneArtifactRecord: harness.save }));
import { useScenePublicationArtifacts } from "./useScenePublicationArtifacts";

const at = "2026-09-15T12:00:00.000Z";
const publication: PublishedSceneRecord = { sceneId: "scene", projectId: "project", version: 1, name: "发布", publishedAt: at,
  snapshot: { schemaVersion: 1, id: "scene", projectId: "project", name: "发布", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at } };
const options = { target: "three-webview", renderer: "webgl", toolbarVisible: false } as const;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function unmount() { harness.cleanups.splice(0).forEach(cleanup => cleanup?.()); }
function render(ownerId: string | undefined = "owner") {
  harness.cursor = 0; const value = useScenePublicationArtifacts(ownerId); harness.effects.splice(0).forEach(effect => effect()); return value;
}
beforeEach(() => {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: "exclusive" }); } finally { held.delete(name); }
  } } });
  harness.cells = []; harness.effects = []; harness.cleanups = []; harness.setups = []; vi.resetAllMocks();
  harness.restore.mockResolvedValue([]); harness.save.mockResolvedValue(undefined); harness.history.mockResolvedValue([publication]);
  harness.exportPackage.mockResolvedValue({ fileName: "scene.zip", target: "three-webview", assetCount: 0, applicationCount: 0, connectionCount: 0 });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("App publication artifacts", () => {
  it("forwards the initial prepared identity and drops it for an explicit history retry", async () => {
    const prepared = Object.freeze({ identity: () => undefined }) as unknown as PreparedSceneClientPackage;
    const replacement = Object.freeze({ identity: () => undefined }) as unknown as PreparedSceneClientPackage;
    harness.exportPackage.mockRejectedValueOnce(new Error("temporary failure"));
    const app = render(), first = app.begin(publication, options, prepared);
    expect(render().begin(publication, options, replacement)).toBe(first);
    const failed = await first;
    expect(failed.record.status).toBe("failed");
    expect(harness.exportPackage.mock.calls[0]![0].prepared).toBe(prepared);
    expect(harness.save.mock.calls.every(([, record]) => !Object.hasOwn(record, "prepared"))).toBe(true);
    expect((await app.retry(failed.record)).record.status).toBe("ready");
    expect(harness.exportPackage.mock.calls[1]![0]).not.toHaveProperty("prepared");
  });

  it("never exports a prepared handle belonging to the owner who left during restore", async () => {
    const gate = deferred<unknown[]>(); harness.restore.mockReturnValueOnce(gate.promise);
    const prepared = Object.freeze({ identity: () => undefined }) as unknown as PreparedSceneClientPackage;
    const running = render("A").begin(publication, options, prepared);
    const cancelled = expect(running).rejects.toThrow("取消"); await flush(); render("B");
    gate.resolve([]); await cancelled; expect(harness.exportPackage).not.toHaveBeenCalled();
    expect(render("B").records).toEqual([]);
  });

  it("shares the in-flight scene read then reacquires storage on the next explicit load", async () => {
    const gate = deferred<ReturnType<typeof createSceneArtifactRecord>[]>();
    harness.restore.mockReturnValueOnce(gate.promise);
    const app = render(), first = app.load("project", "scene"), duplicate = app.load("project", "scene");
    expect(duplicate).toBe(first); await flush();
    expect(harness.restore).toHaveBeenCalledTimes(1); expect(render().loading).toBe(true);
    gate.resolve([]); await first;
    expect(render().loading).toBe(false);
    const ready = { ...createSceneArtifactRecord(publication, options), status: "ready" as const, attemptId: 2 };
    harness.restore.mockResolvedValueOnce([ready]);
    const refreshed = app.load("project", "scene"); expect(refreshed).not.toBe(first);
    expect(await refreshed).toEqual([ready]);
    expect(harness.restore).toHaveBeenCalledTimes(2); expect(render().records).toEqual([ready]);
  });

  it("keeps the scene lock during a failed final cancellation write and exposes the storage error", async () => {
    const build = deferred<unknown>(), write = deferred<void>();
    harness.exportPackage.mockReturnValueOnce(build.promise);
    harness.save.mockImplementation(async (_owner, record) => {
      if (record.status === "cancelled") { await write.promise; throw new Error("cancel persistence failed"); }
    });
    const app = render(), running = app.begin(publication, options);
    const failure = expect(running).rejects.toThrow("cancel persistence failed");
    await flush(); app.cancel(createSceneArtifactRecord(publication, options).key); await flush();
    const lockName = `scene-artifact-lock:${JSON.stringify(["owner", "project", "scene"])}`;
    const availability = () => navigator.locks.request(lockName, { mode: "exclusive", ifAvailable: true }, lock => !!lock);
    expect(await availability()).toBe(false);
    expect(harness.exportPackage.mock.calls[0]![0].signal.aborted).toBe(true);
    write.resolve(undefined); await failure;
    expect(render().error).toBe("cancel persistence failed"); expect(await availability()).toBe(true);
  });

  it("rejects a different target for the same scene without disturbing the running artifact", async () => {
    const build = deferred<unknown>(); harness.exportPackage.mockReturnValueOnce(build.promise);
    const app = render(), first = app.begin(publication, options); await flush();
    await expect(app.begin(publication, { ...options, target: "deep-native" })).rejects.toThrow("正在执行");
    expect(harness.exportPackage).toHaveBeenCalledTimes(1);
    expect(harness.exportPackage.mock.calls[0]![0].signal.aborted).toBe(false);
    expect((await app.load("project", "scene"))[0]?.status).toBe("building");
    expect(harness.restore).toHaveBeenCalledTimes(1);
    build.resolve({}); expect((await first).record.status).toBe("ready");
  });

  it("rejects another tab through cancellation persistence and resumes from the latest stored attempt", async () => {
    const disk = new Map<string, ReturnType<typeof createSceneArtifactRecord>>();
    const cancelledWrite = deferred<void>(), exported = deferred<unknown>();
    harness.restore.mockImplementation(async () => [...disk.values()].map(record => structuredClone(record)));
    harness.save.mockImplementation(async (_owner, record) => {
      if (record.status === "cancelled") await cancelledWrite.promise;
      disk.set(record.key, structuredClone(record));
    });
    harness.exportPackage.mockReturnValueOnce(exported.promise);
    const first = render(), running = first.begin(publication, options); await flush();
    expect([...disk.values()][0]?.status).toBe("building");
    // 独立 React hook 状态模拟第二个标签页，共用浏览器锁与持久化适配器。
    harness.cells = []; harness.effects = []; harness.cleanups = []; harness.setups = [];
    const second = render();
    await expect(second.load("project", "scene")).rejects.toThrow("正在执行");
    await expect(second.begin(publication, options)).rejects.toThrow("正在执行");
    expect(harness.restore).toHaveBeenCalledTimes(1);
    expect(harness.exportPackage).toHaveBeenCalledTimes(1);
    first.cancel(createSceneArtifactRecord(publication, options).key); await flush();
    await expect(second.load("project", "scene")).rejects.toThrow("正在执行");
    cancelledWrite.resolve(); await running;
    expect((await second.retry(createSceneArtifactRecord(publication, options))).record).toMatchObject({ status: "ready", attemptId: 2 });
    expect(harness.exportPackage).toHaveBeenCalledTimes(2);
  });

  it("refreshes cached records on explicit load after another tab has finished", async () => {
    const record = createSceneArtifactRecord(publication, options), app = render();
    await app.load("project", "scene");
    harness.restore.mockResolvedValue([{ ...record, status: "ready", attemptId: 4 }]);
    await app.load("project", "scene");
    expect(render().records[0]).toMatchObject({ status: "ready", attemptId: 4 });
    expect(harness.restore).toHaveBeenCalledTimes(2);
  });

  it("rejects stale callbacks after unmount and supports StrictMode effect replay", async () => {
    const app = render(); unmount();
    await expect(app.begin(publication, options)).rejects.toThrow("登录");
    await expect(app.load("project", "scene")).rejects.toThrow("登录");
    await expect(app.retry(createSceneArtifactRecord(publication, options))).rejects.toThrow("登录");
    expect(harness.restore).not.toHaveBeenCalled();
    harness.setups.forEach(setup => setup());
    await render().begin(publication, options); expect(render().records[0]?.status).toBe("ready");
  });

  it("invalidates callbacks across owner A to B to A even when the id matches again", async () => {
    const old = render("A"); render("B"); const latest = render("A");
    await expect(old.begin(publication, options)).rejects.toThrow("登录");
    await expect(old.load("project", "scene")).rejects.toThrow("登录");
    await latest.begin(publication, options); expect(render("A").records[0]?.status).toBe("ready");
  });

  it("waits for previous owner cancellation persistence before restoring on return", async () => {
    const exported = deferred<unknown>(), cancelledWrite = deferred<void>();
    harness.exportPackage.mockReturnValueOnce(exported.promise);
    harness.save.mockImplementation(async (_owner, record) => { if (record.status === "cancelled") await cancelledWrite.promise; });
    const first = render("A").begin(publication, options); await flush();
    render("B"); const second = render("A").begin(publication, options); await flush();
    expect(harness.restore).toHaveBeenCalledTimes(1); expect(harness.exportPackage).toHaveBeenCalledTimes(1);
    cancelledWrite.resolve(undefined); await first; await second;
    expect(harness.restore).toHaveBeenCalledTimes(2); expect(render("A").records[0]?.status).toBe("ready");
  });

  it("preserves the pending retirement barrier across empty owner sessions", async () => {
    const exported = deferred<unknown>(), cancelledWrite = deferred<void>();
    harness.exportPackage.mockReturnValueOnce(exported.promise);
    harness.save.mockImplementation(async (_owner, record) => { if (record.status === "cancelled") await cancelledWrite.promise; });
    const first = render("A").begin(publication, options); await flush();
    render("B"); render("A"); render("B");
    const latest = render("A").begin(publication, options); await flush();
    expect(harness.restore).toHaveBeenCalledTimes(1); expect(harness.exportPackage).toHaveBeenCalledTimes(1);
    cancelledWrite.resolve(undefined); await first; await latest;
    expect(harness.restore).toHaveBeenCalledTimes(2); expect(render("A").records[0]?.status).toBe("ready");
  });

  it("keeps callbacks and a single task across renders and duplicate requests", async () => {
    const gate = deferred<unknown>(); harness.exportPackage.mockReturnValue(gate.promise);
    const first = render(), running = first.begin(publication, options); await flush();
    const next = render(); expect(next.begin).toBe(first.begin); expect(next.begin(publication, options)).toBe(running);
    expect(next.records[0]?.status).toBe("building"); expect(harness.exportPackage).toHaveBeenCalledTimes(1);
    gate.resolve({ fileName: "scene.zip" }); await running; expect(render().records[0]?.status).toBe("ready");
  });

  it("waits for its initial read, refreshes under the execution lock and does not reclassify a live task", async () => {
    const restore = deferred<unknown[]>(), build = deferred<unknown>();
    harness.restore.mockReturnValue(restore.promise); harness.exportPackage.mockReturnValue(build.promise);
    const app = render(), loaded = app.load("project", "scene"), running = app.begin(publication, options);
    await flush(); expect(harness.exportPackage).not.toHaveBeenCalled(); expect(render().loading).toBe(true);
    restore.resolve([]); await loaded; await flush(); await render().load("project", "scene");
    expect(harness.restore).toHaveBeenCalledTimes(2); expect(render().records[0]?.status).toBe("building");
    build.resolve({}); await running;
  });

  it("displays restore storage failure and allows an explicit retry without exporting first", async () => {
    harness.restore.mockRejectedValueOnce(new Error("IDB unavailable")); const app = render();
    await expect(app.begin(publication, options)).rejects.toThrow("IDB unavailable");
    expect(render().error).toBe("IDB unavailable"); expect(harness.exportPackage).not.toHaveBeenCalled();
    await app.begin(publication, options); expect(render().error).toBeUndefined(); expect(harness.restore).toHaveBeenCalledTimes(2);
  });

  it("exposes record-write failure instead of reporting a successful artifact", async () => {
    harness.save.mockRejectedValueOnce(new Error("disk full")); const app = render();
    await expect(app.begin(publication, options)).rejects.toThrow("disk full");
    expect(render().error).toBe("disk full"); expect(harness.history).not.toHaveBeenCalled(); expect(harness.exportPackage).not.toHaveBeenCalled();
  });

  it("retries only the exact historical publication and carries the next attempt", async () => {
    const failed = { ...createSceneArtifactRecord(publication, options), attemptId: 3, status: "failed" as const };
    harness.restore.mockResolvedValue([failed]); const app = render();
    expect((await app.retry(failed)).record).toMatchObject({ status: "ready", attemptId: 4 });
    expect(harness.history).toHaveBeenCalledExactlyOnceWith("project", "scene");
    expect(harness.exportPackage.mock.calls[0]![0].scene).toEqual(publication.snapshot);
    expect(harness.save.mock.calls.every(([ownerId]) => ownerId === "owner")).toBe(true);
  });

  it("cancels export on owner change and ignores late old-owner responses", async () => {
    const gate = deferred<unknown>(); harness.exportPackage.mockReturnValue(gate.promise);
    const old = render(), running = old.begin(publication, options); await flush();
    const signal = harness.exportPackage.mock.calls[0]![0].signal as AbortSignal;
    render("other"); expect(signal.aborted).toBe(true);
    await running; gate.resolve({}); await flush();
    expect(render("other").records).toEqual([]); expect(render("other").error).toBeUndefined();
    await expect(old.begin(publication, options)).rejects.toThrow("登录");
    expect(harness.save.mock.calls.every(([ownerId]) => ownerId === "owner")).toBe(true);
  });

  it("ignores late restore after owner change and does not start the old task", async () => {
    const gate = deferred<unknown[]>(); harness.restore.mockReturnValueOnce(gate.promise);
    const old = render(), running = old.begin(publication, options);
    const rejected = expect(running).rejects.toThrow("取消"); await flush(); render("other");
    gate.resolve([createSceneArtifactRecord(publication, options)]); await rejected;
    expect(render("other").records).toEqual([]); expect(harness.exportPackage).not.toHaveBeenCalled();
  });

  it("cancels a task while restore is pending before any history read", async () => {
    const gate = deferred<unknown[]>(); harness.restore.mockReturnValue(gate.promise);
    const app = render(), running = app.begin(publication, options);
    app.cancel(createSceneArtifactRecord(publication, options).key); gate.resolve([]);
    expect((await running).record.status).toBe("cancelled"); expect(harness.history).not.toHaveBeenCalled();
  });

  it("cancels on unmount and rejects absent-owner operations", async () => {
    const gate = deferred<unknown>(); harness.exportPackage.mockReturnValue(gate.promise);
    const app = render(), running = app.begin(publication, options); await flush(); unmount();
    expect(harness.exportPackage.mock.calls[0]![0].signal.aborted).toBe(true); await running;
    const anonymous = render(""); await expect(anonymous.begin(publication, options)).rejects.toThrow("登录");
  });
});
