export type EngineEventPriority = "discrete" | "continuous" | "background";

export interface EngineEvent<TPayload> {
  readonly id: string;
  readonly priority: EngineEventPriority;
  readonly payload: TPayload;
  /** Required for continuous events; the newest event for one key replaces the older pending value. */
  readonly coalesceKey?: string;
}

export interface QueuedEngineEvent<TPayload> extends EngineEvent<TPayload> {
  readonly sequence: number;
}

export type EngineEventEnqueueResult =
  | { readonly status: "queued" | "coalesced"; readonly pending: number }
  | { readonly status: "rejected"; readonly reason: "capacity" | "invalid-event"; readonly pending: number };

export interface PriorityEventQueueDiagnostics {
  readonly pending: number;
  readonly discrete: number;
  readonly continuous: number;
  readonly background: number;
  readonly coalesced: number;
  readonly rejected: number;
}

interface PendingEvent<TPayload> extends QueuedEngineEvent<TPayload> {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PRIORITY: Readonly<Record<EngineEventPriority, number>> = Object.freeze({
  discrete: 0,
  continuous: 1,
  background: 2,
});

/**
 * Bounded, framework-independent event admission for the engine command bus.
 * It stores data only: dispatch remains the responsibility of Behavior IR or SceneCommand hosts.
 */
export class PriorityEventQueue<TPayload> {
  private pending: PendingEvent<TPayload>[] = [];
  private readonly continuousByKey = new Map<string, number>();
  private nextSequence = 0;
  private coalesced = 0;
  private rejected = 0;

  constructor(private readonly capacity = 4_096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65_536) {
      throw new RangeError("Event queue capacity must be an integer from 1 through 65536.");
    }
  }

  enqueue(event: EngineEvent<TPayload>): EngineEventEnqueueResult {
    if (!validEvent(event)) return this.reject("invalid-event");
    if (event.priority === "continuous") {
      const index = this.continuousByKey.get(event.coalesceKey!);
      if (index !== undefined) {
        this.pending[index] = freezeEvent(event, this.takeSequence());
        this.coalesced += 1;
        return Object.freeze({ status: "coalesced", pending: this.pending.length });
      }
    }
    if (this.pending.length >= this.capacity) return this.reject("capacity");
    const index = this.pending.length;
    this.pending.push(freezeEvent(event, this.takeSequence()));
    if (event.priority === "continuous") this.continuousByKey.set(event.coalesceKey!, index);
    return Object.freeze({ status: "queued", pending: this.pending.length });
  }

  drain(limit = this.capacity): readonly QueuedEngineEvent<TPayload>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.capacity) {
      throw new RangeError(`Event drain limit must be an integer from 1 through ${this.capacity}.`);
    }
    const ordered = [...this.pending].sort((left, right) =>
      PRIORITY[left.priority] - PRIORITY[right.priority] || left.sequence - right.sequence);
    const selected = ordered.slice(0, limit);
    if (selected.length === this.pending.length) {
      this.pending = [];
    } else {
      const consumed = new Set(selected.map(event => event.sequence));
      this.pending = this.pending.filter(event => !consumed.has(event.sequence));
    }
    this.rebuildContinuousIndex();
    return Object.freeze(selected);
  }

  clear(): void {
    this.pending = [];
    this.continuousByKey.clear();
  }

  diagnostics(): PriorityEventQueueDiagnostics {
    const counts = { discrete: 0, continuous: 0, background: 0 };
    for (const event of this.pending) counts[event.priority] += 1;
    return Object.freeze({ pending: this.pending.length, ...counts,
      coalesced: this.coalesced, rejected: this.rejected });
  }

  private takeSequence(): number {
    if (!Number.isSafeInteger(this.nextSequence)) throw new RangeError("Event queue sequence exhausted.");
    return this.nextSequence++;
  }

  private reject(reason: "capacity" | "invalid-event"): EngineEventEnqueueResult {
    this.rejected += 1;
    return Object.freeze({ status: "rejected", reason, pending: this.pending.length });
  }

  private rebuildContinuousIndex(): void {
    this.continuousByKey.clear();
    this.pending.forEach((event, index) => {
      if (event.priority === "continuous") this.continuousByKey.set(event.coalesceKey!, index);
    });
  }
}

function validEvent<TPayload>(event: EngineEvent<TPayload>): boolean {
  if (!event || typeof event !== "object" || !ID.test(event.id)
    || !Object.hasOwn(PRIORITY, event.priority)) return false;
  if (event.priority === "continuous") return typeof event.coalesceKey === "string" && ID.test(event.coalesceKey);
  return event.coalesceKey === undefined;
}

function freezeEvent<TPayload>(event: EngineEvent<TPayload>, sequence: number): PendingEvent<TPayload> {
  return Object.freeze({ id: event.id, priority: event.priority, payload: event.payload, sequence,
    ...(event.coalesceKey === undefined ? {} : { coalesceKey: event.coalesceKey }) });
}
