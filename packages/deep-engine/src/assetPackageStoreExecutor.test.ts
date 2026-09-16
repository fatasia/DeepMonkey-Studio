import { describe, expect, it } from "vitest";
import { ASSET_FACETS, type AssetCompatibilityProfile, type AssetFacetEvidence } from "./assetCompatibility.js";
import type { DeepAssetPackage, DeepAssetStoreSnapshot } from "./assetPackage.js";
import { DeepAssetPackageStoreExecutor } from "./assetPackageStoreExecutor.js";
import type {
  DeepAssetPackageStoreAdapter, DeepAssetStageDisposition, DeepAssetStagedBlob,
  DeepAssetStoreCommitRequest,
} from "./assetPackageStoreTypes.js";

const HASH = { mesh: "a".repeat(64), scene: "b".repeat(64), other: "c".repeat(64) } as const;

function compatibility(): AssetCompatibilityProfile {
  const verified = (): AssetFacetEvidence => ({ status: "verified", evidenceIds: ["fixture:v1"], reason: null });
  return {
    schemaVersion: 1, id: "gltf-native-v1", sourceKind: "model-file", format: "glb",
    importer: "direct-parser", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0",
    fixtureSetHash: "d".repeat(64), deterministic: true,
    facets: Object.fromEntries(ASSET_FACETS.map(facet => [facet, verified()])) as AssetCompatibilityProfile["facets"],
  };
}

function candidate(packageId = "factory.robot-cell", sourceHash = "e".repeat(64), sceneHash = HASH.scene): DeepAssetPackage {
  return {
    schemaVersion: 1,
    blobs: [
      { hash: HASH.mesh, byteLength: 36, mediaType: "application/vnd.deep.mesh" },
      { hash: sceneHash, byteLength: 72, mediaType: "application/vnd.deep.scene" },
    ].sort((a, b) => a.hash.localeCompare(b.hash)),
    manifest: {
      schemaVersion: 1, packageId,
      source: { kind: "model-file", logicalName: "imports/robot-cell.glb", contentHash: sourceHash, byteLength: 108 },
      importer: { kind: "direct-parser", id: "deep.gltf", version: "1.0.0", recipeHash: "f".repeat(64), deterministic: true },
      compatibility: compatibility(),
      resources: [
        { id: "mesh/cube", kind: "mesh", logicalPath: "meshes/cube.bin", blobHash: HASH.mesh, dependencies: [] },
        { id: "scene/main", kind: "scene", logicalPath: "scenes/main.json", blobHash: sceneHash, dependencies: ["mesh/cube"] },
      ],
      entryScene: "scene/main",
    },
  };
}

type Handle = Readonly<{ hash: string }>;
function staged(descriptor: DeepAssetPackage["blobs"][number]): DeepAssetStagedBlob<Handle> {
  return {
    descriptor, handle: { hash: descriptor.hash },
    verification: { authority: "adapter-sha256", algorithm: "sha256", verified: true,
      contentHash: descriptor.hash, byteLength: descriptor.byteLength },
  };
}

function fixture(initial: Partial<DeepAssetStoreSnapshot> = {},
  overrides: Partial<DeepAssetPackageStoreAdapter<Handle>> = {}) {
  const state: { revision: number; active: DeepAssetStoreSnapshot["active"]; hashes: Set<string> } = {
    revision: initial.revision ?? 7, active: initial.active ?? null,
    hashes: new Set(initial.blobHashes ?? [HASH.mesh]),
  };
  const stages: string[] = [], commits: Array<DeepAssetStoreCommitRequest<Handle>> = [];
  const releases: Array<{ hash: string; disposition: DeepAssetStageDisposition }> = [];
  const adapter: DeepAssetPackageStoreAdapter<Handle> = {
    async readSnapshot() {
      return { revision: state.revision, active: state.active, blobHashes: [...state.hashes].sort() };
    },
    async stageBlob(descriptor) { stages.push(descriptor.hash); return staged(descriptor); },
    commit(request) {
      commits.push(request);
      if (!request.isCurrent()) return "superseded";
      if (request.commit.expectedRevision !== state.revision) return "revision-conflict";
      request.stagedBlobs.forEach(item => state.hashes.add(item.descriptor.hash));
      state.revision = request.commit.nextRevision; state.active = request.commit.nextActive;
      return "committed";
    },
    releaseBlob(value, disposition) { releases.push({ hash: value.descriptor.hash, disposition }); },
    ...overrides,
  };
  return { adapter, state, stages, commits, releases };
}

describe("Deep Asset Package transactional store executor", () => {
  it("stages only missing hashes, commits in plan order, and does zero work for the active package", async () => {
    const f = fixture(), executor = new DeepAssetPackageStoreExecutor(f.adapter);
    const first = await executor.publish(candidate(), { concurrency: 3 });
    expect(first).toMatchObject({ status: "committed", stagedBlobs: 1, reusedBlobs: 1,
      committedBlobs: 1, releasedBlobs: 1 });
    expect(f.stages).toEqual([HASH.scene]);
    expect(f.commits[0]!.stagedBlobs.map(item => item.descriptor.hash)).toEqual([HASH.scene]);
    expect(f.releases).toEqual([{ hash: HASH.scene, disposition: "committed" }]);
    expect(f.state).toMatchObject({ revision: 8, active: first.commit?.nextActive });
    const unchanged = await executor.publish(candidate());
    expect(unchanged).toMatchObject({ status: "unchanged", stagedBlobs: 0, reusedBlobs: 2, committedBlobs: 0 });
    expect(f.stages).toHaveLength(1); expect(f.commits).toHaveLength(1);
    expect(executor.lastCommitted).toBe(first.commit);
  });

  it("performs zero writes when every hash exists but atomically publishes a new active package", async () => {
    const f = fixture({ blobHashes: [HASH.mesh, HASH.scene] });
    const result = await new DeepAssetPackageStoreExecutor(f.adapter).publish(candidate());
    expect(result).toMatchObject({ status: "committed", stagedBlobs: 0, reusedBlobs: 2, committedBlobs: 0 });
    expect(f.stages).toEqual([]); expect(f.commits).toHaveLength(1);
  });

  it("rejects mismatched adapter SHA-256 evidence and rolls back every returned handle", async () => {
    const f = fixture({}, { async stageBlob(descriptor) {
      const value = staged(descriptor);
      return { ...value, verification: { ...value.verification, contentHash: HASH.other } };
    } });
    const executor = new DeepAssetPackageStoreExecutor(f.adapter);
    expect(await executor.publish(candidate())).toMatchObject({ status: "failed", committedBlobs: 0,
      releasedBlobs: 1, failure: expect.stringContaining("lacks matching adapter SHA-256") });
    expect(f.state).toMatchObject({ revision: 7, active: null });
    expect(f.releases).toEqual([{ hash: HASH.scene, disposition: "rolled-back" }]);
    expect(executor.lastCommitted).toBeUndefined();
  });

  it("snapshots and freezes validated package data before the first adapter await", async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture({}, { async readSnapshot() {
      entered(); await wait; return { revision: 7, active: null, blobHashes: [HASH.mesh] };
    } });
    const input = candidate(), executor = new DeepAssetPackageStoreExecutor(f.adapter);
    const pending = executor.publish(input); await started;
    (input.manifest as { packageId: string }).packageId = "factory.mutated";
    (input.blobs[1] as { byteLength: number }).byteLength = 999;
    finish();
    expect(await pending).toMatchObject({ status: "committed" });
    expect(f.commits[0]!.packageValue.manifest.packageId).toBe("factory.robot-cell");
    expect(f.commits[0]!.stagedBlobs[0]!.descriptor.byteLength).toBe(72);
    expect(Object.isFrozen(f.commits[0]!.packageValue.manifest.resources)).toBe(true);
  });

  it("bounds parallel staging from one through sixteen", async () => {
    let active = 0, peak = 0;
    const f = fixture({ blobHashes: [] }, { async stageBlob(descriptor) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 3)); active--;
      return staged(descriptor);
    } });
    const executor = new DeepAssetPackageStoreExecutor(f.adapter);
    expect((await executor.publish(candidate(), { concurrency: 2 })).status).toBe("committed");
    expect(peak).toBe(2);
    await expect(executor.publish(candidate("factory.next"), { concurrency: 0 })).rejects.toThrow(/1 through 16/);
    await expect(executor.publish(candidate("factory.next"), { concurrency: 17 })).rejects.toThrow(/1 through 16/);
  });

  it("cancels late adapter work without publishing and releases its stage", async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture({}, { async stageBlob(descriptor) { entered(); await wait; return staged(descriptor); } });
    const executor = new DeepAssetPackageStoreExecutor(f.adapter), controller = new AbortController();
    const pending = executor.publish(candidate(), { concurrency: 1, signal: controller.signal });
    await started; controller.abort(new Error("cancelled")); finish();
    expect(await pending).toMatchObject({ status: "aborted", committedBlobs: 0, releasedBlobs: 1 });
    expect(f.commits).toEqual([]); expect(f.releases[0]?.disposition).toBe("rolled-back");
  });

  it("prevents superseded late work from overwriting the latest package", async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture({}, { async stageBlob(descriptor, packageValue) {
      if (packageValue.manifest.packageId === "factory.old") { entered(); await wait; }
      return staged(descriptor);
    } });
    const executor = new DeepAssetPackageStoreExecutor(f.adapter);
    const old = executor.publish(candidate("factory.old")); await started;
    const latest = await executor.publish(candidate("factory.latest", "1".repeat(64), HASH.other));
    finish();
    expect(latest.status).toBe("committed");
    expect(await old).toMatchObject({ status: "superseded", committedBlobs: 0, releasedBlobs: 1 });
    expect(f.state.active?.packageId).toBe("factory.latest");
    expect(f.commits).toHaveLength(1);
  });

  it("keeps the last good publication on CAS conflict, commit failure, or rejected input", async () => {
    let conflict = false, fail = false;
    const f = fixture({}, { commit(request) {
      if (fail) throw new Error("commit failed");
      if (conflict) return "revision-conflict";
      if (!request.isCurrent()) return "superseded";
      f.state.revision = request.commit.nextRevision; f.state.active = request.commit.nextActive;
      request.stagedBlobs.forEach(item => f.state.hashes.add(item.descriptor.hash));
      return "committed";
    } });
    const executor = new DeepAssetPackageStoreExecutor(f.adapter);
    const stable = await executor.publish(candidate()); expect(stable.status).toBe("committed");
    conflict = true;
    expect(await executor.publish(candidate("factory.conflict", "1".repeat(64), HASH.other)))
      .toMatchObject({ status: "revision-conflict", releasedBlobs: 1 });
    expect(executor.lastCommitted).toBe(stable.commit);
    conflict = false; fail = true;
    expect(await executor.publish(candidate("factory.failure", "2".repeat(64), HASH.other)))
      .toMatchObject({ status: "failed", failure: "commit failed", releasedBlobs: 1 });
    const invalid = candidate() as unknown as { manifest: { entryScene: string } };
    invalid.manifest.entryScene = "missing";
    expect(await executor.publish(invalid)).toMatchObject({ status: "rejected", commit: null, stagedBlobs: 0 });
    expect(executor.lastCommitted).toBe(stable.commit);
  });
});
