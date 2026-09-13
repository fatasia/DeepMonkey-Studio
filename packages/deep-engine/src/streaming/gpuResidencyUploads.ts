import type { ResidencyFramePlan, ResidencyUpload } from "./types.js";
import type {
  GpuResidencyExecutorState, GpuResidencyUploadFailure, PendingGpuUpload,
} from "./gpuResidencyExecutorTypes.js";
import { GpuResidencyExecutorError } from "./gpuResidencyExecutorTypes.js";
import { assertResourceHandle } from "./gpuResidencyExecutorValidation.js";

export async function uploadResidencyCandidates<THandle extends object>(state: GpuResidencyExecutorState<THandle>, plan: ResidencyFramePlan,
  signal: AbortSignal, concurrency: number, isCurrent: () => boolean): Promise<readonly PendingGpuUpload<THandle>[]> {
  const results: Array<PendingGpuUpload<THandle> | undefined> = new Array(plan.uploads.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted && cursor < plan.uploads.length) {
      const index = cursor, upload = plan.uploads[cursor++]!;
      results[index] = await uploadOne(state, upload, index, plan.frame, signal, isCurrent);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.uploads.length) }, worker));
  for (let index = 0; index < plan.uploads.length; index += 1) {
    results[index] ??= Object.freeze({ index, id: plan.uploads[index]!.id,
      error: abortReason(signal), cancelled: true });
  }
  return Object.freeze(results as PendingGpuUpload<THandle>[]);
}

export function uploadFailures<THandle extends object>(outcomes: readonly PendingGpuUpload<THandle>[]): readonly GpuResidencyUploadFailure[] {
  return Object.freeze(outcomes.filter((item) => item.error !== undefined)
    .map((item) => Object.freeze({ id: item.id, reason: item.error })));
}

export function releasePending<THandle extends object>(state: GpuResidencyExecutorState<THandle>, outcomes: readonly PendingGpuUpload<THandle>[]): void {
  let first: unknown;
  for (const outcome of outcomes) {
    if (!outcome.resource) continue;
    try { releaseOwned(state, outcome.resource.handle); }
    catch (error) { first ??= error; }
  }
  if (first) throw first;
}

export function releaseOwned<THandle extends object>(state: GpuResidencyExecutorState<THandle>, handle: THandle): void {
  try { state.uploader.release(handle); }
  catch (cause) { throw new GpuResidencyExecutorError("release-failed", "GPU uploader failed to release an owned resource.", { cause }); }
  finally { state.ownedHandles.delete(handle); }
}

async function uploadOne<THandle extends object>(state: GpuResidencyExecutorState<THandle>, upload: ResidencyUpload, index: number,
  frame: number, signal: AbortSignal, isCurrent: () => boolean): Promise<PendingGpuUpload<THandle>> {
  try {
    const result = await state.uploader.upload({ id: upload.id, kind: upload.kind,
      revision: upload.toRevision, level: upload.toLevel,
      expectedByteLength: upload.byteLength, signal });
    assertResourceHandle(result?.handle);
    if (state.ownedHandles.has(result.handle)) throw new GpuResidencyExecutorError("invalid-handle", "GPU uploader reused an owned resource handle.");
    if (!Number.isSafeInteger(result.byteLength) || result.byteLength !== upload.byteLength) {
      releaseUnclaimed(state, result.handle);
      throw new GpuResidencyExecutorError("invalid-plan", `GPU upload byte count differs from plan: ${upload.id}.`);
    }
    if (signal.aborted || !isCurrent()) {
      releaseUnclaimed(state, result.handle);
      return Object.freeze({ index, id: upload.id, error: abortReason(signal), cancelled: true });
    }
    state.ownedHandles.add(result.handle);
    const resource = Object.freeze({ id: upload.id, kind: upload.kind,
      revision: upload.toRevision, level: upload.toLevel,
      byteLength: result.byteLength, lastUsedFrame: frame, handle: result.handle });
    return Object.freeze({ index, id: upload.id, resource });
  } catch (error) {
    if (error instanceof GpuResidencyExecutorError && error.code === "release-failed") throw error;
    return Object.freeze({ index, id: upload.id, error,
      ...(signal.aborted || !isCurrent() ? { cancelled: true as const } : {}) });
  }
}

function releaseUnclaimed<THandle extends object>(state: GpuResidencyExecutorState<THandle>, handle: THandle): void {
  try { state.uploader.release(handle); }
  catch (cause) { throw new GpuResidencyExecutorError("release-failed", "GPU uploader failed to release a rejected resource.", { cause }); }
}
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new GpuResidencyExecutorError("disposed", "GPU residency upload was cancelled.");
}
