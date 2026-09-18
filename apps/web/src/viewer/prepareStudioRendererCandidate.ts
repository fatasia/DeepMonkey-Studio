export type StudioRendererPreparation<T> =
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "cancelled"; readonly error?: Error }
  | { readonly status: "failed"; readonly error: Error };

export interface StudioRendererCandidateOptions<M, T> {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly loadModule: () => Promise<M>;
  readonly create: (module: M, signal: AbortSignal) => Promise<T>;
  readonly prepare?: (value: T, signal: AbortSignal) => Promise<void>;
  readonly dispose: (value: T) => void;
  readonly removeCanvas: () => void;
  readonly onLateCleanupError?: (error: Error) => void;
}

/** 候选准备拥有独立截止时间；只有 ready 才把资源所有权交给展示层。 */
export function prepareStudioRendererCandidate<M, T>(
  options: StudioRendererCandidateOptions<M, T>,
): Promise<StudioRendererPreparation<T>> {
  const { signal, timeoutMs } = options;
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let candidate: { value: T } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanCandidate = (): Error | undefined => {
      const owned = candidate;
      candidate = undefined;
      if (!owned) return undefined;
      try { options.dispose(owned.value); } catch (reason) { return asError(reason); }
      return undefined;
    };
    const finish = (result: StudioRendererPreparation<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (result.status !== "ready") {
        controller.abort(result.error ?? new DOMException("Renderer preparation cancelled", "AbortError"));
        const errors: Error[] = [];
        const disposeError = cleanCandidate();
        if (disposeError) errors.push(disposeError);
        try { options.removeCanvas(); } catch (reason) { errors.push(asError(reason)); }
        if (errors.length) {
          if (result.error) errors.unshift(result.error);
          result = { status: result.status, error: new AggregateError(errors, "Renderer candidate cleanup failed.") };
        }
      } else candidate = undefined;
      resolve(result);
    };
    const cancel = (): void => finish({ status: "cancelled" });
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      finish({ status: "failed", error: new RangeError("Renderer preparation timeout must be from 1 through 300000 ms.") });
      return;
    }
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => finish({
      status: "failed", error: new Error(`Renderer preparation timed out after ${timeoutMs} ms.`),
    }), timeoutMs);

    void (async () => {
      try {
        const module = await options.loadModule();
        if (settled) return;
        const value = await options.create(module, controller.signal);
        candidate = { value };
        if (settled) {
          const cleanupError = cleanCandidate();
          if (cleanupError) options.onLateCleanupError?.(cleanupError);
          return;
        }
        await options.prepare?.(value, controller.signal);
        if (!settled) finish({ status: "ready", value });
      } catch (reason) {
        if (!settled) finish({ status: "failed", error: asError(reason) });
      }
    })();
  });
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
