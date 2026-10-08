interface Submission<Backend> {
  readonly backend: Backend;
  readonly draw: () => boolean;
  readonly completion: () => Promise<void> | undefined;
}

/** Camera, author changes and temporal settling share actual GPU completion tickets. */
export class StudioDeepFrameQueue<Backend> {
  private backend: Backend | undefined;
  private epoch = 0;
  private readonly tickets = new Set<object>();
  private latest: Submission<Backend> | undefined;
  private submitted = 0;
  private coalesced = 0;
  private maximum = 0;

  constructor(private readonly limit: number, private readonly isCurrent: (backend: Backend) => boolean,
    private readonly onError: (reason: unknown) => void, private readonly onChange: () => void) {}

  get stats() { return { inFlight: this.tickets.size, maxInFlight: this.maximum,
    submitted: this.submitted, coalesced: this.coalesced, pendingLatest: this.latest !== undefined }; }

  reset(): void {
    this.epoch++; this.backend = undefined; this.tickets.clear(); this.latest = undefined;
    this.submitted = 0; this.coalesced = 0; this.maximum = 0; this.onChange();
  }

  submit(backend: Backend, draw: () => boolean, completion: () => Promise<void> | undefined,
    latest = true): boolean {
    if (!this.isCurrent(backend)) return false;
    if (this.backend !== backend) { this.reset(); this.backend = backend; }
    // 收敛重绘只占空队列；留第二槽给交互首绘，保留原单帧 settle 背压。
    if (!latest && this.tickets.size > 0) return false;
    if (this.tickets.size >= this.limit) {
      if (latest) { this.latest = { backend, draw, completion }; this.coalesced++; this.onChange(); }
      return false;
    }
    if (latest) this.latest = undefined;
    const ticket = {}, epoch = this.epoch;
    this.tickets.add(ticket);
    let fence: Promise<void> | undefined;
    try {
      if (!draw()) { this.tickets.delete(ticket); this.onChange(); return false; }
      this.submitted++; this.maximum = Math.max(this.maximum, this.tickets.size);
      fence = completion(); this.onChange();
    } catch (reason) { this.tickets.delete(ticket); this.onChange(); throw reason; }
    const completed = () => {
      if (epoch !== this.epoch || !this.isCurrent(backend)) return;
      this.tickets.delete(ticket); this.onChange();
      const pending = this.latest;
      if (pending) {
        this.latest = undefined;
        try { this.submit(pending.backend, pending.draw, pending.completion); }
        catch (reason) { this.reset(); this.onError(reason); }
      }
    };
    if (!fence) completed();
    else void Promise.resolve(fence).then(completed).catch(reason => {
      if (epoch !== this.epoch || !this.isCurrent(backend)) return;
      this.reset(); this.onError(reason);
    });
    return true;
  }
}
