/**
 * 批次 F 性能证据的标准化统计（五轴量化：CPU/GPU P50/P95/P99、长帧）。
 * 合同先于实现：percentile 的插值语义显式分档（nearest=保守档位值；linear=教材插值），
 * 各 runner 统一用本模块，杜绝口径漂移。全部 fail-closed。
 */

export type PercentileMode = "nearest" | "linear";

export interface LatencySummary {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** 超过 longFrameThresholdMs 的样本数与占比。 */
  readonly longFrameCount: number;
  readonly longFrameRatio: number;
}

export function percentile(values: readonly number[], p: number, mode: PercentileMode = "nearest"): number {
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new RangeError("percentile p must be finite within [0,100].");
  if (values.length === 0) throw new RangeError("percentile requires at least one sample.");
  const sorted = [...values].sort((a, b) => a - b);
  for (const value of sorted) {
    if (!Number.isFinite(value)) throw new RangeError("percentile samples must all be finite.");
  }
  if (mode === "nearest") {
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  }
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  const fraction = rank - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

export function summarizeLatencies(valuesMs: readonly number[], options: {
  readonly mode?: PercentileMode;
  readonly longFrameThresholdMs?: number;
} = {}): LatencySummary {
  if (valuesMs.length === 0) throw new RangeError("latency summary requires at least one sample.");
  const mode = options.mode ?? "nearest";
  const threshold = options.longFrameThresholdMs ?? 100;
  if (!Number.isFinite(threshold) || threshold <= 0) throw new RangeError("longFrameThresholdMs must be positive.");
  let sum = 0, longFrames = 0;
  for (const value of valuesMs) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("latency samples must be finite and nonnegative.");
    sum += value;
    if (value > threshold) longFrames += 1;
  }
  return Object.freeze({
    count: valuesMs.length,
    meanMs: sum / valuesMs.length,
    p50Ms: percentile(valuesMs, 50, mode),
    p95Ms: percentile(valuesMs, 95, mode),
    p99Ms: percentile(valuesMs, 99, mode),
    maxMs: percentile(valuesMs, 100, mode),
    longFrameCount: longFrames,
    longFrameRatio: longFrames / valuesMs.length,
  });
}
