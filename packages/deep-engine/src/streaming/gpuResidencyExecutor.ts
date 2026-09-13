import type { ResourceResidencyController } from "./residencyController.js";
import type { ResidencyFramePlan } from "./types.js";
import type {
  GpuResidencyExecutionResult, GpuResidencyExecutorOptions, GpuResidencyExecutorState, GpuResidencyUploader,
  GpuResidentResource, PendingGpuUpload, ValidatedGpuResidencyPlan,
} from "./gpuResidencyExecutorTypes.js";
import { GpuResidencyExecutorError } from "./gpuResidencyExecutorTypes.js";
import { validateExecutionPlan, validateExecutorOptions } from "./gpuResidencyExecutorValidation.js";
import { releaseOwned, releasePending, uploadFailures, uploadResidencyCandidates } from "./gpuResidencyUploads.js";

interface ActiveExecution {
  readonly generation: number;
  readonly plan: ResidencyFramePlan;
  readonly abort: AbortController;
  readonly promise: Promise<GpuResidencyExecutionResult>;
}

/** Executes residency plans while retaining sole ownership of installed GPU handles. */
export class GpuResidencyExecutor<THandle extends object> {
  private readonly state: GpuResidencyExecutorState<THandle>;
  private readonly maxConcurrentUploads: number;
  private active: ActiveExecution | null = null;
  private lastPlan: ResidencyFramePlan | null = null;
  private lastPromise: Promise<GpuResidencyExecutionResult> | null = null;
  private generationValue = 0;
  private terminal = false;

  constructor(controller: ResourceResidencyController, uploader: GpuResidencyUploader<THandle>, options: GpuResidencyExecutorOptions = {}) {
    if (!controller || controller.snapshot().length !== 0) throw new GpuResidencyExecutorError("invalid-options", "GPU executor requires an empty residency controller.");
    if (!uploader || typeof uploader.upload !== "function" || typeof uploader.release !== "function") {
      throw new GpuResidencyExecutorError("invalid-options", "GPU residency uploader is invalid.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new GpuResidencyExecutorError("invalid-options", "GPU executor options are invalid.");
    this.maxConcurrentUploads = validateExecutorOptions(options.maxConcurrentUploads);
    this.state = { controller, uploader, resources: new Map(), ownedHandles: new WeakSet() };
    if (options.deviceLost) void Promise.resolve(options.deviceLost)
      .then(() => this.handleDeviceLoss(), () => this.handleDeviceLoss()).catch(() => undefined);
  }

  get generation(): number { return this.generationValue; }
  get disposed(): boolean { return this.terminal; }
  get size(): number { return this.state.resources.size; }

  get(id: string): GpuResidentResource<THandle> | undefined { return this.state.resources.get(id); }
  snapshot(): readonly GpuResidentResource<THandle>[] {
    return Object.freeze([...this.state.resources.values()].sort((left, right) => left.id.localeCompare(right.id)));
  }

  execute(plan: ResidencyFramePlan, signal?: AbortSignal): Promise<GpuResidencyExecutionResult> {
    this.assertLive();
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new TypeError("GPU residency execution signal is invalid.");
    }
    if (this.active?.plan === plan) return this.active.promise;
    if (this.lastPlan === plan && this.lastPromise) return this.lastPromise;
    if (this.active) throw new GpuResidencyExecutorError("busy", "A GPU residency plan is already executing.");
    const validated = validateExecutionPlan(this.state.controller, plan);
    this.state.controller.claimPlan(plan);
    const generation = ++this.generationValue;
    const abort = new AbortController();
    const detachAbort = forwardAbort(signal, abort);
    const promise = this.executeValidated(validated, generation, abort.signal)
      .finally(() => {
        detachAbort();
        if (this.active?.generation === generation) this.active = null;
      });
    this.active = { generation, plan, abort, promise }; this.lastPlan = plan; this.lastPromise = promise;
    return promise;
  }

  cancel(reason?: unknown): void {
    this.active?.abort.abort(reason ?? new Error("GPU residency execution was cancelled."));
  }
  handleDeviceLoss(): void { this.terminate("GPU device was lost."); }
  dispose(): void { this.terminate("GPU residency executor was disposed."); }

  private async executeValidated(validated: ValidatedGpuResidencyPlan, generation: number,
    signal: AbortSignal): Promise<GpuResidencyExecutionResult> {
    let outcomes: readonly PendingGpuUpload<THandle>[] = [];
    try {
      if (signal.aborted) return this.cancelBeforeResourceChange(validated, generation);
      this.applyBeforeUploadEvictions(validated);
      outcomes = await uploadResidencyCandidates(this.state, validated.plan, signal, this.maxConcurrentUploads,
        () => this.isCurrent(generation));
      if (!this.isCurrent(generation)) { releasePending(this.state, outcomes); throw this.disposedError(); }
      if (signal.aborted) releasePending(this.state, outcomes);
      const accepted = signal.aborted ? [] : outcomes.filter((item) => item.resource !== undefined);
      const successfulIds = new Set(accepted.map((item) => item.id));
      if (!signal.aborted) this.swapAccepted(validated.plan, accepted);
      const commit = signal.aborted && validated.beforeUpload.length === 0
        ? this.state.controller.cancelPlan(validated.plan)
        : this.state.controller.commit(validated.plan, successfulIds);
      this.synchronizeCommittedState();
      return this.result(validated, generation, outcomes, commit,
        signal.aborted
          ? (validated.beforeUpload.length ? "after-before-upload-eviction" : "before-resident-eviction")
          : "not-cancelled", signal.aborted ? signal.reason : undefined);
    } catch (cause) {
      if (this.isCurrent(generation)) this.failTerminal(cause);
      throw cause;
    }
  }

  private cancelBeforeResourceChange(validated: ValidatedGpuResidencyPlan,
    generation: number): GpuResidencyExecutionResult {
    const commit = this.state.controller.cancelPlan(validated.plan);
    this.synchronizeCommittedState();
    return Object.freeze({ generation, planId: validated.plan.id, commit,
      uploadFailures: Object.freeze(validated.plan.uploads.map(upload => Object.freeze({
        id: upload.id, reason: new Error("GPU residency execution was cancelled before upload."),
      }))),
      cancellationFailures: Object.freeze([]),
      cancelledUploadCount: validated.plan.uploads.length,
      cancelledUploadBytes: validated.plan.uploadBytes,
      cancellationBoundary: "before-resident-eviction" });
  }

  private result(validated: ValidatedGpuResidencyPlan, generation: number,
    outcomes: readonly PendingGpuUpload<THandle>[], commit: GpuResidencyExecutionResult["commit"],
    boundary: GpuResidencyExecutionResult["cancellationBoundary"],
    cancellationReason?: unknown): GpuResidencyExecutionResult {
    const cancelled = new Set(outcomes.filter(outcome => outcome.cancelled).map(outcome => outcome.id));
    const cancellationFailures = outcomes.filter(outcome => outcome.cancelled && outcome.error !== undefined
      && !hasCause(outcome.error, cancellationReason)).map(outcome => Object.freeze({
        id: outcome.id, reason: outcome.error,
      }));
    return Object.freeze({ generation, planId: validated.plan.id, commit,
      uploadFailures: uploadFailures(outcomes), cancellationFailures: Object.freeze(cancellationFailures),
      cancelledUploadCount: cancelled.size,
      cancelledUploadBytes: validated.plan.uploads.reduce((total, upload) =>
        total + (cancelled.has(upload.id) ? upload.byteLength : 0), 0),
      cancellationBoundary: boundary });
  }

  private applyBeforeUploadEvictions(validated: ValidatedGpuResidencyPlan): void {
    let first: unknown;
    for (const resident of validated.beforeUpload) {
      const current = this.requireResource(resident.id, resident.revision, resident.level);
      try { releaseOwned(this.state, current.handle); }
      catch (error) { first ??= error; }
      this.state.resources.delete(resident.id);
    }
    if (first) throw first;
  }

  private swapAccepted(plan: ResidencyFramePlan, accepted: readonly PendingGpuUpload<THandle>[]): void {
    const replacements = new Map<string, GpuResidentResource<THandle>>();
    for (const item of accepted) {
      const resource = item.resource!; const previous = this.state.resources.get(item.id);
      if (previous) replacements.set(item.id, previous);
      this.state.resources.set(item.id, resource);
    }
    let first: unknown;
    for (const eviction of plan.evictions) {
      if (eviction.phase !== "after-swap" || !accepted.some((item) => item.id === eviction.id)) continue;
      const previous = replacements.get(eviction.id);
      if (!previous) throw new GpuResidencyExecutorError("state-conflict", `Replacement resource disappeared: ${eviction.id}.`);
      try { releaseOwned(this.state, previous.handle); }
      catch (error) { first ??= error; }
    }
    if (first) throw first;
  }

  private requireResource(id: string, revision: number, level: number): GpuResidentResource<THandle> {
    const resource = this.state.resources.get(id);
    if (!resource || resource.revision !== revision || resource.level !== level) {
      throw new GpuResidencyExecutorError("state-conflict", `GPU resource state differs from the controller: ${id}.`);
    }
    return resource;
  }

  private synchronizeCommittedState(): void {
    const confirmed = this.state.controller.snapshot(), ids = new Set(confirmed.map(({ id }) => id));
    for (const state of confirmed) {
      const resource = this.requireResource(state.id, state.revision, state.level);
      if (resource.byteLength !== state.byteLength) throw new GpuResidencyExecutorError("state-conflict", `GPU resource byte count differs: ${state.id}.`);
      if (resource.lastUsedFrame !== state.lastUsedFrame) this.state.resources.set(state.id, Object.freeze({ ...state, handle: resource.handle }));
    }
    if ([...this.state.resources.keys()].some((id) => !ids.has(id))) throw new GpuResidencyExecutorError("state-conflict", "GPU resources differ from committed residency state.");
  }

  private terminate(message: string): void {
    if (this.terminal) return;
    this.terminal = true; this.generationValue += 1;
    this.active?.abort.abort(new GpuResidencyExecutorError("disposed", message));
    let first: unknown;
    for (const resource of this.state.resources.values()) try { releaseOwned(this.state, resource.handle); } catch (error) { first ??= error; }
    this.state.resources.clear();
    this.state.controller.resetResidency();
    if (first) throw first;
  }

  private failTerminal(cause: unknown): void {
    try { this.terminate("GPU residency transaction failed."); }
    catch { /* Preserve the transaction's primary failure. */ }
    if (cause instanceof GpuResidencyExecutorError) return;
  }
  private isCurrent(generation: number): boolean { return !this.terminal && generation === this.generationValue; }
  private assertLive(): void { if (this.terminal) throw this.disposedError(); }
  private disposedError(): GpuResidencyExecutorError { return new GpuResidencyExecutorError("disposed", "GPU residency executor is disposed."); }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function hasCause(error: unknown, expected: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current === expected) return true;
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
}
