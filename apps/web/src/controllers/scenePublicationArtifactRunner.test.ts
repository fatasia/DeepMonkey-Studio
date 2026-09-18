import { describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import type { SceneClientPackageResult, PreparedSceneClientPackage } from "../delivery/sceneClientPackage";
import { createSceneArtifactRecord, type SceneArtifactRecord } from "./scenePublicationArtifactRecord";
import { createSceneArtifactRunner, type SceneArtifactRunnerDependencies } from "./scenePublicationArtifactRunner";

function fixture() {
  const at = "2026-09-15T12:00:00.000Z";
  const publication: PublishedSceneRecord = { sceneId: "scene", projectId: "project", version: 1, name: "旧发布", publishedAt: at,
    snapshot: { schemaVersion: 1, id: "scene", projectId: "project", name: "旧发布", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at } };
  const record = createSceneArtifactRecord(publication, { target: "three-webview", renderer: "webgl", toolbarVisible: false });
  const result: SceneClientPackageResult = { fileName: "scene.zip", target: "three-webview", assetCount: 0, applicationCount: 0, connectionCount: 0 };
  const writes: SceneArtifactRecord[] = [];
  const deps = {
    loadHistory: vi.fn<SceneArtifactRunnerDependencies["loadHistory"]>().mockResolvedValue([publication]),
    exportPackage: vi.fn<SceneArtifactRunnerDependencies["exportPackage"]>().mockResolvedValue(result),
    saveRecord: vi.fn<SceneArtifactRunnerDependencies["saveRecord"]>().mockImplementation(async (value) => { writes.push(structuredClone(value)); }),
    onChange: vi.fn<NonNullable<SceneArtifactRunnerDependencies["onChange"]>>(),
  };
  return { publication, record, result, writes, deps, runner: createSceneArtifactRunner(deps) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("scene artifact runner", () => {
  it("passes the first opaque handle by identity without persisting or reusing it on an ordinary retry", async () => {
    const f = fixture(), prepared = Object.freeze({ identity: () => undefined }) as unknown as PreparedSceneClientPackage;
    const replacement = Object.freeze({ identity: () => undefined }) as unknown as PreparedSceneClientPackage;
    f.deps.exportPackage.mockRejectedValueOnce(new Error("temporary failure"));
    const first = f.runner.run(f.record, prepared);
    expect(f.runner.run(f.record, replacement)).toBe(first);
    const failed = await first;
    expect(failed.record.status).toBe("failed");
    expect(f.deps.exportPackage.mock.calls[0]![0].prepared).toBe(prepared);
    expect(f.writes.every(record => !Object.hasOwn(record, "prepared"))).toBe(true);
    expect((await f.runner.run(failed.record)).record.status).toBe("ready");
    expect(f.deps.exportPackage.mock.calls[1]![0]).not.toHaveProperty("prepared");
  });

  it("does not export a prepared handle when cancellation wins during history loading", async () => {
    const f = fixture(), history = deferred<PublishedSceneRecord[]>(); f.deps.loadHistory.mockReturnValueOnce(history.promise);
    const prepared = Object.freeze({ identity: () => undefined }) as unknown as PreparedSceneClientPackage;
    const operation = f.runner.run(f.record, prepared);
    await vi.waitFor(() => expect(f.deps.loadHistory).toHaveBeenCalledOnce());
    f.runner.cancel(f.record.key); expect((await operation).record.status).toBe("cancelled");
    history.resolve([f.publication]); await Promise.resolve(); expect(f.deps.exportPackage).not.toHaveBeenCalled();
  });

  it("persists the attempt before reading history and exports exactly the historical snapshot", async () => {
    const f = fixture();
    const gate = deferred<void>(); f.deps.saveRecord.mockImplementationOnce(async () => gate.promise);
    const running = f.runner.run(f.record);
    await vi.waitFor(() => expect(f.deps.saveRecord).toHaveBeenCalledTimes(1));
    expect(f.deps.loadHistory).not.toHaveBeenCalled();
    gate.resolve(undefined);
    const outcome = await running;
    expect(outcome).toMatchObject({ record: { status: "ready", attemptId: 1 }, result: f.result });
    expect(f.deps.saveRecord.mock.calls.map(([value]) => value.status)).toEqual(["preparing", "building", "ready"]);
    expect(f.deps.exportPackage).toHaveBeenCalledWith({ projectId: "project", scene: f.publication.snapshot,
      publication: f.publication,
      target: "three-webview", renderer: "webgl", toolbarVisible: false, signal: expect.any(AbortSignal) });
  });

  it("shares one Promise and export for duplicate requests", async () => {
    const f = fixture(), gate = deferred<PublishedSceneRecord[]>();
    f.deps.loadHistory.mockReturnValue(gate.promise);
    const first = f.runner.run(f.record), second = f.runner.run(f.record);
    expect(first).toBe(second); gate.resolve([f.publication]);
    await first; expect(f.deps.exportPackage).toHaveBeenCalledTimes(1);
    expect(f.deps.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("waits for preparing persistence then saves cancellation without reading history", async () => {
    const f = fixture(), gate = deferred<void>();
    f.deps.saveRecord.mockImplementationOnce(async () => gate.promise);
    const running = f.runner.run(f.record);
    await vi.waitFor(() => expect(f.deps.saveRecord).toHaveBeenCalledTimes(1));
    f.runner.cancel(f.record.key); gate.resolve(undefined);
    expect((await running).record.status).toBe("cancelled");
    expect(f.deps.loadHistory).not.toHaveBeenCalled();
    expect(f.deps.saveRecord.mock.calls.map(([record]) => record.status)).toEqual(["preparing", "cancelled"]);
  });

  it("retries a failure with the original snapshot after a newer publication exists", async () => {
    const f = fixture(); f.deps.exportPackage.mockRejectedValueOnce(new Error("offline"));
    const failed = await f.runner.run(f.record);
    expect(failed.record).toMatchObject({ status: "failed", error: "offline", attemptId: 1 });
    f.deps.loadHistory.mockResolvedValue([{ ...f.publication, version: 2, snapshot: { ...f.publication.snapshot, name: "新草稿" } }, f.publication]);
    const ready = await f.runner.run(failed.record);
    expect(ready.record).toMatchObject({ status: "ready", attemptId: 2 });
    expect(ready.record.error).toBeUndefined();
    expect(f.deps.exportPackage.mock.calls[1]![0].scene.name).toBe("旧发布");
  });

  it("fails missing history without exporting a substitute", async () => {
    const f = fixture(); f.deps.loadHistory.mockResolvedValue([]);
    expect((await f.runner.run(f.record)).record.status).toBe("failed");
    expect(f.deps.exportPackage).not.toHaveBeenCalled();
  });

  it("cancels pending history promptly and ignores its late result", async () => {
    const f = fixture(), gate = deferred<PublishedSceneRecord[]>();
    f.deps.loadHistory.mockReturnValue(gate.promise);
    const running = f.runner.run(f.record);
    await vi.waitFor(() => expect(f.deps.loadHistory).toHaveBeenCalled());
    f.runner.cancel(f.record.key);
    expect((await running).record.status).toBe("cancelled");
    gate.resolve([f.publication]); await Promise.resolve();
    expect(f.deps.exportPackage).not.toHaveBeenCalled();
    expect(f.writes.at(-1)?.status).toBe("cancelled");
  });

  it("aborts an export and keeps a late success from overwriting cancellation", async () => {
    const f = fixture(), gate = deferred<SceneClientPackageResult>();
    f.deps.exportPackage.mockReturnValue(gate.promise);
    const running = f.runner.run(f.record);
    await vi.waitFor(() => expect(f.deps.exportPackage).toHaveBeenCalled());
    const signal = f.deps.exportPackage.mock.calls[0]![0].signal!;
    f.runner.cancel(f.record.key); expect(signal.aborted).toBe(true);
    expect(await running).toMatchObject({ record: { status: "cancelled" } });
    gate.resolve(f.result); await Promise.resolve();
    expect(f.writes.map((value) => value.status)).toEqual(["preparing", "building", "cancelled"]);
  });

  it.each(["preparing", "building", "ready", "failed", "cancelled"] as const)("rejects a persistence failure at %s", async (status) => {
    const f = fixture();
    f.deps.saveRecord.mockImplementation(async (record) => { if (record.status === status) throw new Error(`save ${status} failed`); });
    if (status === "failed") f.deps.exportPackage.mockRejectedValue(new Error("build failed"));
    const running = f.runner.run(f.record);
    if (status === "cancelled") f.runner.cancel(f.record.key);
    await expect(running).rejects.toThrow(`save ${status} failed`);
    if (status === "preparing") expect(f.deps.loadHistory).not.toHaveBeenCalled();
    expect(f.deps.onChange.mock.calls.some(([record]) => record.status === status)).toBe(false);
  });

  it("keeps delivered output ready when cancellation arrives during the final metadata write", async () => {
    const f = fixture(), gate = deferred<void>();
    f.deps.saveRecord.mockImplementation(async (record) => { if (record.status === "ready") await gate.promise; });
    const running = f.runner.run(f.record);
    await vi.waitFor(() => expect(f.deps.saveRecord.mock.calls.some(([record]) => record.status === "ready")).toBe(true));
    const signal = f.deps.exportPackage.mock.calls[0]![0].signal!;
    f.runner.cancel(f.record.key); gate.resolve(undefined);
    expect(signal.aborted).toBe(false);
    expect(await running).toMatchObject({ record: { status: "ready" }, result: f.result });
    expect(f.deps.onChange.mock.calls.some(([record]) => record.status === "ready")).toBe(true);
    expect(f.deps.saveRecord.mock.calls.at(-1)![0].status).toBe("ready");
  });

  it("reports final storage failure rather than cancellation after file delivery", async () => {
    const f = fixture(), gate = deferred<void>();
    f.deps.saveRecord.mockImplementation(async (record) => {
      if (record.status === "ready") { await gate.promise; throw new Error("ready storage unavailable"); }
    });
    const running = f.runner.run(f.record);
    await vi.waitFor(() => expect(f.deps.saveRecord.mock.calls.some(([record]) => record.status === "ready")).toBe(true));
    f.runner.cancel(f.record.key); gate.resolve(undefined);
    await expect(running).rejects.toThrow("ready storage unavailable");
    expect(f.deps.exportPackage.mock.calls[0]![0].signal!.aborted).toBe(false);
    expect(f.deps.saveRecord.mock.calls.some(([record]) => record.status === "cancelled")).toBe(false);
  });

  it("isolates caller records and notification state and advances attempts for stale retries", async () => {
    const f = fixture(), original = structuredClone(f.record);
    f.deps.onChange.mockImplementation((record) => { record.sceneId = "changed"; });
    const running = f.runner.run(f.record); f.record.sceneId = "mutated";
    const outcome = await running;
    expect(outcome.record.sceneId).toBe("scene");
    expect((await f.runner.run(original)).record.attemptId).toBe(2);
  });
});
