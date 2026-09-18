/** DE26/A03 · render-engine 基准统一采样器:Web 侧对齐 deep-engine.benchmark-sample-window v1
 *  与 chart_e2e_perf(P1-10) 既有口径,TS/Native 同源(Native 见 telemetry_sample_window.rs)。
 *
 *  Rust 侧对齐说明:
 *  - 通道拆分对齐 packages/deep-engine-native/tests/support/chart_e2e_measurements.rs:
 *    CPU prepare(scene-update)/present/GPU timestamp/上传字节分开记录,不得合并成单一帧耗时。
 *  - 分位公式对齐 chart_e2e_measurements.percentile:`sorted[round(p/100*(n-1))]`;
 *    与本目录 FrameSampler 的 nearest-rank(ceil(n*p)-1)是两种既有口径,基准输出一律用本文件,
 *    FrameSampler 仅保留给旧 FrameMetrics 形状。原始样本随窗口落盘,两种口径均可复算。
 *  - GPU timestamp:WebGL 走 EXT_disjoint_timer_query_webgl2(WebGlGpuTimer,ns/1e6→ms),
 *    Native wgpu 用 queue.get_timestamp_period() 换算;扩展/feature 缺失时显式 unavailable,禁止伪零。
 *  - present 的 Web 口径是浏览器 presentation callback feedback(rAF),不冒充 OS compositor scan-out。
 *  - 峰值 RSS:浏览器宿主不暴露 OS RSS,恒显式 unavailable;Chrome JS heap 峰值单独记录,不互相冒充。
 *  - 上传字节对齐 chart_e2e uploaded_bytes:每帧 provider 取值,窗口内求和。 */
import {
  BENCHMARK_SAMPLE_SCHEMA_VERSION,
  createSampleWindow,
  type ChannelSample,
  type SampleChannel,
  type SampleWindow,
} from "@bim-studio/deep-engine";

const SAMPLE_LIMIT = 600;

export type Measured<T> = { readonly availability: "measured"; readonly value: T };
export type Unavailable = { readonly availability: "unavailable"; readonly unavailableReason: string };
export type MeasuredOrUnavailable<T> = Measured<T> | Unavailable;

export interface BenchmarkResourceTelemetry {
  /** 窗口内各帧上传字节求和(chart_e2e uploaded_bytes 口径);未接线或取不到值时显式 unavailable。 */
  readonly uploadBytes: MeasuredOrUnavailable<number>;
  /** Chrome performance.memory JS heap 峰值;API 缺失(Firefox/Safari)显式 unavailable。 */
  readonly peakJsHeapMb: MeasuredOrUnavailable<number>;
  /** 交接第 6 节要求的峰值 RSS:浏览器拿不到 OS RSS,恒 unavailable,禁止拿 heap 冒充。 */
  readonly peakRssMb: Unavailable;
}

export interface ChannelAggregate {
  readonly samples: number;
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface BenchmarkSampleReport {
  readonly window: SampleWindow;
  /** 仅 measured 通道有聚合;unavailable 通道缺席,不写零。 */
  readonly aggregates: Partial<Record<SampleChannel, ChannelAggregate>>;
  readonly resources: BenchmarkResourceTelemetry;
}

export interface BenchmarkSamplerOptions {
  now?: () => number;
  /** 每次呈现反馈后读取本帧上传字节;返回 undefined 表示本帧不可计。 */
  uploadBytes?: () => number | undefined;
  /** 每帧 JS heap MB 探针(Chrome performance.memory.usedJSHeapSize/1048576)。 */
  heapMb?: () => number | undefined;
  /** 原始 GPU timestamp 毫秒样本提供方(WebGL: WebGlGpuTimer.rawSamplesMs)。 */
  gpuTimestamps?: () => readonly number[];
  gpuUnavailableReason?: string;
}

/** chart_e2e_perf 分位口径:sorted[round(p/100*(n-1))];n=1 时恒为该值。 */
export function percentilePerChartE2e(sorted: readonly number[], p: 50 | 95 | 99): number {
  if (!sorted.length) throw new Error("percentile of empty samples is undefined; report unavailable instead");
  return sorted[Math.round((p / 100) * (sorted.length - 1))]!;
}

export function aggregateSamples(samplesMs: readonly number[]): ChannelAggregate {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    averageMs: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50Ms: percentilePerChartE2e(sorted, 50),
    p95Ms: percentilePerChartE2e(sorted, 95),
    p99Ms: percentilePerChartE2e(sorted, 99),
  };
}

function pushBounded(target: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  target.push(value);
  if (target.length > SAMPLE_LIMIT) target.shift();
}

/**
 * 基准帧生命周期采样器。调用序(与 threeWebglRuntime 的循环一一对应):
 *   beginPrepare → endPrepare → recordSubmit(render 起点, 内部取 now 为终点)
 *   → presentationFeedback(rAF 回调) ;recordInput 随时可记,在下次反馈时配对。
 * 全部时间来自注入时钟;负时长样本丢弃(时钟回拨不产生伪数据)。
 */
export class BenchmarkFrameSampler {
  private readonly now: () => number;
  private readonly uploadBytes: (() => number | undefined) | undefined;
  private readonly heapMb: (() => number | undefined) | undefined;
  private readonly gpuTimestamps: (() => readonly number[]) | undefined;
  private readonly gpuUnavailableReason: string;
  private readonly cpuPrepareMs: number[] = [];
  private readonly cpuSubmitMs: number[] = [];
  private readonly presentMs: number[] = [];
  private readonly frameIntervalMs: number[] = [];
  private readonly inputLatencyMs: number[] = [];
  private readonly uploadBytesPerFrame: number[] = [];
  private readonly heapMbPeaks: number[] = [];
  private prepareStartedAt: number | undefined;
  private pendingSubmittedAt: number | undefined;
  private pendingInputs: number[] = [];
  private lastFeedbackAt: number | undefined;
  private windowStartMs: number;

  constructor(options: BenchmarkSamplerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.uploadBytes = options.uploadBytes;
    this.heapMb = options.heapMb;
    this.gpuTimestamps = options.gpuTimestamps;
    this.gpuUnavailableReason = options.gpuUnavailableReason ?? "gpu_timestamp_extension_unavailable";
    this.windowStartMs = this.now();
  }

  beginPrepare(startedAt = this.now()): void {
    this.prepareStartedAt = startedAt;
  }

  endPrepare(endedAt = this.now()): void {
    if (this.prepareStartedAt === undefined) return;
    pushBounded(this.cpuPrepareMs, endedAt - this.prepareStartedAt);
    this.prepareStartedAt = undefined;
  }

  /** 记录一次渲染提交:host 时长 = 终点 - startedAt;终点同时作为 present 配对的提交时间。 */
  recordSubmit(startedAt: number, endedAt = this.now()): void {
    pushBounded(this.cpuSubmitMs, endedAt - startedAt);
    // 同一反馈周期多次提交只保留最后一次配对(对齐 Studio 口径:一个反馈最多一个 present 样本)。
    this.pendingSubmittedAt = endedAt;
  }

  recordInput(inputAt = this.now()): void {
    this.pendingInputs.push(inputAt);
    if (this.pendingInputs.length > SAMPLE_LIMIT) this.pendingInputs.shift();
  }

  presentationFeedback(feedbackAt = this.now()): void {
    if (this.pendingSubmittedAt !== undefined) {
      const present = feedbackAt - this.pendingSubmittedAt;
      if (present >= 0) pushBounded(this.presentMs, present);
    }
    if (this.lastFeedbackAt !== undefined) {
      const interval = feedbackAt - this.lastFeedbackAt;
      if (interval > 0) pushBounded(this.frameIntervalMs, interval);
    }
    for (const inputAt of this.pendingInputs) {
      const latency = feedbackAt - inputAt;
      if (latency >= 0) pushBounded(this.inputLatencyMs, latency);
    }
    this.pendingSubmittedAt = undefined;
    this.pendingInputs = [];
    this.lastFeedbackAt = feedbackAt;
    const bytes = this.uploadBytes?.();
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) this.uploadBytesPerFrame.push(bytes);
    const heap = this.heapMb?.();
    if (typeof heap === "number" && Number.isFinite(heap) && heap >= 0) this.heapMbPeaks.push(heap);
  }

  /** 失焦/按需暂停:切断待配对状态,已落盘样本保留(对齐 StudioDeepSampleWindow.pause 口径)。 */
  pause(): void {
    this.prepareStartedAt = undefined;
    this.pendingSubmittedAt = undefined;
    this.pendingInputs = [];
    this.lastFeedbackAt = undefined;
  }

  reset(): void {
    for (const buffer of [this.cpuPrepareMs, this.cpuSubmitMs, this.presentMs, this.frameIntervalMs, this.inputLatencyMs, this.uploadBytesPerFrame, this.heapMbPeaks]) {
      buffer.length = 0;
    }
    this.pause();
    this.windowStartMs = this.now();
  }

  snapshot(runId: string): BenchmarkSampleReport {
    const windowEndMs = Math.max(this.now(), this.windowStartMs + Number.EPSILON);
    const channel = (
      name: ChannelSample["channel"],
      clockId: ChannelSample["clockId"],
      samples: readonly number[],
      emptyReason: string,
    ): ChannelSample =>
      samples.length
        ? { channel: name, clockId, samplesMs: [...samples], sampleCount: samples.length, windowStartMs: this.windowStartMs, windowEndMs, availability: "measured" }
        : { channel: name, clockId, samplesMs: [], sampleCount: 0, windowStartMs: this.windowStartMs, windowEndMs, availability: "unavailable", unavailableReason: emptyReason };
    const gpuSamples = this.gpuTimestamps?.() ?? [];
    // 原因归因必须诚实:provider 未接线→扩展不可用;接线了但窗口内还没回读到样本→无样本,两者不是一回事。
    const gpuReason = this.gpuTimestamps
      ? (gpuSamples.length ? "no_gpu_timestamp_samples_in_window" : "gpu_timer_wired_but_no_samples_resolved_yet")
      : this.gpuUnavailableReason;
    const window = createSampleWindow({
      schema: "deep-engine.benchmark-sample-window",
      schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
      runId,
      clockId: "performance-now",
      windowStartMs: this.windowStartMs,
      windowEndMs,
      channels: [
        channel("authoring-bridge", "performance-now", [], "benchmark_runtime_has_no_authoring_bridge"),
        channel("scene-update", "performance-now", this.cpuPrepareMs, "no_cpu_prepare_samples_in_window"),
        channel("upload", "performance-now", [], "upload_time_boundary_not_exposed_by_web_runtime"),
        channel("cpu-submit", "performance-now", this.cpuSubmitMs, "no_cpu_submit_samples_in_window"),
        channel("gpu-timestamp", "gpu-timestamp", gpuSamples, gpuReason),
        channel("present", "frame-callback", this.presentMs, "no_browser_presentation_feedback_in_window"),
        channel("frame-interval", "frame-callback", this.frameIntervalMs, "fewer_than_two_presentation_callbacks_in_window"),
        channel("input-latency", "performance-now", this.inputLatencyMs, "no_input_event_reached_a_presentation_callback"),
      ],
    });
    const aggregates: Partial<Record<SampleChannel, ChannelAggregate>> = {};
    for (const entry of window.channels) {
      if (entry.availability === "measured") aggregates[entry.channel] = aggregateSamples(entry.samplesMs);
    }
    return {
      window,
      aggregates,
      resources: {
        uploadBytes: this.uploadBytesPerFrame.length
          ? { availability: "measured", value: this.uploadBytesPerFrame.reduce((total, value) => total + value, 0) }
          : { availability: "unavailable", unavailableReason: "upload_bytes_provider_not_wired_or_never_reported" },
        peakJsHeapMb: this.heapMbPeaks.length
          ? { availability: "measured", value: Math.max(...this.heapMbPeaks) }
          : { availability: "unavailable", unavailableReason: "performance_memory_not_available_in_host" },
        peakRssMb: { availability: "unavailable", unavailableReason: "os_rss_not_exposed_to_browser_hosts" },
      },
    };
  }
}
