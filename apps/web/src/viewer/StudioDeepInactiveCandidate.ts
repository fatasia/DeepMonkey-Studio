/** One bounded inactive owner, measured after trimming idle targets. */
export const STUDIO_DEEP_INACTIVE_MAX_BYTES = 384 * 1024 * 1024;
const MAX_IDLE_MS = 30_000;

/** One inactive renderer per bridge; active rendering and input subscriptions end on parking. */
export class StudioDeepInactiveCandidate<T> {
  private value: { candidate: T; valid: () => boolean; dispose: () => void; unsubscribe: (() => void) | undefined } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private bytes = 0;

  constructor(private readonly maxIdleMs: number | null = MAX_IDLE_MS) {}

  get available(): boolean { this.check(); return this.value !== undefined; }
  get retainedBytes(): number { this.check(); return this.bytes; }

  retain(candidate: T, bytes: number, valid: () => boolean, dispose: () => void,
    subscribe: (invalidate: () => void) => () => void): boolean {
    this.clear();
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > STUDIO_DEEP_INACTIVE_MAX_BYTES || !valid()) return false;
    const value = { candidate, valid, dispose, unsubscribe: undefined as (() => void) | undefined };
    this.value = value;
    this.bytes = bytes;
    if (this.maxIdleMs !== null) this.timer = setTimeout(() => this.clear(), this.maxIdleMs);
    value.unsubscribe = subscribe(() => { if (this.value === value) this.clear(); });
    return true;
  }
  check(): void {
    if (!this.value) return;
    let valid = false;
    try { valid = this.value.valid(); } catch { /* Unreadable author state cannot retain a GPU owner. */ }
    if (!valid) this.clear();
  }
  take(): T | undefined {
    this.check();
    const value = this.value; this.value = undefined;
    this.bytes = 0;
    clearTimeout(this.timer); this.timer = undefined; value?.unsubscribe?.();
    return value?.candidate;
  }
  clear(): void {
    const value = this.value; this.value = undefined;
    this.bytes = 0;
    clearTimeout(this.timer); this.timer = undefined;
    try { value?.unsubscribe?.(); } finally { value?.dispose(); }
  }
}
