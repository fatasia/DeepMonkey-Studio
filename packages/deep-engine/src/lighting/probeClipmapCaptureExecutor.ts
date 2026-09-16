import type {
  ProbeClipmapGpuResource, ProbeClipmapResourceUpdate,
} from "./probeClipmapResources.js";
import { runResourceCleanup } from "../webgpu/resourceCleanup.js";
import type { ProbeClipmapPlan, ProbeUpdate } from "./probeClipmapPlan.js";
import type {
  ProbeClipmapPlanPublisher, ProbeClipmapPublicationContext,
} from "./probeClipmapUpdateScheduler.js";

export interface ProbeClipmapResourceOwner extends ProbeClipmapPlanPublisher {
  readonly deviceEpoch: string;
  dispose(): void;
}
export interface ProbeCaptureBeginContext {
  readonly generation: number;
  readonly deviceEpoch: string;
  readonly plan: ProbeClipmapPlan;
  readonly resource: ProbeClipmapGpuResource;
  readonly signal: AbortSignal;
  readonly publication?: ProbeClipmapPublicationContext;
}
export interface ProbeCaptureTransaction<TSubmission, TPublished = void> {
  encodeCapture(update: ProbeUpdate, updateIndex: number): void;
  encodeFilter(update: ProbeUpdate, updateIndex: number): void;
  encodeMips(update: ProbeUpdate, updateIndex: number): void;
  finish(): TSubmission;
  /** Atomically exposes the staged probe data. Must not retain old visible handles. */
  commit(): TPublished;
  /** Retires staged resources safely even when submitted GPU work may still complete. */
  rollback(reason: unknown): void;
}
export interface ProbeCaptureAdapter<TSubmission, TPublished = void> {
  readonly deviceEpoch: string;
  begin(context: ProbeCaptureBeginContext): ProbeCaptureTransaction<TSubmission, TPublished>;
  submit(submission: TSubmission, signal: AbortSignal): PromiseLike<void> | void;
  dispose?(): void;
}
export interface ProbeCaptureExecutorOptions {
  readonly maxUpdatesPerBatch?: number;
  readonly deviceLost?: PromiseLike<unknown>;
}
export interface ProbeCaptureExecutionStats {
  readonly generation: number;
  readonly frame: number;
  readonly schedulerGeneration: number;
  readonly deviceEpoch: string;
  readonly updateCount: number;
  readonly captureCount: number;
  readonly filterCount: number;
  readonly mipCount: number;
  readonly updatesByLevel: readonly number[];
  readonly committedBatchCount: number;
  readonly committedUpdateCount: number;
  readonly resourceStatus: ProbeClipmapResourceUpdate["status"];
}
export interface ProbeCaptureSnapshot<TPublished = void> {
  readonly resource: ProbeClipmapGpuResource;
  readonly stats: ProbeCaptureExecutionStats;
  readonly published?: TPublished;
}

/**
 * Executes a scheduler plan as one staged capture/filter/mip transaction. This object is the
 * publication boundary: renderers should consume `current`, not an in-flight resource plan.
 */
export class ProbeClipmapCaptureExecutor<TSubmission, TPublished = void> implements ProbeClipmapPlanPublisher {
  private generation = 0;
  private active: AbortController | undefined;
  private snapshot: ProbeCaptureSnapshot<TPublished> | undefined;
  private terminalReason: Error | undefined;
  private readonly maxUpdates: number;

  constructor(private readonly resources: ProbeClipmapResourceOwner,
    private readonly adapter: ProbeCaptureAdapter<TSubmission, TPublished>,
    options: ProbeCaptureExecutorOptions = {}) {
    if (!resources || typeof resources.setValidated !== "function" || typeof resources.dispose !== "function") {
      throw new TypeError("Probe capture resources are invalid.");
    }
    if (!adapter || typeof adapter.begin !== "function" || typeof adapter.submit !== "function") {
      throw new TypeError("Probe capture adapter is invalid.");
    }
    if (resources.deviceEpoch !== adapter.deviceEpoch) throw new Error("Probe capture device epochs differ.");
    this.maxUpdates = integer(options.maxUpdatesPerBatch ?? 65_536, "maxUpdatesPerBatch");
    if (options.deviceLost) void Promise.resolve(options.deviceLost).then(
      reason => this.handleDeviceLoss(reason), reason => this.handleDeviceLoss(reason)).catch(() => undefined);
  }

  get current(): ProbeCaptureSnapshot<TPublished> | undefined { return this.snapshot; }
  get statistics(): ProbeCaptureExecutionStats | undefined { return this.snapshot?.stats; }
  get disposed(): boolean { return this.terminalReason !== undefined; }

  async setValidated(plan: ProbeClipmapPlan, deviceEpoch: string, signal?: AbortSignal,
    context?: ProbeClipmapPublicationContext): Promise<ProbeClipmapResourceUpdate> {
    this.assertReady(plan, deviceEpoch, signal, context);
    const generation = ++this.generation;
    this.active?.abort(abortError("Probe capture batch was superseded."));
    const controller = new AbortController(), unlink = signal ? relayAbort(signal, controller) : () => {};
    this.active = controller;
    let transaction: ProbeCaptureTransaction<TSubmission, TPublished> | undefined;
    try {
      const resourceUpdate = await waitForAbort(
        this.resources.setValidated(plan, deviceEpoch, controller.signal), controller.signal);
      this.assertCurrent(generation, deviceEpoch, controller.signal);
      if (plan.updates.length === 0) {
        this.snapshot = createSnapshot(resourceUpdate, createStats(generation, deviceEpoch, plan,
          context, resourceUpdate, this.snapshot?.stats),
        resourceUpdate.status === "reused" ? this.snapshot?.published : undefined);
        return resourceUpdate;
      }
      transaction = this.adapter.begin(Object.freeze({ generation, deviceEpoch, plan,
        resource: resourceUpdate.resource, signal: controller.signal,
        ...(context ? { publication: context } : {}) }));
      this.encodePhase(plan.updates, controller.signal, transaction.encodeCapture.bind(transaction));
      this.encodePhase(plan.updates, controller.signal, transaction.encodeFilter.bind(transaction));
      this.encodePhase(plan.updates, controller.signal, transaction.encodeMips.bind(transaction));
      const submission = transaction.finish();
      this.assertCurrent(generation, deviceEpoch, controller.signal);
      await waitForAbort(Promise.resolve(this.adapter.submit(submission, controller.signal)), controller.signal);
      this.assertCurrent(generation, deviceEpoch, controller.signal);
      const published = transaction.commit(); transaction = undefined;
      this.snapshot = createSnapshot(resourceUpdate, createStats(generation, deviceEpoch, plan,
        context, resourceUpdate, this.snapshot?.stats), published);
      return resourceUpdate;
    } catch (error) {
      if (transaction) {
        try { transaction.rollback(error); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Probe capture rollback failed."); }
      }
      throw error;
    } finally {
      unlink(); if (this.active === controller) this.active = undefined;
    }
  }

  handleDeviceLoss(reason?: unknown): void {
    this.terminate(abortError(message(reason, "Probe capture device was lost.")));
  }
  dispose(): void { this.terminate(abortError("Probe capture executor was disposed.")); }

  private encodePhase(updates: readonly ProbeUpdate[], signal: AbortSignal,
    encode: (update: ProbeUpdate, updateIndex: number) => void): void {
    updates.forEach((update, index) => {
      signal.throwIfAborted(); encode(update, index);
    });
  }

  private assertReady(plan: ProbeClipmapPlan, deviceEpoch: string, signal: AbortSignal | undefined,
    context: ProbeClipmapPublicationContext | undefined): void {
    if (this.terminalReason) throw this.terminalReason;
    if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError("Probe capture signal is invalid.");
    signal?.throwIfAborted();
    if (deviceEpoch !== this.resources.deviceEpoch || deviceEpoch !== this.adapter.deviceEpoch) {
      throw new Error("Probe capture device epoch mismatch.");
    }
    if (!plan || !Array.isArray(plan.updates) || !plan.profile) throw new TypeError("Probe capture plan is invalid.");
    if (plan.profile.updateBudget > this.maxUpdates || plan.updates.length > this.maxUpdates
      || plan.updates.length > plan.profile.updateBudget) throw new RangeError("Probe capture update budget exceeded.");
    if (new Set(plan.updates.map(updateKey)).size !== plan.updates.length) {
      throw new Error("Probe capture plan contains duplicate updates.");
    }
    if (context) validateContext(context, plan);
  }

  private assertCurrent(generation: number, deviceEpoch: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.terminalReason) throw this.terminalReason;
    if (generation !== this.generation) throw abortError("Probe capture batch is stale.");
    if (deviceEpoch !== this.resources.deviceEpoch || deviceEpoch !== this.adapter.deviceEpoch) {
      throw abortError("Probe capture device epoch changed.");
    }
  }

  private terminate(reason: Error): void {
    if (this.terminalReason) return;
    this.terminalReason = reason; this.generation++;
    this.active?.abort(reason); this.active = undefined; this.snapshot = undefined;
    runResourceCleanup("Probe capture executor disposal failed.", [
      () => this.resources.dispose(), () => this.adapter.dispose?.(),
    ]);
  }
}

function validateContext(context: ProbeClipmapPublicationContext, plan: ProbeClipmapPlan): void {
  if (!Number.isSafeInteger(context.frame) || context.frame < 0
    || !Number.isSafeInteger(context.schedulerGeneration) || context.schedulerGeneration < 1
    || typeof context.cameraCut !== "boolean"
    || !["initial", "none", "device-epoch", "resize"].includes(context.invalidation)) {
    throw new RangeError("Probe capture publication context is invalid.");
  }
  integer(context.frameBudget, "frameBudget"); integer(context.capacityBudget, "capacityBudget");
  if (context.capacityBudget !== plan.profile.updateBudget || context.frameBudget > context.capacityBudget
    || plan.updates.length > context.frameBudget) throw new RangeError("Probe capture frame budget exceeded.");
}
function createStats(generation: number, deviceEpoch: string, plan: ProbeClipmapPlan,
  context: ProbeClipmapPublicationContext | undefined, resource: ProbeClipmapResourceUpdate,
  previous: ProbeCaptureExecutionStats | undefined): ProbeCaptureExecutionStats {
  const byLevel = Array.from({ length: plan.profile.levelCount }, () => 0);
  plan.updates.forEach(update => { byLevel[update.level] = (byLevel[update.level] ?? 0) + 1; });
  const count = plan.updates.length;
  return Object.freeze({ generation, frame: context?.frame ?? -1,
    schedulerGeneration: context?.schedulerGeneration ?? 0, deviceEpoch, updateCount: count,
    captureCount: count, filterCount: count, mipCount: count, updatesByLevel: Object.freeze(byLevel),
    committedBatchCount: (previous?.committedBatchCount ?? 0) + 1,
    committedUpdateCount: (previous?.committedUpdateCount ?? 0) + count,
    resourceStatus: resource.status });
}
function createSnapshot<TPublished>(resource: ProbeClipmapResourceUpdate,
  stats: ProbeCaptureExecutionStats, published: TPublished | undefined): ProbeCaptureSnapshot<TPublished> {
  return Object.freeze({ resource: resource.resource, stats,
    ...(published === undefined ? {} : { published }) });
}
function updateKey(update: ProbeUpdate): string { return `${update.level}:${update.cell.join(":")}`; }
function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new RangeError(`${name} must be an integer in 1..65536.`);
  }
  return value;
}
function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}
function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason ?? abortError("Probe capture batch was cancelled."));
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let reject!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, fail) => { reject = fail; });
  const onAbort = () => reject(signal.reason ?? abortError("Probe capture batch was cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function abortError(value: string): Error { const error = new Error(value); error.name = "AbortError"; return error; }
function message(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? `${fallback} ${reason.message}` : fallback;
}
