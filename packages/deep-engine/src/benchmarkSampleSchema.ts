/** DE26/A03 · 统一 CPU/GPU/呈现采样合同 v1:跨宿主同一时间边界与采样记录形状;
 *  不可用必须显式 unavailable + 原因,禁止伪零值;样本数与原始样本一一对应。 */

export const BENCHMARK_SAMPLE_SCHEMA_VERSION = 1 as const;

/** 全部采样共用单调毫秒时间基;clockId 标识来源时钟,跨时钟比较由消费方拒绝。 */
export type SampleClockId = "performance-now" | "gpu-timestamp" | "frame-callback" | "host-monotonic";

export type SampleChannel =
  | "authoring-bridge"
  | "scene-update"
  | "upload"
  | "cpu-submit"
  | "gpu-timestamp"
  | "present"
  | "frame-interval"
  | "input-latency";

export interface ChannelSample {
  readonly channel: SampleChannel;
  readonly clockId: SampleClockId;
  /** 该通道本窗口的原始样本毫秒值,按采集顺序;长度必须等于 sampleCount。 */
  readonly samplesMs: readonly number[];
  readonly sampleCount: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** GPU timestamp 等在设备不支持时必须显式 unavailable,不得写 0。 */
  readonly availability: "measured" | "unavailable";
  readonly unavailableReason?: string;
}

export interface SampleWindow {
  readonly schema: "deep-engine.benchmark-sample-window";
  readonly schemaVersion: typeof BENCHMARK_SAMPLE_SCHEMA_VERSION;
  readonly runId: string;
  readonly clockId: SampleClockId;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly channels: readonly ChannelSample[];
}

export interface SampleValidationIssue {
  readonly index: number;
  readonly channel: string;
  readonly message: string;
}

const CLOCKS = new Set<SampleClockId>(["performance-now", "gpu-timestamp", "frame-callback", "host-monotonic"]);
const CHANNELS = new Set<SampleChannel>(["authoring-bridge", "scene-update", "upload", "cpu-submit", "gpu-timestamp", "present", "frame-interval", "input-latency"]);

export function validateSampleWindow(window: SampleWindow): readonly SampleValidationIssue[] {
  const issues: SampleValidationIssue[] = [];
  const fail = (index: number, channel: string, message: string) => issues.push({ index, channel, message });
  if (window.schema !== "deep-engine.benchmark-sample-window" || window.schemaVersion !== BENCHMARK_SAMPLE_SCHEMA_VERSION) {
    fail(-1, "*", "schema identity mismatch");
    return issues;
  }
  if (!CLOCKS.has(window.clockId)) fail(-1, "*", `unknown window clock ${String(window.clockId)}`);
  if (!window.runId.trim()) fail(-1, "*", "run id must not be empty");
  if (!Number.isFinite(window.windowStartMs) || !Number.isFinite(window.windowEndMs) || window.windowEndMs <= window.windowStartMs) {
    fail(-1, "*", "window bounds must be finite with end after start");
  }
  const seen = new Set<string>();
  for (const [index, channel] of (window.channels ?? []).entries()) {
    if (!CHANNELS.has(channel.channel)) { fail(index, String(channel.channel), "unknown channel"); continue; }
    if (seen.has(channel.channel)) fail(index, channel.channel, "duplicate channel in one window");
    seen.add(channel.channel);
    if (!CLOCKS.has(channel.clockId)) { fail(index, channel.channel, `unknown channel clock ${String(channel.clockId)}`); continue; }
    if (channel.availability !== "measured" && channel.availability !== "unavailable") {
      fail(index, channel.channel, "unknown availability"); continue;
    }
    if (!Number.isFinite(channel.windowStartMs) || !Number.isFinite(channel.windowEndMs)
      || channel.windowEndMs <= channel.windowStartMs) {
      fail(index, channel.channel, "channel bounds must be finite with end after start");
    }
    if (channel.windowStartMs < window.windowStartMs || channel.windowEndMs > window.windowEndMs) {
      fail(index, channel.channel, "channel window exceeds the run window");
    }
    if (channel.availability === "unavailable") {
      // 不可用通道禁止携带伪数据:样本必须为空,且必须给出原因。
      if (channel.unavailableReason === undefined || !channel.unavailableReason.trim()) {
        fail(index, channel.channel, "unavailable channel requires a reason");
      }
      if (channel.samplesMs.length || channel.sampleCount !== 0) {
        fail(index, channel.channel, "unavailable channel must not carry samples or a nonzero count");
      }
      continue;
    }
    if (!channel.samplesMs.length) {
      fail(index, channel.channel, "measured channel has no samples; report unavailable instead");
      continue;
    }
    if (channel.sampleCount !== channel.samplesMs.length) {
      fail(index, channel.channel, `sampleCount ${channel.sampleCount} does not match ${channel.samplesMs.length} raw samples`);
    }
    for (const value of channel.samplesMs) {
      if (!Number.isFinite(value) || value < 0) { fail(index, channel.channel, "samples must be finite and non-negative"); break; }
    }
  }
  return issues;
}

export function createSampleWindow(window: SampleWindow): SampleWindow {
  const issues = validateSampleWindow(window);
  if (issues.length) throw new Error(`invalid sample window ${window.runId}: ${issues.map(issue => `${issue.channel}@${issue.index}: ${issue.message}`).join("; ")}`);
  return window;
}

/** 汇总一个通道的中位数;只对 measured 通道有定义,unavailable 返回 undefined 而不是 0。 */
export function channelMedianMs(window: SampleWindow, channel: SampleChannel): number | undefined {
  const entry = window.channels.find(candidate => candidate.channel === channel);
  if (!entry || entry.availability === "unavailable" || !entry.samplesMs.length) return undefined;
  const sorted = [...entry.samplesMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
