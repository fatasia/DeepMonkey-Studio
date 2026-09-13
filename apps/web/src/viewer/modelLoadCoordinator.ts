export class ModelLoadCoordinator<T> {
  private epoch = 0;
  private readonly pending = new Map<string, { epoch: number; promise: Promise<T> }>();

  get currentEpoch(): number {
    return this.epoch;
  }

  get hasPending(): boolean {
    return [...this.pending.values()].some(entry => entry.epoch === this.epoch);
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  run(key: string, epoch: number, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing?.epoch === epoch) return existing.promise;
    const promise = task().finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    });
    this.pending.set(key, { epoch, promise });
    return promise;
  }
}
