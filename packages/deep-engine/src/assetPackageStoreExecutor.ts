import type { DeepAssetImportCommit, DeepAssetPackage } from "./assetPackage.js";
import { planDeepAssetImport, validateDeepAssetPackage } from "./assetPackageValidation.js";
import {
  DEEP_ASSET_STORE_MAX_CONCURRENCY,
  type DeepAssetPackageStoreAdapter, type DeepAssetPackageStoreOptions,
  type DeepAssetPackageStoreResult, type DeepAssetStageDisposition,
  type DeepAssetStagedBlob,
} from "./assetPackageStoreTypes.js";

const SUPERSEDED = Object.freeze({ reason: "deep-asset-store-superseded" });
const MAX_RELEASE_FAILURES = 64;
interface Pending { readonly controller: AbortController }

/** Stages content in parallel, then exposes it through one guarded CAS publication. */
export class DeepAssetPackageStoreExecutor<THandle> {
  private generation = 0;
  private pending: Pending | undefined;
  private disposed = false;
  private lastGood: DeepAssetImportCommit | undefined;

  constructor(private readonly adapter: DeepAssetPackageStoreAdapter<THandle>) {}

  get lastCommitted(): DeepAssetImportCommit | undefined { return this.lastGood; }

  async publish(input: unknown, options: DeepAssetPackageStoreOptions = {}): Promise<DeepAssetPackageStoreResult> {
    this.assertUsable();
    const concurrency = boundedConcurrency(options.concurrency);
    const validation = validateDeepAssetPackage(input);
    if (!validation.valid || !validation.value) {
      return result("rejected", this.generation, concurrency, null, { issues: validation.issues });
    }
    const packageValue = immutablePackage(validation.value);
    this.pending?.controller.abort(SUPERSEDED);
    const generation = ++this.generation, controller = new AbortController();
    const pending = { controller }; this.pending = pending;
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    let commit: DeepAssetImportCommit | null = null;
    const staged: Array<DeepAssetStagedBlob<THandle> | undefined> = [];
    let failure: unknown;
    try {
      if (options.signal?.aborted) return result("aborted", generation, concurrency, null);
      let snapshot: unknown;
      try { snapshot = await this.adapter.readSnapshot(controller.signal); }
      catch (error) {
        const interrupted = interruptedStatus(generation, this.generation, options.signal);
        return result(interrupted ?? "failed", generation, concurrency, null,
          interrupted ? {} : { failure: message(error) });
      }
      if (generation !== this.generation || controller.signal.reason === SUPERSEDED) {
        return result("superseded", generation, concurrency, null);
      }
      if (options.signal?.aborted) return result("aborted", generation, concurrency, null);
      const plan = planDeepAssetImport(packageValue, snapshot);
      if (plan.status === "rejected" || !plan.commit) {
        return result("rejected", generation, concurrency, null, { issues: plan.issues });
      }
      commit = immutableCommit(plan.commit);
      if (unchanged(snapshot, commit)) {
        return result("unchanged", generation, concurrency, commit, { reused: commit.reuseBlobHashes.length });
      }
      const descriptors = new Map(packageValue.blobs.map(descriptor => [descriptor.hash, descriptor]));
      const work = commit.addBlobHashes.map(hash => descriptors.get(hash)!);
      staged.length = work.length;
      let cursor = 0, stagedCount = 0;
      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= work.length) return;
          const descriptor = work[index]!;
          try {
            const candidate = await this.adapter.stageBlob(descriptor, packageValue, controller.signal);
            staged[index] = candidate; stagedCount++;
            verifyStage(candidate, descriptor);
            staged[index] = Object.freeze({ descriptor, handle: candidate.handle,
              verification: Object.freeze({ ...candidate.verification }) });
            if (generation !== this.generation && !controller.signal.aborted) controller.abort(SUPERSEDED);
          } catch (error) {
            if (!controller.signal.aborted && failure === undefined) { failure = error; controller.abort(error); }
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, work.length)) }, worker));
      const interrupted = interruptedStatus(generation, this.generation, options.signal);
      if (interrupted || failure !== undefined || staged.some(candidate => !candidate)) {
        const disposition: DeepAssetStageDisposition = "rolled-back";
        const cleanup = await releaseAll(this.adapter, staged, disposition);
        return result(interrupted ?? "failed", generation, concurrency, commit, {
          staged: stagedCount, reused: commit.reuseBlobHashes.length, released: cleanup.released,
          releaseFailures: cleanup.failures, ...(failure === undefined ? {} : { failure: message(failure) }),
        });
      }
      const ordered = staged as DeepAssetStagedBlob<THandle>[];
      let outcome: ReturnType<DeepAssetPackageStoreAdapter<THandle>["commit"]>;
      try {
        outcome = this.adapter.commit(Object.freeze({
          generation, packageValue, commit, stagedBlobs: Object.freeze([...ordered]),
          isCurrent: () => generation === this.generation && !controller.signal.aborted,
        }));
      } catch (error) {
        const cleanup = await releaseAll(this.adapter, ordered, "rolled-back");
        return result("failed", generation, concurrency, commit, { staged: stagedCount,
          reused: commit.reuseBlobHashes.length, released: cleanup.released,
          releaseFailures: cleanup.failures, failure: message(error) });
      }
      if (outcome !== "committed" && outcome !== "revision-conflict" && outcome !== "superseded") {
        const cleanup = await releaseAll(this.adapter, ordered, "rolled-back");
        return result("failed", generation, concurrency, commit, { staged: stagedCount,
          reused: commit.reuseBlobHashes.length, released: cleanup.released,
          releaseFailures: cleanup.failures, failure: "Asset store adapter returned an invalid CAS outcome." });
      }
      if (outcome !== "committed") {
        const cleanup = await releaseAll(this.adapter, ordered, "rolled-back");
        return result(outcome === "revision-conflict" ? "revision-conflict" : "superseded",
          generation, concurrency, commit, { staged: stagedCount, reused: commit.reuseBlobHashes.length,
            released: cleanup.released, releaseFailures: cleanup.failures });
      }
      this.lastGood = commit;
      const cleanup = await releaseAll(this.adapter, ordered, "committed");
      return result("committed", generation, concurrency, commit, { staged: stagedCount,
        reused: commit.reuseBlobHashes.length, committed: ordered.length,
        released: cleanup.released, releaseFailures: cleanup.failures });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.pending?.controller.abort(SUPERSEDED); this.pending = undefined;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Deep Asset Package store executor is disposed.");
  }
}

function immutablePackage(value: DeepAssetPackage): DeepAssetPackage {
  const clone = JSON.parse(JSON.stringify(value)) as DeepAssetPackage;
  const freeze = (input: unknown): void => {
    if (!input || typeof input !== "object" || Object.isFrozen(input)) return;
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  };
  freeze(clone); return clone;
}

function immutableCommit(value: DeepAssetImportCommit): DeepAssetImportCommit {
  return Object.freeze({ ...value, nextActive: Object.freeze({ ...value.nextActive }),
    resourceOrder: Object.freeze([...value.resourceOrder]),
    addBlobHashes: Object.freeze([...value.addBlobHashes]),
    reuseBlobHashes: Object.freeze([...value.reuseBlobHashes]) });
}

function verifyStage<THandle>(candidate: DeepAssetStagedBlob<THandle>, expected: DeepAssetPackage["blobs"][number]): void {
  const descriptor = candidate?.descriptor, proof = candidate?.verification;
  if (!descriptor || descriptor.hash !== expected.hash || descriptor.byteLength !== expected.byteLength
    || descriptor.mediaType !== expected.mediaType || proof?.authority !== "adapter-sha256"
    || proof.algorithm !== "sha256" || proof.verified !== true
    || proof.contentHash !== expected.hash || proof.byteLength !== expected.byteLength) {
    throw new Error(`Staged blob ${expected.hash} lacks matching adapter SHA-256 verification.`);
  }
}

function unchanged(snapshot: unknown, commit: DeepAssetImportCommit): boolean {
  if (!snapshot || typeof snapshot !== "object" || !("active" in snapshot)) return false;
  const active = (snapshot as { active?: DeepAssetImportCommit["nextActive"] | null }).active;
  return commit.addBlobHashes.length === 0 && active?.packageId === commit.nextActive.packageId
    && active.sourceHash === commit.nextActive.sourceHash && active.recipeHash === commit.nextActive.recipeHash;
}

function interruptedStatus(generation: number, current: number, external: AbortSignal | undefined): "superseded" | "aborted" | undefined {
  if (generation !== current) return "superseded";
  if (external?.aborted) return "aborted";
  return undefined;
}

async function releaseAll<THandle>(adapter: DeepAssetPackageStoreAdapter<THandle>,
  values: readonly (DeepAssetStagedBlob<THandle> | undefined)[], disposition: DeepAssetStageDisposition) {
  let released = 0; const failures: string[] = [];
  for (const value of values) if (value) {
    try { await adapter.releaseBlob(value, disposition); released++; }
    catch (error) { if (failures.length < MAX_RELEASE_FAILURES) failures.push(message(error)); }
  }
  return { released, failures: Object.freeze(failures) };
}

function boundedConcurrency(value = 4): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEEP_ASSET_STORE_MAX_CONCURRENCY) {
    throw new RangeError("Asset store concurrency must be an integer from 1 through 16.");
  }
  return value;
}

interface Counts { readonly issues?: readonly DeepAssetPackageStoreResult["issues"][number][];
  readonly staged?: number; readonly reused?: number; readonly committed?: number; readonly released?: number;
  readonly releaseFailures?: readonly string[]; readonly failure?: string }
function result(status: DeepAssetPackageStoreResult["status"], generation: number, concurrency: number,
  commit: DeepAssetImportCommit | null, counts: Counts = {}): DeepAssetPackageStoreResult {
  return Object.freeze({ status, generation, concurrency, commit, issues: Object.freeze([...(counts.issues ?? [])]),
    stagedBlobs: counts.staged ?? 0, reusedBlobs: counts.reused ?? 0, committedBlobs: counts.committed ?? 0,
    releasedBlobs: counts.released ?? 0, releaseFailures: Object.freeze([...(counts.releaseFailures ?? [])]),
    ...(counts.failure ? { failure: counts.failure } : {}) });
}

function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 512); }
