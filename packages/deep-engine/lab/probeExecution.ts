/** Keep startup cancellable while awaiting GPU readback; the caller owns device cleanup. */
export function createProbeRunner(signal?: AbortSignal, progress?: (name: string) => void) {
  return async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        complete();
      };
      const cancel = (): void => finish(() => reject(new Error(`${name}: GPU verification cancelled or timed out.`)));
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        progress?.(name);
        if (signal?.aborted) { cancel(); return; }
        // Observe late rejection even after cancellation; synchronous abort wins over a returned result.
        Promise.resolve(run()).then(
          value => finish(() => resolve(value)),
          error => finish(() => reject(error)),
        );
      } catch (error) { finish(() => reject(error)); }
    });
  };
}
