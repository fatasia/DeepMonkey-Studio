import { describe, expect, it } from "vitest";
import { buildDeepRuntimePackage } from "./builder.js";
import { RuntimePackagePrewarmExecutor } from "./prewarmExecutor.js";
import type { RuntimePackagePrewarmAdapter } from "./prewarmTypes.js";

function runtime(version: string, offset = 0) {
  return buildDeepRuntimePackage({ packageId: "prewarm.lifecycle", packageVersion: version,
    renderPacket: { id: "scene", revision: 1, value: {
      geometries: [{ id: "triangle", revision: 1,
        vertices: new Float32Array([offset, 0, 0, 0, 0, 1, offset + 1, 0, 0, 0, 0, 1, offset, 1, 0, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]) }],
      materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
      instances: [{ id: "mesh", geometry: "triangle", material: "material",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    } } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const entered = deferred(), resume = deferred();
  const commits: string[] = [], releases: string[] = [];
  let candidateSignal: AbortSignal | undefined;
  const adapter: RuntimePackagePrewarmAdapter<string, string> = {
    async load(item, value, signal) {
      if (value.packageVersion === "1.0.1") {
        candidateSignal = signal; entered.resolve(); await resume.promise;
      }
      return item.cacheKey;
    },
    async prepare(_item, loaded) { return loaded; },
    commit(plan) { commits.push(plan.packageHash); },
    release(_item, loaded) { releases.push(loaded); },
  };
  return { executor: new RuntimePackagePrewarmExecutor(adapter), adapter,
    entered, resume, commits, releases, signal: () => candidateSignal };
}

describe("runtime prewarm publication intent", () => {
  it("cancels B when the newest request returns to the active A", async () => {
    const f = fixture(), a = runtime("1.0.0"), b = runtime("1.0.1", 2);
    await f.executor.publish(a);
    const pending = f.executor.publish(b);
    await f.entered.promise;
    const returned = await f.executor.publish(a);
    expect(returned.status).toBe("unchanged");
    expect(f.signal()?.aborted).toBe(true);
    f.resume.resolve();
    expect(await pending).toMatchObject({ status: "superseded", committedItems: 0, releasedItems: 1 });
    expect(f.executor.activePlan?.packageHash).toBe(a.packageHash.value);
    expect(f.commits).toEqual([a.packageHash.value]);
    expect(f.releases).toHaveLength(1);
    f.executor.dispose();
    expect(new Set(f.releases).size).toBe(f.releases.length);
  });

  it("reports an already cancelled request as aborted even if A is active", async () => {
    const f = fixture(), a = runtime("1.0.0"), controller = new AbortController();
    await f.executor.publish(a); controller.abort();
    expect(await f.executor.publish(a, { signal: controller.signal })).toMatchObject({ status: "aborted" });
    expect(f.commits).toHaveLength(1);
    f.executor.dispose();
  });

  it("does not cancel B for an already aborted return to A", async () => {
    const f = fixture(), a = runtime("1.0.0"), b = runtime("1.0.1", 2);
    await f.executor.publish(a);
    const pending = f.executor.publish(b); await f.entered.promise;
    const controller = new AbortController(); controller.abort();
    expect((await f.executor.publish(a, { signal: controller.signal })).status).toBe("aborted");
    expect(f.signal()?.aborted).toBe(false);
    f.resume.resolve(); expect((await pending).status).toBe("committed");
    expect(f.executor.activePlan?.packageHash).toBe(b.packageHash.value);
    f.executor.dispose();
  });

  it("keeps B pending when a new request fails validation", async () => {
    const f = fixture(), a = runtime("1.0.0"), b = runtime("1.0.1", 2);
    await f.executor.publish(a);
    const pending = f.executor.publish(b); await f.entered.promise;
    await expect(f.executor.publish({ ...a, packageHash: b.packageHash })).rejects.toThrow(/hash mismatch/);
    expect(f.signal()?.aborted).toBe(false);
    f.resume.resolve(); expect((await pending).status).toBe("committed");
    f.executor.dispose();
  });

  it("never commits a partially prepared package when an adapter throws undefined", async () => {
    const f = fixture();
    f.adapter.prepare = async () => { throw undefined; };
    const result = await f.executor.publish(runtime("1.0.0"));
    expect(result).toMatchObject({ status: "failed", committedItems: 0 });
    expect(f.commits).toEqual([]);
    expect(f.executor.activePlan).toBeUndefined();
    f.executor.dispose();
  });

  it("releases a late load after disposal without replacing the active version", async () => {
    const f = fixture();
    await f.executor.publish(runtime("1.0.0"));
    const pending = f.executor.publish(runtime("1.0.1", 2)); await f.entered.promise;
    f.executor.dispose(); f.executor.dispose();
    expect(f.signal()?.aborted).toBe(true);
    f.resume.resolve(); expect((await pending).status).toBe("superseded");
    expect(f.executor.activePlan).toBeUndefined();
    expect(f.commits).toHaveLength(1);
    expect(f.releases).toHaveLength(3);
    expect(new Set(f.releases).size).toBe(3);
    await expect(f.executor.publish(runtime("1.0.2", 3))).rejects.toThrow(/disposed/);
  });

  it("keeps the newest request when cancellation callbacks reenter publish", async () => {
    const f = fixture();
    await f.executor.publish(runtime("1.0.0"));
    const pending = f.executor.publish(runtime("1.0.1", 2)); await f.entered.promise;
    const newest = runtime("1.0.3", 4);
    let reentered: ReturnType<typeof f.executor.publish> | undefined;
    f.signal()!.addEventListener("abort", () => { reentered = f.executor.publish(newest); }, { once: true });
    const superseded = f.executor.publish(runtime("1.0.2", 3));
    expect((await superseded).status).toBe("superseded");
    expect((await reentered)?.status).toBe("committed");
    f.resume.resolve(); expect((await pending).status).toBe("superseded");
    expect(f.executor.activePlan?.packageHash).toBe(newest.packageHash.value);
    expect(f.commits).toHaveLength(2);
    f.executor.dispose();
  });

  it("preserves the active publication when release fails during a cancelled update", async () => {
    const f = fixture(), a = runtime("1.0.0");
    await f.executor.publish(a);
    const pending = f.executor.publish(runtime("1.0.1", 2)); await f.entered.promise;
    await f.executor.publish(a);
    f.adapter.release = () => { throw new Error("release failed"); };
    f.resume.resolve();
    expect(await pending).toMatchObject({ status: "superseded", releaseFailures: ["release failed"] });
    expect(f.executor.activePlan?.packageHash).toBe(a.packageHash.value);
    f.executor.dispose();
  });
});
