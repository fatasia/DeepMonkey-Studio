import type { DeviceSession } from "./deviceSession.js";

export interface GpuTiming {
  readonly frame: number;
  readonly milliseconds: number;
  /** Coarse GPU spans; only populated when the full PBR output path writes all four queries. */
  readonly stages?: Readonly<{ shadowOpaqueMs: number; intermediateMs: number; outputMs: number }>;
}
interface Slot { readonly queries: GPUQuerySet; readonly resolve: GPUBuffer; readonly readback: GPUBuffer; busy: boolean }
export interface TimedFrame {
  readonly queries: GPUQuerySet;
  resolve(encoder: GPUCommandEncoder): void;
  /** 必须在 queue.submit 之后调用；普通帧不 await mapAsync。 */
  read(): void;
}

/** 仅诊断采样启用。最多 3 组读回资源，忙时跳过测量而不阻塞渲染。 */
export class GpuTimer {
  enabled = false;
  private readonly slots: Slot[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly values: GpuTiming[] = [];
  private readonly failures: string[] = [];

  constructor(private readonly session: DeviceSession,
    private readonly onTiming?: (timing: GpuTiming) => void) {}
  get supported(): boolean { return this.session.device.features.has("timestamp-query"); }
  get diagnostics(): readonly string[] { return this.failures.slice(); }

  begin(frame: number, detailed = false): TimedFrame | undefined {
    if (!this.enabled || !this.supported || this.session.state !== "ready") return undefined;
    let slot = this.slots.find((entry) => !entry.busy);
    if (!slot && this.slots.length < 3) { slot = this.createSlot(); this.slots.push(slot); }
    if (!slot) return undefined;
    slot.busy = true;
    const target = slot;
    return {
      queries: target.queries,
      resolve: (encoder) => {
        const bytes = detailed ? 32 : 16;
        encoder.resolveQuerySet(target.queries, 0, detailed ? 4 : 2, target.resolve, 0);
        encoder.copyBufferToBuffer(target.resolve, 0, target.readback, 0, bytes);
      },
      read: () => {
        const reading = this.read(target, frame, detailed);
        this.pending.add(reading);
        void reading.then(() => this.pending.delete(reading));
      },
    };
  }

  async collect(first: number, last: number): Promise<readonly GpuTiming[]> {
    await Promise.all(this.pending);
    return this.values.filter((value) => value.frame >= first && value.frame <= last);
  }

  private createSlot(): Slot {
    const device = this.session.device;
    return {
      queries: this.session.own(device.createQuerySet({ label: "Deep frame timing", type: "timestamp", count: 4 })),
      resolve: this.session.own(device.createBuffer({ label: "Deep timing resolve", size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })),
      readback: this.session.own(device.createBuffer({ label: "Deep timing readback", size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })), busy: false,
    };
  }

  private async read(slot: Slot, frame: number, detailed: boolean): Promise<void> {
    try {
      await slot.readback.mapAsync(GPUMapMode.READ);
      const times = new BigUint64Array(slot.readback.getMappedRange());
      const milliseconds = Number(times[1]! - times[0]!) / 1_000_000;
      if (Number.isFinite(milliseconds) && milliseconds >= 0) {
        const ordered = detailed && times.length >= 4 && times[0]! <= times[2]! && times[2]! <= times[3]! && times[3]! <= times[1]!;
        const stages = ordered ? Object.freeze({
          shadowOpaqueMs: Number(times[2]! - times[0]!) / 1_000_000,
          intermediateMs: Number(times[3]! - times[2]!) / 1_000_000,
          outputMs: Number(times[1]! - times[3]!) / 1_000_000,
        }) : undefined;
        const timing: GpuTiming = Object.freeze({ frame, milliseconds, ...(stages ? { stages } : {}) });
        this.values.push(timing); this.onTiming?.(timing);
      }
      if (this.values.length > 512) this.values.shift();
    } catch (error) {
      if (this.session.state === "ready") this.failures.push(String(error));
    } finally {
      if (slot.readback.mapState === "mapped") slot.readback.unmap();
      slot.busy = false;
    }
  }
}
