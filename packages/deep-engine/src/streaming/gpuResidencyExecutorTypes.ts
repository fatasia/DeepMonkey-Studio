import type { ResourceResidencyController } from "./residencyController.js";
import type { ResidentResourceState, ResidencyCommitResult, ResidencyFramePlan, StreamedResourceKind } from "./types.js";

export interface GpuResidencyUploadRequest {
  readonly id: string;
  readonly kind: StreamedResourceKind;
  readonly revision: number;
  readonly level: number;
  readonly expectedByteLength: number;
  readonly signal: AbortSignal;
}

export interface GpuResidencyUploadResult<THandle extends object> {
  /** Opaque resource returned by the uploader; only the executor can install it. */
  readonly handle: THandle;
  readonly byteLength: number;
}

export interface GpuResidencyUploader<THandle extends object> {
  upload(request: GpuResidencyUploadRequest): Promise<GpuResidencyUploadResult<THandle>>;
  /** Must synchronously invalidate the GPU resource and must not retain it. */
  release(handle: THandle): void;
}

export interface GpuResidencyExecutorOptions {
  readonly maxConcurrentUploads?: number;
  /** Pass GPUDevice.lost to make device loss terminal and release every owned handle. */
  readonly deviceLost?: PromiseLike<unknown>;
}

export interface GpuResidentResource<THandle extends object> extends ResidentResourceState {
  readonly handle: THandle;
}

export interface GpuResidencyUploadFailure {
  readonly id: string;
  readonly reason: unknown;
}

export interface GpuResidencyExecutionResult {
  readonly generation: number;
  readonly planId: number;
  readonly commit: ResidencyCommitResult;
  readonly uploadFailures: readonly GpuResidencyUploadFailure[];
  /** Unexpected failures encountered while rolling back cancelled work. */
  readonly cancellationFailures: readonly GpuResidencyUploadFailure[];
  /** Work skipped or rolled back after cancellation; submitted GPU commands may still finish. */
  readonly cancelledUploadCount: number;
  readonly cancelledUploadBytes: number;
  readonly cancellationBoundary:
    | "not-cancelled"
    | "before-resident-eviction"
    | "after-before-upload-eviction";
}

export type GpuResidencyExecutorErrorCode =
  | "busy" | "disposed" | "invalid-handle" | "invalid-options" | "invalid-plan" | "release-failed" | "state-conflict";

export class GpuResidencyExecutorError extends Error {
  constructor(readonly code: GpuResidencyExecutorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GpuResidencyExecutorError";
  }
}

export interface GpuResidencyExecutorState<THandle extends object> {
  readonly controller: ResourceResidencyController;
  readonly uploader: GpuResidencyUploader<THandle>;
  readonly resources: Map<string, GpuResidentResource<THandle>>;
  readonly ownedHandles: WeakSet<object>;
}

export interface PendingGpuUpload<THandle extends object> {
  readonly index: number;
  readonly id: string;
  readonly resource?: GpuResidentResource<THandle>;
  readonly error?: unknown;
  readonly cancelled?: true;
}

export interface ValidatedGpuResidencyPlan {
  readonly plan: ResidencyFramePlan;
  readonly beforeUpload: readonly ResidentResourceState[];
}
