/** 单个异步候选的取消生命周期；GPU 错误等待不持有发布权。 */
export class PacketValidatedPublication {
  private pending: { cancel(): void } | undefined;

  cancel(): void {
    const pending = this.pending; this.pending = undefined; pending?.cancel();
  }

  async run<T>(checked: Promise<void>, signal: AbortSignal | undefined,
    publish: () => T, discard: () => void, current: () => boolean, cancellationError: () => Error): Promise<T> {
    let cancelled = false;
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const request = { cancel: () => {
      if (cancelled) return;
      cancelled = true;
      const error = cancellationError();
      try { discard(); }
      catch (cleanup) { rejectCancellation(new AggregateError([error, cleanup], "Packet cancellation cleanup failed.")); return; }
      rejectCancellation(error);
    } };
    this.pending = request;
    signal?.addEventListener("abort", request.cancel, { once: true });
    if (signal?.aborted || !current()) request.cancel();
    try {
      await Promise.race([checked, cancellation]);
      if (cancelled || !current()) throw cancellationError();
      return publish();
    } finally {
      signal?.removeEventListener("abort", request.cancel);
      if (this.pending === request) this.pending = undefined;
      discard();
    }
  }
}
