import type { DeepAssetPackage, DeepAssetResource } from "./assetPackage.js";
import { validateDeepAssetPackage } from "./assetPackageValidation.js";
import { planDeepAssetReimport, type DeepAssetReimportIssue, type DeepAssetReimportPlan,
  type DeepAssetUserOverride } from "./assetReimport.js";
import { DEEP_ASSET_STORE_MAX_CONCURRENCY } from "./assetPackageStoreTypes.js";
import type {
  DeepAssetPreparedResource, DeepAssetReimportAdapter, DeepAssetReimportApplyRequest,
  DeepAssetReimportCoordinatorOptions, DeepAssetReimportCoordinatorResult,
} from "./assetReimportCoordinatorTypes.js";

const SUPERSEDED = Object.freeze({ reason: "deep-asset-reimport-superseded" });
const MAX_RELEASE_FAILURES = 64;
interface Pending { readonly controller: AbortController }

/** Coordinates dependency-safe resource staging with one generation/revision guarded publication. */
export class DeepAssetReimportCoordinator<THandle, TTransaction> {
  private generation = 0;
  private pending: Pending | undefined;
  private disposed = false;
  private lastGood: DeepAssetReimportPlan | undefined;

  constructor(private readonly adapter: DeepAssetReimportAdapter<THandle, TTransaction>) {}
  get lastCommitted(): DeepAssetReimportPlan | undefined { return this.lastGood; }

  async publish(previousInput: unknown, nextInput: unknown,
    options: DeepAssetReimportCoordinatorOptions = {}): Promise<DeepAssetReimportCoordinatorResult> {
    this.assertUsable(); const concurrency = boundedConcurrency(options.concurrency);
    const previous = ownedPackage(previousInput), next = ownedPackage(nextInput);
    if (!previous.value || !next.value) return result("rejected", this.generation, concurrency, null,
      { issues: [...previous.issues, ...next.issues] });
    const overrides = snapshotOverrides(options.overrides);
    this.pending?.controller.abort(SUPERSEDED);
    const generation = ++this.generation, controller = new AbortController(), pending = { controller };
    this.pending = pending;
    const relay = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relay, { once: true });
    let plan: DeepAssetReimportPlan | null = null;
    const prepared = new Map<string, DeepAssetPreparedResource<THandle>>();
    let transaction: TTransaction | undefined, applied = 0, failure: unknown;
    try {
      if (options.signal?.aborted) return result("aborted", generation, concurrency, null);
      let snapshot;
      try { snapshot = await this.adapter.readSnapshot(controller.signal); }
      catch (error) {
        const status = interrupted(generation, this.generation, options.signal);
        return result(status ?? "failed", generation, concurrency, null, status ? {} : { failure: message(error) });
      }
      const stopped = interrupted(generation, this.generation, options.signal);
      if (stopped) return result(stopped, generation, concurrency, null);
      plan = planDeepAssetReimport(previous.value, next.value, snapshot, { generation, overrides });
      if (plan.status !== "ready" || !plan.execution || !plan.commit) {
        return result(plan.status === "conflicted" ? "conflicted" : "rejected", generation, concurrency, plan,
          { issues: plan.issues });
      }
      if (isUnchanged(plan, previous.value, next.value)) return result("unchanged", generation, concurrency, plan);
      const byId = new Map(next.value.manifest.resources.map(resource => [resource.id, resource]));
      failure = await prepareResources(this.adapter, next.value, plan, overrides, byId, prepared, concurrency,
        generation, controller, () => generation === this.generation);
      const afterPrepare = interrupted(generation, this.generation, options.signal);
      if (failure !== undefined || afterPrepare) {
        const cleanup = await releasePrepared(this.adapter, prepared, plan.execution.rollbackOrder, "rolled-back");
        return result(afterPrepare ?? "failed", generation, concurrency, plan, counts(prepared, 0, cleanup,
          failure === undefined ? {} : { failure: message(failure) }));
      }
      try {
        transaction = await this.adapter.beginApply(Object.freeze({ generation, packageValue: next.value, plan,
          prepared: Object.freeze(plan.execution.stageOrder.map(id => prepared.get(id)!)) }), controller.signal);
        for (const id of plan.execution.publishOrder) {
          await this.adapter.apply(transaction, applyRequest("publish", byId.get(id)!, prepared.get(id), overrides), controller.signal);
          applied++; assertCurrent(generation, this.generation, controller.signal);
        }
        const oldById = new Map(previous.value.manifest.resources.map(resource => [resource.id, resource]));
        for (const id of plan.execution.removeOrder) {
          await this.adapter.apply(transaction, applyRequest("remove", oldById.get(id)!, undefined, []), controller.signal);
          applied++; assertCurrent(generation, this.generation, controller.signal);
        }
        assertCurrent(generation, this.generation, controller.signal);
      } catch (error) { failure = error; }
      const afterApply = interrupted(generation, this.generation, options.signal);
      if (failure !== undefined || afterApply) {
        const rollbackFailure = transaction === undefined ? undefined
          : await rollback(this.adapter, transaction, plan.execution.rollbackOrder, failure ?? controller.signal.reason);
        const cleanup = await releasePrepared(this.adapter, prepared, plan.execution.rollbackOrder, "rolled-back");
        return result(afterApply ?? "failed", generation, concurrency, plan, counts(prepared, applied, cleanup,
          { rollback: transaction !== undefined, ...(rollbackFailure ? { rollbackFailure } : {}),
            ...(failure === undefined ? {} : { failure: message(failure) }) }));
      }
      let outcome: ReturnType<DeepAssetReimportAdapter<THandle, TTransaction>["commit"]>;
      try {
        outcome = this.adapter.commit(Object.freeze({ generation, transaction: transaction!, packageValue: next.value,
          packageCommit: plan.commit, plan, isCurrent: () => generation === this.generation && !controller.signal.aborted }));
      } catch (error) { failure = error; outcome = "revision-conflict"; }
      if (outcome !== "committed" && outcome !== "revision-conflict" && outcome !== "superseded") {
        failure = new Error("Asset reimport adapter returned an invalid CAS outcome."); outcome = "revision-conflict";
      }
      if (outcome !== "committed") {
        const status = interrupted(generation, this.generation, options.signal)
          ?? (outcome === "superseded" ? "superseded" : "revision-conflict");
        const rollbackFailure = await rollback(this.adapter, transaction!, plan.execution.rollbackOrder, failure ?? status);
        const cleanup = await releasePrepared(this.adapter, prepared, plan.execution.rollbackOrder, "rolled-back");
        return result(failure === undefined ? status : "failed", generation, concurrency, plan,
          counts(prepared, applied, cleanup, { rollback: true, ...(rollbackFailure ? { rollbackFailure } : {}),
            ...(failure === undefined ? {} : { failure: message(failure) }) }));
      }
      this.lastGood = plan;
      const cleanup = await releasePrepared(this.adapter, prepared, plan.execution.rollbackOrder, "committed");
      return result("committed", generation, concurrency, plan, counts(prepared, applied, cleanup));
    } finally {
      options.signal?.removeEventListener("abort", relay);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.pending?.controller.abort(SUPERSEDED); this.pending = undefined;
  }
  private assertUsable(): void { if (this.disposed) throw new Error("Deep Asset reimport coordinator is disposed."); }
}

async function prepareResources<THandle, TTransaction>(adapter: DeepAssetReimportAdapter<THandle, TTransaction>,
  packageValue: DeepAssetPackage, plan: DeepAssetReimportPlan, overrides: readonly DeepAssetUserOverride[],
  byId: ReadonlyMap<string, DeepAssetResource>, prepared: Map<string, DeepAssetPreparedResource<THandle>>,
  concurrency: number, generation: number, controller: AbortController, current: () => boolean): Promise<unknown> {
  const required = new Set(plan.execution!.stageOrder), remaining = new Set(required);
  while (remaining.size && !controller.signal.aborted) {
    const ready = plan.execution!.stageOrder.filter(id => remaining.has(id)
      && byId.get(id)!.dependencies.every(dependency => !required.has(dependency) || prepared.has(dependency)));
    if (!ready.length) return new Error("Reimport prepare graph is not dependency ordered.");
    for (let offset = 0; offset < ready.length && !controller.signal.aborted; offset += concurrency) {
      const batch = ready.slice(offset, offset + concurrency);
      const outcomes = await Promise.allSettled(batch.map(async id => {
        const resource = byId.get(id)!, candidate = await adapter.prepare(Object.freeze({ generation, packageValue,
          resource, overrides: Object.freeze(overrides.filter(value => value.resourceId === id)) }), controller.signal);
        prepared.set(id, candidate); verifyPrepared(candidate, id);
        prepared.set(id, Object.freeze({ resourceId: candidate.resourceId,
          disposition: candidate.disposition, handle: candidate.handle })); return id;
      }));
      let failure: unknown;
      outcomes.forEach(outcome => { if (outcome.status === "fulfilled") remaining.delete(outcome.value);
        else failure ??= outcome.reason; });
      if (failure !== undefined) { controller.abort(failure); return failure; }
      if (!current()) { controller.abort(SUPERSEDED); return undefined; }
    }
  }
  return undefined;
}

function applyRequest<THandle>(kind: "publish" | "remove", resource: DeepAssetResource,
  prepared: DeepAssetPreparedResource<THandle> | undefined,
  overrides: readonly DeepAssetUserOverride[]): DeepAssetReimportApplyRequest<THandle> {
  return Object.freeze({ kind, resource, ...(prepared ? { prepared } : {}),
    overrides: Object.freeze(overrides.filter(value => value.resourceId === resource.id)) });
}
function verifyPrepared<T>(value: DeepAssetPreparedResource<T>, id: string): void {
  if (!value || value.resourceId !== id || (value.disposition !== "prepared" && value.disposition !== "reused")) {
    throw new Error(`Prepared reimport resource does not match ${id}.`);
  }
}
async function rollback<THandle, TTransaction>(adapter: DeepAssetReimportAdapter<THandle, TTransaction>,
  transaction: TTransaction, order: readonly string[], cause: unknown): Promise<string | undefined> {
  try { await adapter.rollback(transaction, order, cause); return undefined; }
  catch (error) { return message(error); }
}
async function releasePrepared<THandle, TTransaction>(adapter: DeepAssetReimportAdapter<THandle, TTransaction>,
  prepared: ReadonlyMap<string, DeepAssetPreparedResource<THandle>>, order: readonly string[], disposition: "committed" | "rolled-back") {
  let released = 0; const failures: string[] = [];
  for (const id of order) { const value = prepared.get(id); if (!value) continue;
    try { await adapter.release(value, disposition); released++; }
    catch (error) { if (failures.length < MAX_RELEASE_FAILURES) failures.push(message(error)); }
  }
  return { released, failures: Object.freeze(failures) };
}
function interrupted(generation: number, current: number, signal: AbortSignal | undefined): "superseded" | "aborted" | undefined {
  if (generation !== current) return "superseded"; if (signal?.aborted) return "aborted"; return undefined;
}
function assertCurrent(generation: number, current: number, signal: AbortSignal): void {
  if (generation !== current || signal.aborted) { const error = new Error("Reimport generation is stale."); error.name = "AbortError"; throw error; }
}
function isUnchanged(plan: DeepAssetReimportPlan, previous: DeepAssetPackage, next: DeepAssetPackage): boolean {
  return plan.commit?.addBlobHashes.length === 0 && JSON.stringify(previous) === JSON.stringify(next);
}
function boundedConcurrency(value = 4): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEEP_ASSET_STORE_MAX_CONCURRENCY) {
    throw new RangeError("Asset reimport concurrency must be an integer from 1 through 16.");
  } return value;
}
function ownedPackage(input: unknown) {
  const validation = validateDeepAssetPackage(input);
  if (!validation.value) return { value: undefined, issues: validation.issues };
  const value = JSON.parse(JSON.stringify(validation.value)) as DeepAssetPackage; deepFreeze(value);
  return { value, issues: [] as const };
}
function deepFreeze(value: unknown): void { if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(deepFreeze); Object.freeze(value); }
function snapshotOverrides(values: readonly DeepAssetUserOverride[] | undefined): readonly DeepAssetUserOverride[] {
  return Object.freeze((values ?? []).map(value => Object.freeze({ ...value })));
}
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 512); }

interface ResultCounts { readonly issues?: readonly DeepAssetReimportIssue[]; readonly prepared?: number; readonly reused?: number;
  readonly applied?: number; readonly released?: number; readonly rollback?: boolean; readonly rollbackFailure?: string;
  readonly releaseFailures?: readonly string[]; readonly failure?: string }
function counts<T>(prepared: ReadonlyMap<string, DeepAssetPreparedResource<T>>, applied: number,
  cleanup: { released: number; failures: readonly string[] }, extra: ResultCounts = {}): ResultCounts {
  return { prepared: [...prepared.values()].filter(value => value.disposition === "prepared").length,
    reused: [...prepared.values()].filter(value => value.disposition === "reused").length,
    applied, released: cleanup.released, releaseFailures: cleanup.failures, ...extra };
}
function result(status: DeepAssetReimportCoordinatorResult["status"], generation: number, concurrency: number,
  plan: DeepAssetReimportPlan | null, value: ResultCounts = {}): DeepAssetReimportCoordinatorResult {
  return Object.freeze({ status, generation, concurrency, plan, issues: Object.freeze([...(value.issues ?? [])]),
    preparedResources: value.prepared ?? 0, reusedResources: value.reused ?? 0,
    appliedOperations: value.applied ?? 0, releasedResources: value.released ?? 0,
    rollbackAttempted: value.rollback ?? false, releaseFailures: Object.freeze([...(value.releaseFailures ?? [])]),
    ...(value.rollbackFailure ? { rollbackFailure: value.rollbackFailure } : {}),
    ...(value.failure ? { failure: value.failure } : {}) });
}
