/// <reference types="@webgpu/types" />
/**
 * C13：WebGPU device-lost 类型化恢复策略（Bevy 0.19 Render Recovery 同族思想）。
 *
 * 两件事，缺一不可：
 * 1. GPU 错误分型——把 `device.lost`（reason）与 `uncapturederror`（错误类）归一为
 *    机器可读码，并给出「是否值得会话内恢复」的判定，替代"任何丢失都判死刑"。
 * 2. 显式恢复状态机——healthy → degraded → recovering → healthy | lost，全程可查询、
 *    可审计；恢复耗尽才进入 lost 终态，干净地向上交给既有 WebGL 回退链。
 *
 * 与回退链的分层：本文件（+ DeviceSession 恢复增量）是 WebGPU **会话内**恢复层；
 * 桥层 `onRuntimeFailure → switchTo("webgl")` 是 **跨后端**回退层。不可恢复型
 * （validation / 恢复耗尽）按码向上抛，由回退链单次交接，两层职责不混。
 */

/** 机器可读错误码：`<来源>/<类别>`。来源=device-lost|uncaptured|recovery。 */
export type GpuErrorCode =
  | "device-lost/unknown"
  | "device-lost/destroyed"
  | "uncaptured/out-of-memory"
  | "uncaptured/validation"
  | "uncaptured/internal"
  | "recovery/exhausted"
  | "recovery/adapter-unavailable";

export interface GpuErrorClassification {
  readonly code: GpuErrorCode;
  /** true = 可在会话内恢复（重建设备 + 通知消费方重建资源）；false = 不可恢复。 */
  readonly recoverable: boolean;
  readonly message: string;
}

/** device.lost 分型。`destroyed` 是显式销毁（正常 dispose 或外部 destroy），不恢复。 */
export function classifyDeviceLost(reason: string | undefined, message: string): GpuErrorClassification {
  if (reason === "destroyed") {
    return { code: "device-lost/destroyed", recoverable: false,
      message: message || "GPU device was explicitly destroyed." };
  }
  // 规范只定义 "unknown" | "destroyed"；未知 reason 按 unknown 处理并保留原文。
  return { code: "device-lost/unknown", recoverable: true,
    message: message || reason || "GPU device was lost for an unknown reason." };
}

/** uncapturederror 分型。GPUError.name 在实现间存在 "out-of-memory" 与 "GPUOutOfMemoryError" 两种形态。 */
export function classifyUncapturedError(error: unknown): GpuErrorClassification {
  // 不依赖 @webgpu/types 的 GPUError 名义形状：测试 double 与未来实现只承诺 name/message 字段。
  const source = (error ?? {}) as { name?: unknown; message?: unknown };
  const name = typeof source.name === "string" ? source.name : "";
  const message = typeof source.message === "string" && source.message ? source.message : String(error ?? "unknown GPU error");
  if (/out-of-memory|outofmemory/i.test(name)) {
    return { code: "uncaptured/out-of-memory", recoverable: true, message };
  }
  if (/validation/i.test(name)) {
    // 验证错误是管线/代码缺陷：重建设备无益，degraded 暴露 + 沿用既有向上抛路径。
    return { code: "uncaptured/validation", recoverable: false, message };
  }
  if (/internal/i.test(name)) {
    return { code: "uncaptured/internal", recoverable: true, message };
  }
  // 无法归类的错误保守处理：不自动恢复（避免对未知缺陷盲目重建），但标记 degraded。
  return { code: "uncaptured/validation", recoverable: false, message };
}

/** 恢复状态机状态（session 级 DeviceState 由 "ready"/"disposed" 与此组合）。 */
export type DeviceRecoveryPhase = "healthy" | "degraded" | "recovering" | "lost";

export type DeviceRecoveryEventType = "classified" | "state" | "attempt" | "recovered" | "fatal";

export interface DeviceRecoveryEvent {
  readonly seq: number;
  readonly type: DeviceRecoveryEventType;
  readonly phase: DeviceRecoveryPhase;
  readonly code?: GpuErrorCode;
  readonly message?: string;
  readonly attempt?: number;
}

export interface DeviceRecoverySnapshot {
  readonly phase: DeviceRecoveryPhase;
  /** 已完成的会话内恢复次数（每次成功重建设备 +1）。 */
  readonly epoch: number;
  /** 当前恢复轮内已尝试次数。 */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastCode?: GpuErrorCode;
  readonly lastMessage?: string;
}

export interface DeviceRecoveryOptions {
  /** 恢复尝试上限（默认 3）。耗尽后进入 lost 终态并通知回退链。 */
  readonly maxAttempts?: number;
  /** 首次重试退避毫秒（默认 250），按 2 的幂增长。 */
  readonly backoffMs?: number;
  /** 退避上限毫秒（默认 4000）。 */
  readonly maxBackoffMs?: number;
  /** 单调时钟注入（测试）。 */
  readonly now?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 4000;

type RecoveryDecision = "recover" | "degrade" | "ignore";

interface TransitionGuard { readonly from: readonly DeviceRecoveryPhase[]; readonly to: DeviceRecoveryPhase }

const TRANSITIONS: Readonly<Record<"degrade" | "recovering" | "recovered" | "fatal", TransitionGuard>> = Object.freeze({
  degrade: { from: ["healthy"], to: "degraded" },
  recovering: { from: ["healthy", "degraded"], to: "recovering" },
  recovered: { from: ["recovering"], to: "healthy" },
  fatal: { from: ["healthy", "degraded", "recovering"], to: "lost" },
});

/** 显式有限状态机：非法迁移抛错而不是静默漂移；事件留痕供面板与审计读取。 */
export class DeviceRecoveryStateMachine {
  private phaseValue: DeviceRecoveryPhase = "healthy";
  private epochValue = 0;
  private attemptsValue = 0;
  private seqValue = 0;
  private readonly history: DeviceRecoveryEvent[] = [];
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: () => number;
  private lastCodeValue: GpuErrorCode | undefined;
  private lastMessageValue: string | undefined;

  constructor(options: DeviceRecoveryOptions = {}) {
    this.maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.backoffMs = positiveInt(options.backoffMs, DEFAULT_BACKOFF_MS, "backoffMs");
    this.maxBackoffMs = positiveInt(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, "maxBackoffMs");
    this.clock = options.now ?? (() => performance.now());
  }

  get phase(): DeviceRecoveryPhase { return this.phaseValue; }
  get maxRecoveryAttempts(): number { return this.maxAttempts; }
  get events(): readonly DeviceRecoveryEvent[] { return this.history.slice(); }
  get snapshot(): DeviceRecoverySnapshot {
    return Object.freeze({ phase: this.phaseValue, epoch: this.epochValue, attempts: this.attemptsValue,
      maxAttempts: this.maxAttempts, ...(this.lastCodeValue ? { lastCode: this.lastCodeValue } : {}),
      ...(this.lastMessageValue ? { lastMessage: this.lastMessageValue } : {}) });
  }

  /** 分型落地：返回会话应采取的动作并留痕。lost 终态后的重复事件一律 ignore。 */
  noteClassified(classification: GpuErrorClassification): RecoveryDecision {
    this.lastCodeValue = classification.code;
    this.lastMessageValue = classification.message;
    this.record({ type: "classified", code: classification.code, message: classification.message });
    if (this.phaseValue === "lost") return "ignore";
    if (classification.recoverable) return "recover";
    // 不可恢复分型里只有 validation 形（设备仍活）落到 degraded；destroyed 由 session 判定。
    if (classification.code === "uncaptured/validation") return "degrade";
    return "ignore";
  }

  /** 进入恢复：返回本次退避前不需要等待（首次立即尝试）。非法迁移抛错。 */
  beginRecovery(): void { this.transition("recovering"); this.attemptsValue = 0; }

  /** 第 attempt 次尝试失败：返回重试退避毫秒，或 exhausted 表示放弃。 */
  recordAttemptFailure(code: GpuErrorCode, message: string): { action: "retry"; backoffMs: number } | { action: "exhausted" } {
    this.attemptsValue++;
    this.lastCodeValue = code;
    this.lastMessageValue = message;
    this.record({ type: "attempt", code, message, attempt: this.attemptsValue });
    if (this.attemptsValue >= this.maxAttempts) return { action: "exhausted" };
    const exponent = this.attemptsValue - 1;
    const backoff = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** exponent);
    return { action: "retry", backoffMs: backoff };
  }

  /** 恢复成功：recovering → healthy，epoch+1。 */
  recordRecovered(): void {
    this.transition("recovered");
    this.epochValue++;
    this.attemptsValue = 0;
    this.record({ type: "recovered", message: `GPU session recovered (epoch ${this.epochValue}).` });
  }

  /** 终态：恢复耗尽或不可恢复丢失。重复 fatal 静默忽略（终态幂等）。 */
  declareFatal(code: GpuErrorCode, message: string): void {
    if (this.phaseValue === "lost") return;
    this.lastCodeValue = code;
    this.lastMessageValue = message;
    this.transition("fatal");
    this.record({ type: "fatal", code, message });
  }

  /** 不可恢复但设备仍活的分型（validation）：healthy → degraded。 */
  degrade(): void { this.transition("degrade"); }

  private transition(guard: keyof typeof TRANSITIONS): void {
    const rule = TRANSITIONS[guard];
    if (!rule.from.includes(this.phaseValue)) {
      throw new Error(`Illegal device recovery transition: ${this.phaseValue} --(${String(guard)})--> ${rule.to}.`);
    }
    this.phaseValue = rule.to;
    this.record({ type: "state", message: rule.to });
  }

  private record(event: Omit<DeviceRecoveryEvent, "seq" | "phase">): void {
    this.history.push(Object.freeze({ ...event, seq: ++this.seqValue, phase: this.phaseValue,
      ...(event.code ? { code: event.code } : {}) }));
    if (this.history.length > 64) this.history.shift();
  }
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Device recovery ${label} must be a positive safe integer.`);
  return value;
}
