export type DashboardRefreshResult = "ready" | "error" | "cancelled";

interface PendingRefresh {
  promise: Promise<DashboardRefreshResult>;
  resolve(result: DashboardRefreshResult): void;
}

/** 每个产品串行查询；写后请求合并到下一次新读取，不能拿写前的在飞结果交差。 */
export class DashboardDatasetRefreshQueue {
  private active = true;
  private running = new Map<string, Promise<DashboardRefreshResult>>();
  private queued = new Map<string, PendingRefresh>();
  constructor(private readonly query: (key: string) => Promise<void>) {}

  request(key: string, fresh = false): Promise<DashboardRefreshResult> {
    if (!this.active) return Promise.resolve("cancelled");
    const running = this.running.get(key);
    if (!running) return this.start(key);
    if (!fresh) return running;
    let next = this.queued.get(key);
    if (!next) {
      let resolve!: PendingRefresh["resolve"];
      const promise = new Promise<DashboardRefreshResult>(done => { resolve = done; });
      next = { promise, resolve };
      this.queued.set(key, next);
    }
    return next.promise;
  }

  private start(key: string): Promise<DashboardRefreshResult> {
    const promise = Promise.resolve().then(() => {
      if (this.active) return this.query(key);
    }).then<DashboardRefreshResult, DashboardRefreshResult>(() => this.active ? "ready" : "cancelled", () => this.active ? "error" : "cancelled");
    this.running.set(key, promise);
    void promise.then(() => {
      this.running.delete(key);
      const next = this.queued.get(key);
      this.queued.delete(key);
      if (next) {
        if (this.active) void this.start(key).then(next.resolve);
        else next.resolve("cancelled");
      }
    });
    return promise;
  }

  dispose() {
    this.active = false;
    for (const next of this.queued.values()) next.resolve("cancelled");
    this.queued.clear();
  }
}
