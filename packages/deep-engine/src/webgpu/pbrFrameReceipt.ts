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
  /** 每个计划 pass 恰好一条样本;unmapped pass 显式 unavailable,禁止伪零值。 */
  readonly samples: readonly PbrPassChannelSample[];
}

export interface PbrPassTimingEntry {
  readonly passId: string;
  readonly durationMs: number;
}

/** 回执必须完整覆盖计划 pass:有实测给实测;未接/缺样本一律显式 unavailable。 */
export function createPbrFrameReceipt(frame: number, plan: PbrFrameExecutionPlan,
  timings: readonly PbrPassTimingEntry[], windowStartMs: number, windowEndMs: number): PbrFrameExecutionReceipt {
  assertWindowBounds(windowStartMs, windowEndMs);
  const timingByPass = new Map<string, number>();
  for (const entry of timings) {
    if (timingByPass.has(entry.passId)) throw new Error(`Duplicate timing entry for pass ${entry.passId}.`);
    if (!plan.passOrder.includes(entry.passId)) throw new Error(`Timing entry for pass ${entry.passId} is not in the plan.`);
    timingByPass.set(entry.passId, entry.durationMs);
  }
  const samples = plan.passOrder.map(passId => {
    const durationMs = timingByPass.get(passId);
    if (durationMs !== undefined) return createPbrPassTimingSample(passId, durationMs, windowStartMs, windowEndMs);
    const mapping = plan.passes.find(pass => pass.passId === passId)!.mapping;
    const reason = mapping.status === "unmapped" ? `pass 未纳入第一切片(${mapping.reason})` : "missing timing entry for mapped pass";
    return createPbrPassUnavailableSample(passId, reason, windowStartMs, windowEndMs);
  });
  return Object.freeze({ frame, passOrder: [...plan.passOrder], samples });
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
