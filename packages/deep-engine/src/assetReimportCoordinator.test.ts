import { describe, expect, it } from "vitest";
import { ASSET_FACETS, type AssetCompatibilityProfile, type AssetFacetEvidence } from "./assetCompatibility.js";
import type { DeepAssetPackage, DeepAssetResource, DeepAssetStoreSnapshot } from "./assetPackage.js";
import type { DeepAssetUserOverride } from "./assetReimport.js";
import { DeepAssetReimportCoordinator } from "./assetReimportCoordinator.js";
import type { DeepAssetPreparedResource, DeepAssetReimportAdapter, DeepAssetReimportApplyRequest,
  DeepAssetReimportCommitRequest } from "./assetReimportCoordinatorTypes.js";

const H = { material: "a".repeat(64), scene: "b".repeat(64), texture: "c".repeat(64), metaA: "d".repeat(64),
  metaB: "e".repeat(64), source: "f".repeat(64), nextSource: "1".repeat(64), recipe: "2".repeat(64),
  override: "3".repeat(64), changed: "4".repeat(64) };
function compatibility(): AssetCompatibilityProfile {
  const evidence = (): AssetFacetEvidence => ({ status: "verified", evidenceIds: ["fixture:v1"], reason: null });
  return { schemaVersion: 1, id: "gltf-native-v1", sourceKind: "model-file", format: "glb",
    importer: "direct-parser", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0",
    fixtureSetHash: "5".repeat(64), deterministic: true,
    facets: Object.fromEntries(ASSET_FACETS.map(facet => [facet, evidence()])) as AssetCompatibilityProfile["facets"] };
}
const resource = (id: string, kind: DeepAssetResource["kind"], blobHash: string,
  dependencies: readonly string[] = [], logicalPath = `${id}.bin`): DeepAssetResource =>
  ({ id, kind, blobHash, dependencies, logicalPath });
function packageValue(next = false): DeepAssetPackage {
  const resources = next ? [
    resource("material/main", "material", H.material, ["texture/color"]),
    resource("metadata/a", "metadata", H.metaA), resource("metadata/b", "metadata", H.metaB),
    resource("scene/main", "scene", H.scene, ["material/main", "metadata/a", "metadata/b"]),
    resource("texture/color", "texture", H.texture, [], "textures/renamed.bin"),
  ] : [resource("material/main", "material", H.material, ["texture/color"]),
    resource("scene/main", "scene", H.scene, ["material/main"]),
    resource("texture/color", "texture", H.texture, [], "textures/color.bin")];
  const hashes = next ? [H.material, H.scene, H.texture, H.metaA, H.metaB] : [H.material, H.scene, H.texture];
  return { schemaVersion: 1, blobs: hashes.sort().map(hash => ({ hash, byteLength: 8, mediaType: "application/octet-stream" })),
    manifest: { schemaVersion: 1, packageId: "factory.cell", source: { kind: "model-file",
      logicalName: "imports/cell.glb", contentHash: next ? H.nextSource : H.source, byteLength: 24 },
    importer: { kind: "direct-parser", id: "deep.gltf", version: "1.0.0", recipeHash: H.recipe, deterministic: true },
    compatibility: compatibility(), resources, entryScene: "scene/main" } };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve }; };
interface Handle { readonly id: string }
interface Transaction { draft: Map<string, string>; operations: string[]; rolledBack: boolean }

class Adapter implements DeepAssetReimportAdapter<Handle, Transaction> {
  revision = 7; active = { packageId: "factory.cell", sourceHash: H.source, recipeHash: H.recipe };
  visible = new Map(packageValue().manifest.resources.map(value => [value.id, value.logicalPath]));
  prepares: string[] = []; transactions: Transaction[] = []; releases: string[] = []; commits = 0;
  peak = 0; activePrepares = 0; failResource?: string; forceConflict = false;
  prepareBlock?: { generation: number; entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  applyBlock?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  rollbackOrders: readonly string[][] = []; appliedOverrides: DeepAssetUserOverride[] = [];
  async readSnapshot(): Promise<DeepAssetStoreSnapshot> {
    return { revision: this.revision, active: this.active, blobHashes: packageValue().blobs.map(value => value.hash) };
  }
  async prepare(request: { generation: number; resource: DeepAssetResource }): Promise<DeepAssetPreparedResource<Handle>> {
    this.prepares.push(request.resource.id); this.activePrepares++; this.peak = Math.max(this.peak, this.activePrepares);
    if (this.prepareBlock?.generation === request.generation) { this.prepareBlock.entered.resolve(); await this.prepareBlock.gate.promise; }
    else await Promise.resolve();
    this.activePrepares--;
    return { resourceId: request.resource.id, disposition: request.resource.id === "material/main" ? "reused" : "prepared",
      handle: { id: request.resource.id } };
  }
  async beginApply(): Promise<Transaction> {
    const transaction = { draft: new Map(this.visible), operations: [], rolledBack: false };
    this.transactions.push(transaction); return transaction;
  }
  async apply(transaction: Transaction, request: DeepAssetReimportApplyRequest<Handle>): Promise<void> {
    if (this.applyBlock && transaction.operations.length === 0) { this.applyBlock.entered.resolve(); await this.applyBlock.gate.promise; }
    if (request.resource.id === this.failResource) throw new Error(`apply failed: ${request.resource.id}`);
    transaction.operations.push(`${request.kind}:${request.resource.id}`);
    if (request.kind === "remove") transaction.draft.delete(request.resource.id);
    else transaction.draft.set(request.resource.id, request.resource.logicalPath);
    this.appliedOverrides.push(...request.overrides);
  }
  commit(request: DeepAssetReimportCommitRequest<Transaction>) {
    if (this.forceConflict || request.packageCommit.expectedRevision !== this.revision) return "revision-conflict" as const;
    if (!request.isCurrent()) return "superseded" as const;
    this.visible = request.transaction.draft; this.revision = request.packageCommit.nextRevision;
    this.active = request.packageCommit.nextActive; this.commits++; return "committed" as const;
  }
  rollback(transaction: Transaction, order: readonly string[]): void {
    transaction.rolledBack = true; this.rollbackOrders.push([...order]);
  }
  release(resource: DeepAssetPreparedResource<Handle>, disposition: "committed" | "rolled-back"): void {
    this.releases.push(`${disposition}:${resource.resourceId}`);
  }
}
const override = (): DeepAssetUserOverride => ({ id: "override/color", resourceId: "texture/color",
  baseBlobHash: H.texture, overrideHash: H.override, revision: 2 });

describe("Deep Asset reimport transaction coordinator", () => {
  it("keeps apply invisible, preserves rename overrides, reuses resources, and commits atomically", async () => {
    const adapter = new Adapter(), block = { entered: deferred(), gate: deferred() }; adapter.applyBlock = block;
    const coordinator = new DeepAssetReimportCoordinator(adapter);
    const pending = coordinator.publish(packageValue(), packageValue(true), { concurrency: 2, overrides: [override()] });
    await block.entered.promise;
    expect(adapter.visible.get("texture/color")).toBe("textures/color.bin"); expect(adapter.commits).toBe(0);
    block.gate.resolve(); const result = await pending;
    expect(result).toMatchObject({ status: "committed", preparedResources: 4, reusedResources: 1,
      appliedOperations: 5, releasedResources: 5, rollbackAttempted: false });
    expect(adapter.visible.get("texture/color")).toBe("textures/renamed.bin"); expect(adapter.commits).toBe(1);
    expect(adapter.appliedOverrides).toContainEqual(override()); expect(adapter.peak).toBe(2);
    expect(adapter.transactions[0]!.operations).toEqual(["publish:texture/color", "publish:material/main",
      "publish:metadata/a", "publish:metadata/b", "publish:scene/main"]);
    await expect(coordinator.publish(packageValue(), packageValue(true), { concurrency: 17 })).rejects.toThrow("1 through 16");
  });

  it("rolls back in the planned reverse dependency order after a mid-apply failure", async () => {
    const adapter = new Adapter(); adapter.failResource = "material/main"; const before = [...adapter.visible];
    const result = await new DeepAssetReimportCoordinator(adapter).publish(packageValue(), packageValue(true));
    expect(result).toMatchObject({ status: "failed", rollbackAttempted: true,
      failure: "apply failed: material/main", appliedOperations: 1 });
    expect(adapter.visible).toEqual(new Map(before)); expect(adapter.commits).toBe(0);
    expect(adapter.rollbackOrders[0]).toEqual(["scene/main", "metadata/b", "metadata/a", "material/main", "texture/color"]);
    expect(adapter.releases.every(value => value.startsWith("rolled-back:"))).toBe(true);
  });

  it("aborts late preparation and lets a newer generation win", async () => {
    const adapter = new Adapter(), block = { generation: 1, entered: deferred(), gate: deferred() };
    adapter.prepareBlock = block; const coordinator = new DeepAssetReimportCoordinator(adapter);
    const stale = coordinator.publish(packageValue(), packageValue(true)); await block.entered.promise;
    const latest = await coordinator.publish(packageValue(), packageValue(true)); block.gate.resolve();
    expect(latest.status).toBe("committed"); expect(await stale).toMatchObject({ status: "superseded" });
    expect(adapter.commits).toBe(1); expect(adapter.releases.some(value => value.startsWith("rolled-back:"))).toBe(true);

    const abortAdapter = new Adapter(), abortBlock = { generation: 1, entered: deferred(), gate: deferred() };
    abortAdapter.prepareBlock = abortBlock; const controller = new AbortController();
    const aborted = new DeepAssetReimportCoordinator(abortAdapter).publish(packageValue(), packageValue(true), { signal: controller.signal });
    await abortBlock.entered.promise; controller.abort(new Error("stop")); abortBlock.gate.resolve();
    expect(await aborted).toMatchObject({ status: "aborted" }); expect(abortAdapter.commits).toBe(0);
  });

  it("does no writes for override conflict and rolls back a CAS revision conflict", async () => {
    const conflicting = packageValue(true), texture = conflicting.manifest.resources.find(value => value.id === "texture/color")!;
    (conflicting.manifest as { resources: DeepAssetResource[] }).resources = conflicting.manifest.resources.map(value =>
      value.id === texture.id ? { ...value, blobHash: H.changed } : value);
    (conflicting as { blobs: DeepAssetPackage["blobs"] }).blobs = [...conflicting.blobs,
      { hash: H.changed, byteLength: 8, mediaType: "application/octet-stream" }].sort((a, b) => a.hash.localeCompare(b.hash));
    const blockedAdapter = new Adapter(), blocked = await new DeepAssetReimportCoordinator(blockedAdapter)
      .publish(packageValue(), conflicting, { overrides: [override()] });
    expect(blocked).toMatchObject({ status: "conflicted", preparedResources: 0, appliedOperations: 0 });
    expect(blockedAdapter.prepares).toEqual([]); expect(blockedAdapter.transactions).toEqual([]); expect(blockedAdapter.commits).toBe(0);
    const casAdapter = new Adapter(); casAdapter.forceConflict = true;
    const cas = await new DeepAssetReimportCoordinator(casAdapter).publish(packageValue(), packageValue(true));
    expect(cas).toMatchObject({ status: "revision-conflict", rollbackAttempted: true });
    expect(casAdapter.visible.get("texture/color")).toBe("textures/color.bin"); expect(casAdapter.commits).toBe(0);
  });

  it("does zero prepare/apply work for an identical active package", async () => {
    const adapter = new Adapter(), result = await new DeepAssetReimportCoordinator(adapter)
      .publish(packageValue(), packageValue());
    expect(result).toMatchObject({ status: "unchanged", preparedResources: 0, reusedResources: 0,
      appliedOperations: 0, releasedResources: 0 });
    expect(adapter.prepares).toEqual([]); expect(adapter.transactions).toEqual([]); expect(adapter.commits).toBe(0);
  });
});
