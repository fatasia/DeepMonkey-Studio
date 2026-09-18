import { afterEach, describe, expect, it, vi } from "vitest";
import { withSceneArtifactLock } from "./scenePublicationArtifactLock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// All simulated windows share this manager, as same-origin Web Locks clients do.
function mockLockManager() {
  const held = new Set<string>();
  const request = vi.fn(async <T>(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<T>) => {
    expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: "exclusive" } as Lock); }
    finally { held.delete(name); }
  });
  vi.stubGlobal("navigator", { locks: { request } });
  return { request, held };
}

afterEach(() => vi.unstubAllGlobals());

describe("withSceneArtifactLock", () => {
  it("rejects a competing window immediately and releases only after success settles", async () => {
    const manager = mockLockManager();
    const gate = deferred<string>();
    const first = withSceneArtifactLock("owner", "project", "scene", () => gate.promise);
    const competing = vi.fn(async () => "unexpected");
    await expect(withSceneArtifactLock("owner", "project", "scene", competing))
      .rejects.toThrow("该场景已有打包任务正在执行，请在完成后重新读取或重试。");
    expect(competing).not.toHaveBeenCalled();
    expect(manager.held.size).toBe(1);
    gate.resolve("downloaded");
    await expect(first).resolves.toBe("downloaded");
    expect(manager.held.size).toBe(0);
    await expect(withSceneArtifactLock("owner", "project", "scene", async () => "retry")).resolves.toBe("retry");
  });

  it("releases after operation failure and preserves the failure", async () => {
    const manager = mockLockManager();
    const gate = deferred<never>();
    const failure = new Error("export failed");
    const result = withSceneArtifactLock("owner", "project", "scene", () => gate.promise);
    const rejected = expect(result).rejects.toBe(failure);
    expect(manager.held.size).toBe(1);
    gate.reject(failure);
    await rejected;
    expect(manager.held.size).toBe(0);
    await expect(withSceneArtifactLock("owner", "project", "scene", async () => 42)).resolves.toBe(42);
  });

  it.each([
    ["other", "project", "scene"], ["owner", "other", "scene"], ["owner", "project", "other"],
  ])("allows independent owner/project/scene %s/%s/%s", async (owner, project, scene) => {
    mockLockManager();
    const gate = deferred<void>();
    const first = withSceneArtifactLock("owner", "project", "scene", () => gate.promise);
    await expect(withSceneArtifactLock(owner, project, scene, async () => "independent")).resolves.toBe("independent");
    gate.resolve();
    await first;
  });

  it("uses unambiguous JSON tuple identity and preserves significant whitespace", async () => {
    const manager = mockLockManager();
    const identities = [["a:b", "c", "d"], ["a", "b:c", "d"], ["用户", "项目", "场景"], [" a", "b:c", "d"]];
    const gate = deferred<void>();
    const calls = identities.map(([owner, project, scene]) => withSceneArtifactLock(owner!, project!, scene!, () => gate.promise));
    expect(manager.held.size).toBe(identities.length);
    expect(manager.request.mock.calls.map(([name]) => name)).toEqual(identities.map((ids) => `scene-artifact-lock:${JSON.stringify(ids)}`));
    gate.resolve();
    await Promise.all(calls);
  });

  it.each(["", " \t\n", undefined, null, 1, {}, []])("rejects invalid identity %j without requesting a lock", async (invalid) => {
    const manager = mockLockManager();
    const operation = vi.fn(async () => 1);
    for (let position = 0; position < 3; position++) {
      const ids = ["owner", "project", "scene"];
      ids[position] = invalid as string;
      await expect(withSceneArtifactLock(ids[0]!, ids[1]!, ids[2]!, operation)).rejects.toThrow(/身份/);
    }
    expect(manager.request).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { locks: {} }, { locks: { request: true } }])("rejects unavailable Web Locks with actionable guidance", async (value) => {
    vi.stubGlobal("navigator", value);
    const operation = vi.fn(async () => 1);
    await expect(withSceneArtifactLock("owner", "project", "scene", operation)).rejects.toThrow(/HTTPS 或 localhost/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("propagates lock manager rejection without executing the operation", async () => {
    const failure = new Error("Access denied");
    vi.stubGlobal("navigator", { locks: { request: vi.fn().mockRejectedValue(failure) } });
    const operation = vi.fn(async () => 1);
    await expect(withSceneArtifactLock("owner", "project", "scene", operation)).rejects.toBe(failure);
    expect(operation).not.toHaveBeenCalled();
  });
});
