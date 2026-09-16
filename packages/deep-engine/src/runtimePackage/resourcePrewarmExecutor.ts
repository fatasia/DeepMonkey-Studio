import { RuntimePackageError } from "./primitives.js";
import { DEEP_RUNTIME_PREWARM_LIMITS, type RuntimeResourcePrewarmAdapter,
  type RuntimeResourcePrewarmCandidate, type RuntimeResourcePrewarmItem,
  type RuntimeResourcePrewarmPlan, type RuntimeResourcePrewarmResult,
  type RuntimeResourcePrewarmRunOptions, type RuntimeResourcePrewarmStrategy } from "./resourcePrewarmTypes.js";
import { validateDeepRuntimePackage } from "./validation.js";

const SUPERSEDED = Object.freeze({ reason: "runtime-package-prewarm-superseded" });
type Candidate<TLoaded, TPrepared, TBake> = RuntimeResourcePrewarmCandidate<TLoaded, TPrepared, TBake>;
interface Active<TLoaded, TPrepared, TBake> {
  readonly plan: RuntimeResourcePrewarmPlan<TBake>;
  readonly candidates: readonly Candidate<TLoaded, TPrepared, TBake>[];
}
interface Pending { readonly controller: AbortController }

/** Owns committed resource candidates; actual presentation remains a host responsibility. */
export class RuntimeResourcePrewarmExecutor<TLoaded, TPrepared, TBake = never,
  TOptions extends RuntimeResourcePrewarmRunOptions = RuntimeResourcePrewarmRunOptions> {
  private generation = 0;
  private pending: Pending | undefined;
  private active: Active<TLoaded, TPrepared, TBake> | undefined;
  private disposed = false;
  private committing = false;

  constructor(private readonly adapter: RuntimeResourcePrewarmAdapter<TLoaded, TPrepared, TBake>,
    private readonly strategy: RuntimeResourcePrewarmStrategy<TBake, TOptions>) {}

  get activePlan(): RuntimeResourcePrewarmPlan<TBake> | undefined { return this.active?.plan; }

  async publish(input: unknown, options: TOptions = {} as TOptions): Promise<RuntimeResourcePrewarmResult<TBake>> {
    this.assertUsable();
    const validation = validateDeepRuntimePackage(input);
    if (!validation.valid) throw new RuntimePackageError(validation.issues[0]!.path, validation.issues[0]!.message);
    const packageValue = validation.value;
    const concurrency = boundedConcurrency(options.concurrency);
    if (this.active?.plan.packageHash === packageValue.packageHash.value
      && this.strategy.matchesOptions(this.active.plan, options)) {
      const active = this.active;
      if (options.signal?.aborted) return result("aborted", this.generation, active.plan, concurrency);
      // 返回当前版本也是新的发布意图，必须使仍在预热的其它版本失效。
      const pending = this.pending;
      if (pending) { this.pending = undefined; this.generation++; }
      const generation = this.generation;
      pending?.controller.abort(SUPERSEDED);
      return result("unchanged", generation, active.plan, concurrency,
        { reused: active.plan.budget.plannedItems });
    }
    const plan = this.strategy.buildPlan(packageValue, options);
    if (options.signal?.aborted) return result("aborted", this.generation, plan, concurrency);
    const previousPending = this.pending;
    const generation = ++this.generation, controller = new AbortController();
    const pending = { controller }; this.pending = pending;
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    // AbortSignal 回调可以重入；先登记候选，再通知上一轮取消。
    previousPending?.controller.abort(SUPERSEDED);
    const releaseFailures: string[] = [], candidates: Array<Candidate<TLoaded, TPrepared, TBake> | undefined>
      = new Array(plan.items.length).fill(undefined);
    const reusedKeys = new Set<string>(), groups = new Map<string, number[]>();
    const prior = new Map(this.active?.candidates.map(candidate => [candidate.item.cacheKey, candidate]) ?? []);
    let cursor = 0, loaded = 0, prepared = 0, releasedDuringWork = 0, failed = false, failure: unknown;
    for (const [index, item] of plan.items.entries()) {
      const group = groups.get(item.cacheKey);
      if (group) group.push(index); else groups.set(item.cacheKey, [index]);
      const candidate = prior.get(item.cacheKey);
      if (candidate) {
        reusedKeys.add(item.cacheKey); candidates[index] = { item, loaded: candidate.loaded, prepared: candidate.prepared };
      }
    }
    const work = [...groups].filter(([key]) => !reusedKeys.has(key))
      .map(([, indices]) => ({ item: plan.items[indices[0]!]!, indices }));
    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const position = cursor++;
        if (position >= work.length) return;
        const { item, indices } = work[position]!;
        let loadedValue: TLoaded | undefined, preparedValue: TPrepared | undefined, hasLoaded = false;
        try {
          loadedValue = await this.adapter.load(item, packageValue, controller.signal); loaded++; hasLoaded = true;
          if (controller.signal.aborted || generation !== this.generation) {
            this.release(item, loadedValue as TLoaded, undefined, releaseFailures); releasedDuringWork++; return;
          }
          preparedValue = await this.adapter.prepare(item, loadedValue as TLoaded, controller.signal); prepared++;
          if (controller.signal.aborted || generation !== this.generation) {
            this.release(item, loadedValue as TLoaded, preparedValue, releaseFailures); releasedDuringWork++; return;
          }
          for (const index of indices) candidates[index] = { item: plan.items[index]!,
            loaded: loadedValue as TLoaded, prepared: preparedValue as TPrepared };
        } catch (error) {
          if (hasLoaded) {
            this.release(item, loadedValue as TLoaded, preparedValue, releaseFailures); releasedDuringWork++;
          }
          if (!controller.signal.aborted && !failed) { failed = true; failure = error; controller.abort(error); }
          return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, work.length)) }, worker));
      const stale = generation !== this.generation || controller.signal.reason === SUPERSEDED;
      if (stale) {
        const released = this.releaseNew(candidates, reusedKeys, releaseFailures);
        return result("superseded", generation, plan, concurrency,
          { loaded, prepared, reused: reusedKeys.size, released: released + releasedDuringWork, releaseFailures });
      }
      if (options.signal?.aborted) {
        const released = this.releaseNew(candidates, reusedKeys, releaseFailures);
        return result("aborted", generation, plan, concurrency,
          { loaded, prepared, reused: reusedKeys.size, released: released + releasedDuringWork, releaseFailures });
      }
      if (failed || candidates.some(candidate => !candidate)) {
        const released = this.releaseNew(candidates, reusedKeys, releaseFailures);
        return result("failed", generation, plan, concurrency, { loaded, prepared, reused: reusedKeys.size,
          released: released + releasedDuringWork, releaseFailures,
          failure: message(failure ?? "Runtime prewarm did not produce every candidate.") });
      }
      const ordered = candidates as Candidate<TLoaded, TPrepared, TBake>[];
      try {
        this.committing = true;
        try { this.adapter.commit(plan, ordered); }
        finally { this.committing = false; }
      }
      catch (error) {
        const released = this.releaseNew(candidates, reusedKeys, releaseFailures);
        return result("failed", generation, plan, concurrency, { loaded, prepared, reused: reusedKeys.size,
          released: released + releasedDuringWork, releaseFailures, failure: message(error) });
      }
      finally { this.committing = false; }
      const previous = this.active;
      this.active = { plan, candidates: ordered };
      let released = 0;
      const releasedKeys = new Set<string>();
      for (const candidate of previous?.candidates ?? []) if (!reusedKeys.has(candidate.item.cacheKey)
        && !releasedKeys.has(candidate.item.cacheKey)) {
        releasedKeys.add(candidate.item.cacheKey);
        this.release(candidate.item, candidate.loaded, candidate.prepared, releaseFailures); released++;
      }
      return result("committed", generation, plan, concurrency, { loaded, prepared,
        reused: reusedKeys.size, committed: ordered.length, released: released + releasedDuringWork, releaseFailures });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  dispose(): void {
    this.assertOutsideCommit();
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.pending?.controller.abort(SUPERSEDED); this.pending = undefined;
    const failures: string[] = [];
    const released = new Set<string>();
    for (const candidate of this.active?.candidates ?? []) if (!released.has(candidate.item.cacheKey)) {
      released.add(candidate.item.cacheKey); this.release(candidate.item, candidate.loaded, candidate.prepared, failures);
    }
    this.active = undefined;
  }

  private releaseNew(candidates: readonly (Candidate<TLoaded, TPrepared, TBake> | undefined)[],
    reused: ReadonlySet<string>, failures: string[]): number {
    let released = 0; const keys = new Set<string>();
    for (const candidate of candidates) if (candidate && !reused.has(candidate.item.cacheKey)
      && !keys.has(candidate.item.cacheKey)) {
      keys.add(candidate.item.cacheKey);
      this.release(candidate.item, candidate.loaded, candidate.prepared, failures); released++;
    }
    return released;
  }
  private release(item: RuntimeResourcePrewarmItem<TBake>, loaded: TLoaded, prepared: TPrepared | undefined,
    failures: string[]): void {
    try { this.adapter.release(item, loaded, prepared); }
    catch (error) { failures.push(message(error)); }
  }
  private assertUsable(): void {
    this.assertOutsideCommit();
    if (this.disposed) throw new Error("Runtime package prewarm executor is disposed.");
  }
  private assertOutsideCommit(): void {
    if (this.committing) throw new Error("Runtime prewarm commit does not allow publish/dispose reentrancy.");
  }
}

interface ResultCounts { readonly loaded?: number; readonly prepared?: number; readonly reused?: number;
  readonly committed?: number; readonly released?: number; readonly releaseFailures?: readonly string[]; readonly failure?: string }
function result<TBake>(status: RuntimeResourcePrewarmResult["status"], generation: number, plan: RuntimeResourcePrewarmPlan<TBake>,
  concurrency: number, counts: ResultCounts = {}): RuntimeResourcePrewarmResult<TBake> {
  return Object.freeze({ status, generation, plan, concurrency, loadedItems: counts.loaded ?? 0,
    preparedItems: counts.prepared ?? 0, reusedItems: counts.reused ?? 0, committedItems: counts.committed ?? 0,
    releasedItems: counts.released ?? 0, releaseFailures: Object.freeze([...(counts.releaseFailures ?? [])]),
    ...(counts.failure ? { failure: counts.failure } : {}) });
}
function boundedConcurrency(value = 4): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEEP_RUNTIME_PREWARM_LIMITS.concurrency) {
    throw new RangeError("Runtime prewarm concurrency must be an integer from 1 through 16.");
  }
  return value;
}
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
