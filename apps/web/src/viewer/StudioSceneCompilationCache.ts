interface Pending<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  consumers: number;
}

/** One retained scene, shared in-flight work. Cancelling one waiter never
 * cancels another waiter; work with no consumers is terminated immediately. */
export class StudioSceneCompilationCache<T> {
  private cached: { key: string; value: T } | undefined;
  private readonly pending = new Map<string, Pending<T>>();
  private latestKey: string | undefined;

  get(key: string, signal: AbortSignal, compile: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    this.latestKey = key;
    if (this.cached?.key === key) return Promise.resolve(this.cached.value);
    let task = this.pending.get(key);
    if (!task || task.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return compile(controller.signal);
      }).then(value => {
        controller.signal.throwIfAborted();
        if (this.latestKey === key) this.cached = { key, value };
        return value;
      }).finally(() => {
        if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
      });
      task = { controller, promise, consumers: 0 };
      this.pending.set(key, task);
    }
    const shared = task;
    shared.consumers++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (value?: T, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        shared.consumers--;
        if (!shared.consumers && this.pending.get(key) === shared) shared.controller.abort();
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const abort = () => finish(undefined, signal.reason ?? new DOMException("Compilation cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      shared.promise.then(value => finish(value), error => finish(undefined, error));
      if (signal.aborted) abort();
    });
  }

  clear(): void {
    this.latestKey = undefined;
    this.cached = undefined;
    this.pending.forEach(task => task.controller.abort());
    this.pending.clear();
  }

  /** Once a runtime owns the decoded scene, its serialized transport can be retired. */
  release(value: T): void { if (this.cached?.value === value) this.cached = undefined; }
}
