import type { GpuResidencyExecutionResult } from "./gpuResidencyExecutorTypes.js";
import type { GpuResidencyExecutor } from "./gpuResidencyExecutor.js";
import type { ResourceResidencyController } from "./residencyController.js";
import type { ResidencyRequest } from "./types.js";

export interface ResidencyStreamFrameResult {
  readonly generation: number;
  readonly frame: number;
  readonly status: "applied" | "superseded" | "failed";
  readonly execution?: GpuResidencyExecutionResult;
  readonly error?: unknown;
}

interface StreamJob {
  frame: number;
  readonly requests: readonly ResidencyRequest[];
  readonly waiters: StreamWaiter[];
  superseded: boolean;
  cancelled: boolean;
  executionCancelled: boolean;
  cancelReason?: unknown;
}

interface StreamWaiter {
  readonly generation: number;
  readonly frame: number;
  readonly resolve: (result: ResidencyStreamFrameResult) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
  cancelled: boolean;
  settled: boolean;
}

/**
 * 将高频相机/LOD 请求收敛成 GPU 驻留事务。等价帧共享执行，不同请求仍按
 * latest-wins 取消旧批次；取消后等待上传器归还迟到句柄再规划最新帧。
 */
export class ResidencyStreamScheduler<THandle extends object> {
  private generationValue = 0;
  private latestFrame = -1;
  private pending: StreamJob | undefined;
  private active: StreamJob | undefined;
  private pumping = false;
  private closed = false;

  constructor(private readonly controller: ResourceResidencyController,
    private readonly executor: GpuResidencyExecutor<THandle>) {}

  get generation(): number { return this.generationValue; }
  get busy(): boolean { return this.pumping; }

  submit(frame: number, requests: readonly ResidencyRequest[],
    signal?: AbortSignal): Promise<ResidencyStreamFrameResult> {
    this.assertOpen();
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Streaming frame must be a non-negative integer.");
    if (frame < this.latestFrame) throw new Error("Streaming frame regressed.");
    if (!Array.isArray(requests)) throw new TypeError("Streaming requests must be an array.");
    if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError("Streaming signal is invalid.");
    const generation = ++this.generationValue, snapshot = snapshotRequests(requests);
    if (signal?.aborted) return Promise.resolve(Object.freeze({ generation, frame,
      status: "superseded", error: abortReason(signal) }));
    this.latestFrame = frame;
    let resolve!: StreamWaiter["resolve"];
    const promise = new Promise<ResidencyStreamFrameResult>(accept => { resolve = accept; });
    const waiter: StreamWaiter = { generation, frame, resolve,
      ...(signal ? { signal } : {}), cancelled: false, settled: false };
    let job: StreamJob;
    if (this.pending && equivalentRequests(this.pending.requests, snapshot)) {
      job = this.pending; job.frame = frame; job.waiters.push(waiter);
    } else {
      if (this.pending) {
        const superseded = this.pending; this.pending = undefined;
        this.finish(superseded, "superseded");
      }
      if (this.active && !this.active.superseded && !this.active.cancelled
        && equivalentRequests(this.active.requests, snapshot)) {
        job = this.active; job.frame = frame; job.waiters.push(waiter);
      } else {
        job = { frame, requests: snapshot, waiters: [waiter], superseded: false,
          cancelled: false, executionCancelled: false };
        this.pending = job;
        if (this.active && !this.active.superseded) {
          this.active.superseded = true;
          this.cancelExecution(this.active, new Error("GPU residency execution was superseded."));
        }
      }
    }
    this.attachAbort(job, waiter);
    void this.pump();
    return promise;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.generationValue++;
    if (this.pending) { this.finish(this.pending, "failed", undefined,
      new Error("Residency stream scheduler is disposed.")); this.pending = undefined; }
    if (this.active) this.active.superseded = true;
    this.executor.dispose();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.pending) {
        const job = this.pending; this.pending = undefined; this.active = job;
        try {
          if (job.cancelled) { this.finish(job, "superseded"); continue; }
          let completedFrame = -1, execution: GpuResidencyExecutionResult | undefined;
          do {
            const plannedFrame = job.frame;
            const plan = this.controller.planFrame(plannedFrame, job.requests);
            const current = await this.executor.execute(plan);
            execution ??= current; completedFrame = plannedFrame;
          } while (!job.superseded && !job.cancelled && job.frame > completedFrame);
          const cancellationError = executionCancellationError(execution);
          this.finish(job, job.superseded || job.cancelled ? "superseded" : "applied",
            execution, cancellationError ?? (job.cancelled ? job.cancelReason : undefined));
        } catch (error) {
          this.finish(job, job.superseded ? "superseded" : "failed", undefined, error);
        } finally {
          if (this.active === job) this.active = undefined;
        }
      }
    } finally { this.pumping = false; }
  }

  private finish(job: StreamJob, status: ResidencyStreamFrameResult["status"],
    execution?: GpuResidencyExecutionResult, error?: unknown): void {
    for (const waiter of job.waiters) {
      if (waiter.settled) continue;
      waiter.settled = true; this.detachAbort(waiter);
      waiter.resolve(Object.freeze({
      generation: waiter.generation, frame: waiter.frame, status,
      ...(execution ? { execution } : {}), ...(error === undefined ? {} : { error }),
      }));
    }
  }

  private attachAbort(job: StreamJob, waiter: StreamWaiter): void {
    if (!waiter.signal) return;
    const abort = () => this.cancelWaiter(job, waiter, abortReason(waiter.signal!));
    waiter.abort = abort; waiter.signal.addEventListener("abort", abort, { once: true });
  }

  private detachAbort(waiter: StreamWaiter): void {
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
  }

  private cancelWaiter(job: StreamJob, waiter: StreamWaiter, reason: unknown): void {
    if (waiter.settled) return;
    waiter.cancelled = true; this.detachAbort(waiter);
    if (job.waiters.some(candidate => !candidate.cancelled && !candidate.settled)) {
      waiter.settled = true;
      waiter.resolve(Object.freeze({ generation: waiter.generation, frame: waiter.frame,
        status: "superseded", error: reason }));
      return;
    }
    job.cancelled = true; job.cancelReason = reason;
    if (this.pending === job) {
      this.pending = undefined; this.finish(job, "superseded", undefined, reason);
    }
    if (this.active === job) this.cancelExecution(job, reason);
  }

  private cancelExecution(job: StreamJob, reason: unknown): void {
    if (job.executionCancelled) return;
    job.executionCancelled = true; this.executor.cancel(reason);
  }

  private assertOpen(): void {
    if (this.closed || this.executor.disposed) throw new Error("Residency stream scheduler is disposed.");
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Residency stream request was aborted.");
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function executionCancellationError(execution: GpuResidencyExecutionResult | undefined): unknown {
  const failures = execution?.cancellationFailures ?? [];
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0]!.reason;
  return new AggregateError(failures.map(failure => failure.reason),
    "Cancelled GPU residency work failed to clean up.");
}

function snapshotRequests(requests: readonly ResidencyRequest[]): readonly ResidencyRequest[] {
  return Object.freeze(requests.map(request => Object.freeze({ id: request.id,
    desiredLevel: request.desiredLevel, ...(request.priority === undefined ? {} : { priority: request.priority }),
    ...(request.required === undefined ? {} : { required: request.required }) })));
}

function equivalentRequests(left: readonly ResidencyRequest[], right: readonly ResidencyRequest[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map(request => [request.id, request] as const));
  if (rightById.size !== right.length) return false;
  return left.every((request) => {
    const candidate = rightById.get(request.id);
    return candidate !== undefined
      && candidate.desiredLevel === request.desiredLevel
      && (candidate.priority ?? 0) === (request.priority ?? 0)
      && (candidate.required ?? false) === (request.required ?? false);
  });
}
