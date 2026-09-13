export function gpuAbortReason(signal: AbortSignal, message: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Stops awaiting a driver promise promptly while always removing the abort listener. */
export async function abortableGpu<T>(promise: Promise<T>, signal: AbortSignal | undefined,
  message: string): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw gpuAbortReason(signal, message);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(gpuAbortReason(signal, message));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", cancel); }
}
