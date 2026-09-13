import { ShaderCacheAbortError } from "./types.js";

interface SharedEntry<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new ShaderCacheAbortError();
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export class SharedOperations<T> {
  private readonly entries = new Map<string, SharedEntry<T>>();

  get size(): number { return this.entries.size; }

  run(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, promise: Promise.resolve(undefined as T), waiters: 0, settled: false };
      const promise = Promise.resolve().then(() => start(controller.signal));
      entry = { ...entry, promise };
      this.entries.set(key, entry);
      void promise.finally(() => {
        entry!.settled = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }).catch(() => undefined);
    }
    entry.waiters += 1;
    return abortable(entry.promise, signal).finally(() => {
      entry!.waiters -= 1;
      if (entry!.waiters === 0 && !entry!.settled) entry!.controller.abort(new ShaderCacheAbortError());
    });
  }

  abortAll(reason = new ShaderCacheAbortError()): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.controller.abort(reason);
  }
}

export interface CombinedAbort {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  dispose(): void;
}

export function combinedAbort(signal: AbortSignal | undefined, timeoutMs: number): CombinedAbort {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new RangeError("Shader prewarm timeout must be finite and from 1 through 300000 ms.");
  }
  const controller = new AbortController();
  let timeout = false;
  const externalAbort = (): void => controller.abort(signal?.reason ?? new ShaderCacheAbortError());
  if (signal?.aborted) externalAbort();
  else signal?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new ShaderCacheAbortError("Shader cache prewarm timed out."));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", externalAbort);
    },
  };
}
