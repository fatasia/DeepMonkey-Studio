export interface GpuResidentLease<THandle extends object> {
  readonly resource: THandle;
  release(): void;
}

/**
 * Keeps an uploaded GPU resource alive while consumers hold leases. Retiring the
 * owner relinquishes the uploader's initial ownership after the final lease ends.
 */
export class GpuResidentOwner<THandle extends object> {
  private activeLeaseCountValue = 0;
  private retiredValue = false;
  private releaseStarted = false;

  constructor(private readonly resourceValue: THandle,
    private readonly releaseResource: (resource: THandle) => void) {}

  get activeLeaseCount(): number { return this.activeLeaseCountValue; }
  get retired(): boolean { return this.retiredValue; }

  acquire(): GpuResidentLease<THandle> {
    if (this.retiredValue) throw new Error("Cannot acquire a retired GPU resident resource.");
    this.activeLeaseCountValue++;
    let released = false;
    return Object.freeze({
      resource: this.resourceValue,
      release: () => {
        if (released) return;
        released = true;
        this.activeLeaseCountValue--;
        this.releaseIfUnowned();
      },
    });
  }

  retire(): void {
    if (this.retiredValue) return;
    this.retiredValue = true;
    this.releaseIfUnowned();
  }

  private releaseIfUnowned(): void {
    if (!this.retiredValue || this.activeLeaseCountValue !== 0 || this.releaseStarted) return;
    // Transition first: a throwing release callback must still consume ownership.
    this.releaseStarted = true;
    this.releaseResource(this.resourceValue);
  }
}
