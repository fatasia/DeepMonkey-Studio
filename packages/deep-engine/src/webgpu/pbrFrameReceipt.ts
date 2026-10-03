import { BENCHMARK_SAMPLE_SCHEMA_VERSION, createSampleWindow, type ChannelSample, type SampleWindow } from "../benchmarkSampleSchema.js";
import type { PbrFrameExecutionPlan } from "./pbrFramePlanExecutor.js";

/** A03 ChannelSample 语义的单 pass 耗时通道;channel 取合法枚举,pass 专属命名走 passChannel。 */
export interface PbrPassChannelSample extends ChannelSample {
  readonly passChannel: `gpu-timestamp.pass.${string}`;
}

export function pbrPassChannelName(passId: string): `gpu-timestamp.pass.${string}` {
  return `gpu-timestamp.pass.${passId}`;
}

function assertWindowBounds(windowStartMs: number, windowEndMs: number): void {
  if (![windowStartMs, windowEndMs].every(Number.isFinite) || windowEndMs <= windowStartMs) {
    throw new Error("Pass sample window bounds must be finite with end after start.");
  }
}

export function createPbrPassTimingSample(passId: string, durationMs: number, windowStartMs: number, windowEndMs: number): PbrPassChannelSample {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`Pass ${passId} timing must be finite and non-negative.`);
  assertWindowBounds(windowStartMs, windowEndMs);
  return Object.freeze({ channel: "gpu-timestamp", clockId: "gpu-timestamp", passChannel: pbrPassChannelName(passId),
    samplesMs: Object.freeze([durationMs]), sampleCount: 1, windowStartMs, windowEndMs, availability: "measured" });
}

export function createPbrPassUnavailableSample(passId: string, reason: string, windowStartMs: number, windowEndMs: number): PbrPassChannelSample {
  if (!reason.trim()) throw new Error(`Pass ${passId} unavailable sample requires a reason.`);
  assertWindowBounds(windowStartMs, windowEndMs);
  return Object.freeze({ channel: "gpu-timestamp", clockId: "gpu-timestamp", passChannel: pbrPassChannelName(passId),
    samplesMs: Object.freeze([]), sampleCount: 0, windowStartMs, windowEndMs,
    availability: "unavailable", unavailableReason: reason });
}

export interface PbrFrameExecutionReceipt {
  readonly frame: number;
  readonly passOrder: readonly string[];
  /** Mapped passes observed on this frame's encode path, never inferred from graph membership. */
  readonly executedMappedPassIds: readonly string[];
  /** Plan slots still without a validated production executor. */
  readonly unmappedPassIds: readonly string[];
  /** 每个计划 pass 恰好一条样本;unmapped pass 显式 unavailable,禁止伪零值。 */
  readonly samples: readonly PbrPassChannelSample[];
  /**
   * F1 逐 pass 实测毫秒数组(passId→ms),仅含 measured 且 executed 的样本,按计划
   * passOrder 排列;与 samples 的 measured 子集严格一致。空数组 = 本回执无逐 pass
   * 实测(时间戳未启用/槽忙/读回未完成),不伪零。
   */
  readonly perPass: readonly PbrPassTimingEntry[];
}

export interface PbrPassTimingEntry {
  readonly passId: string;
  readonly durationMs: number;
}

/**
 * 单帧逐 pass GPU 计时(F1)。GPU 读回滞后于渲染 1-2 帧:挂在 FrameMetrics 上时
 * `frame` 字段标识实测帧(非收到该数据的帧),消费方不得把它当作当前帧。
 * availability=unavailable 时只给原因,不产伪零样本。
 */
export interface PbrFramePassTimings {
  readonly frame: number;
  readonly availability: "measured" | "unavailable";
  readonly unavailableReason?: string;
  /** GPU 全帧跨度(首个 begin marker → 最后一个 end marker,含未计时缝隙)。 */
  readonly milliseconds?: number;
  /** 实测 pass(passId→ms),按帧图计划顺序排列。 */
  readonly passes?: readonly PbrPassTimingEntry[];
  /** 本帧请求计时的 pass 数;measuredPassCount < requestedPassCount 即有样本被丢弃。 */
  readonly requestedPassCount?: number;
  readonly measuredPassCount?: number;
}

export function pbrFramePassTimingsUnavailable(frame: number, reason: string): PbrFramePassTimings {
  if (!reason.trim()) throw new Error("Pass timings unavailable state requires a reason.");
  return Object.freeze({ frame, availability: "unavailable", unavailableReason: reason });
}

/**
 * 已映射 pass 缺 timing 样本时的 unavailable 原因口径:
 * - "missing"(缺省,历史行为):确实缺样本,调用方无法解释;
 * - "deferred-to-gpu-pass-timings":计时已请求,毫秒经 gpuPassTimings 通道滞后 1-2 帧异步发布;
 * - "not-requested":本帧未请求逐 pass 计时(常规回执帧)。
 */
export type PbrReceiptTimingAvailability = "missing" | "deferred-to-gpu-pass-timings" | "not-requested";

const TIMING_AVAILABILITY_REASONS: Readonly<Record<PbrReceiptTimingAvailability, string>> = Object.freeze({
  "missing": "missing timing entry for mapped pass",
  "deferred-to-gpu-pass-timings": "pass timing published asynchronously via gpuPassTimings",
  "not-requested": "timing not requested on this frame",
});

/** 回执必须完整覆盖计划 pass:有实测给实测;未接/缺样本一律显式 unavailable。 */
export function createPbrFrameReceipt(frame: number, plan: PbrFrameExecutionPlan,
  timings: readonly PbrPassTimingEntry[], windowStartMs: number, windowEndMs: number,
  executedPassIds: ReadonlySet<string> = new Set(),
  timingAvailability: PbrReceiptTimingAvailability = "missing"): PbrFrameExecutionReceipt {
  assertWindowBounds(windowStartMs, windowEndMs);
  const timingByPass = new Map<string, number>();
  for (const entry of timings) {
    if (timingByPass.has(entry.passId)) throw new Error(`Duplicate timing entry for pass ${entry.passId}.`);
    if (!plan.passOrder.includes(entry.passId)) throw new Error(`Timing entry for pass ${entry.passId} is not in the plan.`);
    timingByPass.set(entry.passId, entry.durationMs);
  }
  const mapped = new Set(plan.mappedPassIds);
  for (const passId of executedPassIds) {
    if (!mapped.has(passId)) throw new Error(`Executed pass ${passId} is not mapped in this frame plan.`);
  }
  const samples = plan.passOrder.map(passId => {
    const durationMs = timingByPass.get(passId);
    if (durationMs !== undefined && !executedPassIds.has(passId) && executedPassIds.size > 0) {
      throw new Error(`Pass ${passId} has a timing but was not encoded.`);
    }
    if (durationMs !== undefined) return createPbrPassTimingSample(passId, durationMs, windowStartMs, windowEndMs);
    const mapping = plan.passes.find(pass => pass.passId === passId)!.mapping;
    const reason = mapping.status === "unmapped" ? `pass 未纳入第一切片(${mapping.reason})`
      : executedPassIds.size > 0 && !executedPassIds.has(passId) ? "pass not encoded on this frame"
        : TIMING_AVAILABILITY_REASONS[timingAvailability];
    return createPbrPassUnavailableSample(passId, reason, windowStartMs, windowEndMs);
  });
  // perPass 只收实测样本;给了 executedPassIds 时再与之取交(未编码 pass 的 timing 已在上面抛错)。
  // executedPassIds 缺省(空集)= 调用方未提供编码集合,此时按计划顺序收全部实测。
  const executedFilter = executedPassIds.size > 0 ? executedPassIds : undefined;
  const perPass = plan.passOrder
    .filter(passId => timingByPass.has(passId) && (executedFilter?.has(passId) ?? true))
    .map(passId => Object.freeze({ passId, durationMs: timingByPass.get(passId)! }));
  return Object.freeze({ frame, passOrder: [...plan.passOrder],
    executedMappedPassIds: [...executedPassIds].sort(), unmappedPassIds: [...plan.unmappedPassIds],
    samples, perPass });
}

/** 聚合为 A03 SampleWindow:窗口 schema 禁止重复通道,全部 pass 样本合并进唯一 gpu-timestamp 通道。 */
export function pbrReceiptSampleWindow(receipt: PbrFrameExecutionReceipt, runId: string): SampleWindow {
  const windowStartMs = Math.min(...receipt.samples.map(sample => sample.windowStartMs));
  const windowEndMs = Math.max(...receipt.samples.map(sample => sample.windowEndMs));
  const measured = receipt.samples.filter(sample => sample.availability === "measured");
  const channel: ChannelSample = measured.length
    ? { channel: "gpu-timestamp", clockId: "gpu-timestamp", samplesMs: measured.flatMap(sample => [...sample.samplesMs]),
      sampleCount: measured.reduce((total, sample) => total + sample.sampleCount, 0), windowStartMs, windowEndMs, availability: "measured" }
    : { channel: "gpu-timestamp", clockId: "gpu-timestamp", samplesMs: [], sampleCount: 0, windowStartMs, windowEndMs,
      availability: "unavailable",
      unavailableReason: receipt.samples.map(sample => `${sample.passChannel}: ${sample.unavailableReason ?? "unknown"}`).join("; ") };
  return createSampleWindow({ schema: "deep-engine.benchmark-sample-window", schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
    runId, clockId: "gpu-timestamp", windowStartMs, windowEndMs, channels: [Object.freeze(channel)] });
}
