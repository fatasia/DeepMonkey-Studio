import type { DeviceSession } from "./deviceSession.js";
import type { PbrPassTimingEntry } from "./pbrFrameReceipt.js";

export interface GpuTiming {
  readonly frame: number;
  readonly milliseconds: number;
  /** Coarse GPU spans; only populated when the full PBR output path writes all four queries. */
  readonly stages?: Readonly<{ shadowOpaqueMs: number; intermediateMs: number; outputMs: number }>;
  /** 逐 pass 实测(F1 perPass 模式);未括夹/序异常的 pass 被丢弃,不伪零。 */
  readonly passes?: readonly PbrPassTimingEntry[];
  /** 本帧请求计时的 pass 总数;与 passes 长度之差即被丢弃数。 */
  readonly requestedPassCount?: number;
}
interface Slot { readonly queries: GPUQuerySet; readonly resolve: GPUBuffer; readonly readback: GPUBuffer; busy: boolean }
export interface TimedFrame {
  readonly queries: GPUQuerySet;
  resolve(encoder: GPUCommandEncoder): void;
  /** 必须在 queue.submit 之后调用；普通帧不 await mapAsync。 */
  read(): void;
}

/** 逐 pass 计时槽容量(pass 对数上限);GI-FIN 登记后帧图最多 17 个 mapped pass
 * (15 既有 + sdf-gi-sky-trace/sdf-gi-probe-update),留 7 个余量。 */
const PER_PASS_MAX_PAIRS = 24;
/** 逐 pass 独立槽池;与帧级槽互不挤占,忙时跳过测量而不阻塞渲染。 */
const PER_PASS_MAX_SLOTS = 2;

/**
 * 单帧逐 pass GPU 计时作用域(F1)。每个计划 pass 用一对只写时间戳的空 compute
 * pass(marker)括夹;组内含多个 GPU pass 时天然覆盖整组。未知/重复 passId 的
 * marker 记诊断并跳过,绝不抛进渲染帧。resolve/read 语义与 TimedFrame 相同。
 */
export interface GpuPassTimingScope {
  readonly queries: GPUQuerySet;
  beginMarker(encoder: GPUCommandEncoder, passId: string): void;
  endMarker(encoder: GPUCommandEncoder, passId: string): void;
  resolve(encoder: GPUCommandEncoder): void;
  read(): void;
}

/** 仅诊断采样启用。最多 3 组读回资源，忙时跳过测量而不阻塞渲染。 */
export class GpuTimer {
  enabled = false;
  /** F1 逐 pass 计时开关(opt-in);关闭时 beginPasses 恒 undefined,帧级路径零改动。 */
  passTimingEnabled = false;
  private readonly slots: Slot[] = [];
  private readonly passSlots: Slot[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly values: GpuTiming[] = [];
  private readonly failures: string[] = [];

  constructor(private readonly session: DeviceSession,
    private readonly onTiming?: (timing: GpuTiming) => void) {}
  get supported(): boolean { return this.session.device.features.has("timestamp-query"); }
  get diagnostics(): readonly string[] { return this.failures.slice(); }
  /** 诊断上限,防止每帧 marker 跳过把列表撑成无界。 */
  private note(text: string): void { if (this.failures.length < 32) this.failures.push(text); }

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

  /**
   * F1 逐 pass 计时:每个 passId 分配一对查询索引(2i/2i+1),由调用方用 marker
   * 括夹真实 GPU pass 组。fail-closed 降级矩阵:未启用/设备不支持/会话未就绪/
   * 超容量/重复 passId/槽池耗尽 → undefined(调用方回退帧级计时)。
   */
  beginPasses(frame: number, passIds: readonly string[]): GpuPassTimingScope | undefined {
    if (!this.passTimingEnabled || !this.enabled || !this.supported || this.session.state !== "ready") return undefined;
    if (passIds.length === 0 || passIds.length > PER_PASS_MAX_PAIRS || new Set(passIds).size !== passIds.length) return undefined;
    let slot = this.passSlots.find((entry) => !entry.busy);
    if (!slot && this.passSlots.length < PER_PASS_MAX_SLOTS) { slot = this.createPassSlot(); this.passSlots.push(slot); }
    if (!slot) return undefined;
    slot.busy = true;
    const target = slot;
    const indexByPass = new Map(passIds.map((passId, index) => [passId, 2 * index]));
    const beginWritten = new Set<string>(), endWritten = new Set<string>();
    const bytes = passIds.length * 16;
    return {
      queries: target.queries,
      beginMarker: (encoder, passId) => {
        const index = indexByPass.get(passId);
        if (index === undefined || beginWritten.has(passId)) {
          this.note(`pass timing begin marker skipped for ${passId}`); return;
        }
        beginWritten.add(passId);
        emitMarker(encoder, target.queries, index, "begin", passId);
      },
      endMarker: (encoder, passId) => {
        const index = indexByPass.get(passId);
        if (index === undefined || endWritten.has(passId)) {
          this.note(`pass timing end marker skipped for ${passId}`); return;
        }
        endWritten.add(passId);
        emitMarker(encoder, target.queries, index + 1, "end", passId);
      },
      resolve: (encoder) => {
        encoder.resolveQuerySet(target.queries, 0, passIds.length * 2, target.resolve, 0);
        encoder.copyBufferToBuffer(target.resolve, 0, target.readback, 0, bytes);
      },
      read: () => {
        const timed = new Set<string>([...beginWritten].filter(passId => endWritten.has(passId)));
        const reading = this.readPasses(target, frame, passIds, timed);
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

  private createPassSlot(): Slot {
    const device = this.session.device;
    return {
      queries: this.session.own(device.createQuerySet({ label: "Deep pass timing", type: "timestamp", count: PER_PASS_MAX_PAIRS * 2 })),
      resolve: this.session.own(device.createBuffer({ label: "Deep pass timing resolve", size: PER_PASS_MAX_PAIRS * 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })),
      readback: this.session.own(device.createBuffer({ label: "Deep pass timing readback", size: PER_PASS_MAX_PAIRS * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })), busy: false,
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
      if (this.session.state === "ready") this.note(String(error));
    } finally {
      if (slot.readback.mapState === "mapped") slot.readback.unmap();
      slot.busy = false;
    }
  }
  /** 逐 pass 解析:只发布"起止 marker 齐全且时序有效"的 pass;全帧跨度 = 首起到末止(含未计时缝隙)。 */
  private async readPasses(slot: Slot, frame: number, passIds: readonly string[],
    timed: ReadonlySet<string>): Promise<void> {
    try {
      await slot.readback.mapAsync(GPUMapMode.READ);
      const times = new BigUint64Array(slot.readback.getMappedRange());
      const passes: PbrPassTimingEntry[] = [];
      let frameBegin: bigint | undefined, frameEnd: bigint | undefined;
      passIds.forEach((passId, index) => {
        if (!timed.has(passId)) return;
        const begin = times[2 * index]!, end = times[2 * index + 1]!;
        const durationMs = Number(end - begin) / 1_000_000;
        if (end < begin || !Number.isFinite(durationMs) || durationMs < 0) {
          this.note(`pass ${passId} timestamps dropped (unordered or invalid)`); return;
        }
        passes.push(Object.freeze({ passId, durationMs }));
        frameBegin ??= begin;
        frameEnd = end;
      });
      if (frameBegin !== undefined && frameEnd !== undefined) {
        const milliseconds = Number(frameEnd - frameBegin) / 1_000_000;
        if (Number.isFinite(milliseconds) && milliseconds >= 0) {
          const timing: GpuTiming = Object.freeze({ frame, milliseconds,
            passes: Object.freeze(passes), requestedPassCount: passIds.length });
          this.values.push(timing); this.onTiming?.(timing);
        }
      }
      if (this.values.length > 512) this.values.shift();
    } catch (error) {
      if (this.session.state === "ready") this.note(String(error));
    } finally {
      if (slot.readback.mapState === "mapped") slot.readback.unmap();
      slot.busy = false;
    }
  }
}

/** 空 compute pass 只写时间戳:WebGPU 在 pass 执行边界写查询,与是否 dispatch 无关。 */
function emitMarker(encoder: GPUCommandEncoder, queries: GPUQuerySet, index: number,
  kind: "begin" | "end", passId: string): void {
  const pass = encoder.beginComputePass({ label: `Deep pass timing ${kind} ${passId}`,
    timestampWrites: kind === "begin" ? { querySet: queries, beginningOfPassWriteIndex: index }
      : { querySet: queries, endOfPassWriteIndex: index } });
  pass.end();
}
