import {
  DISABLED_QUALITY_TELEMETRY_SNAPSHOT,
  QualityTelemetryCollector,
  type AuthoredQualityProfile,
  type FrameMetrics,
  type PbrFrameExecutionCoverage,
  type PbrFramePassTimings,
  type QualityTelemetrySnapshot,
} from "@bim-studio/deep-engine/webgpu";

/** T25 质量遥测采样配置。sampleHz ≤ 0 关闭采集(采集器关闭态零开销)。 */
export interface StudioQualityTelemetryOptions {
  /** 聚合采样率(Hz):每 1000/sampleHz 毫秒把窗口内 Deep 帧聚合为一条 QualityFrameRecord。 */
  readonly sampleHz?: number;
  /** 保留记录条数;越界值收敛到采集器合法区间 [16, 4096]。 */
  readonly collectorCapacity?: number;
}

/**
 * 各字段覆盖口径:TS 桥能测到什么、测不到什么,面板必须原样声明,
 * 不得把缺测渲染成数值(与 Native quality_report 的诚实条款同源)。
 */
export interface StudioQualityTelemetryCoverage {
  /** passCount 取 FrameMetrics 帧图回执的 passOrder 长度;窗口内无回执帧即 unavailable。 */
  readonly passCount: "frame-graph-receipt" | "unavailable";
  /** 上传字节 = chunk 流驻留 GPU 字节在采样窗口内的增量(驱逐收缩不计);无 chunk 流即 unavailable。 */
  readonly uploadedBytes: "chunk-stream-residency-delta" | "unavailable";
  /**
   * F1 可见量读出口径:"main-pass-draw-calls" = 主 pass 包体 CPU 编码 draw 数
   * (FrameMetrics.visibleDraws,量非时)已挂;"unavailable" = 后端未产出该读数。
   * 注意:逐实例幸存数仍需遮挡读回(=新 GPU 同步),WebGPU 未挂,该口径是
   * 可见绘制量的代理,不伪称逐实例(T01 record.visibleInstances 保持 null)。
   */
  readonly visibleInstances: "main-pass-draw-calls" | "unavailable";
}

/** 面板/支持报告读取的会话级快照;undefined = 当前没有 Deep 后端发布(WebGL 作者后端等)。 */
export interface StudioQualityTelemetryStatus {
  readonly sampleHz: number;
  readonly activeProfile: AuthoredQualityProfile | null;
  readonly collector: QualityTelemetrySnapshot;
  readonly latestMemory: FrameMetrics["deviceResourceMemory"];
  readonly coverage: StudioQualityTelemetryCoverage;
  /**
   * F1 逐 pass GPU 计时最新读回(undefined = 后端未开启 `gpuPassTiming` 采集,面板
   * 显示「未开启」;availability=unavailable 时带原因)。帧号滞后 1-2 帧,实测帧
   * 在 frame 字段内。
   */
  readonly latestPassTimings?: PbrFramePassTimings;
  /** F1 真实执行 coverage 最新读数(undefined = 后端未产出,常规回执帧必有)。 */
  readonly latestExecutionCoverage?: PbrFrameExecutionCoverage;
  /** F1 可见绘制量最新读出(undefined = 后端未产出该读数)。 */
  readonly latestVisibleDraws?: NonNullable<FrameMetrics["visibleDraws"]>;
  /** 采集器拒收等自检失败;非空表示采样已停止,面板必须展示而非静默。 */
  readonly failure?: string;
}

let publishedQualityTelemetry: StudioQualityTelemetryStatus | undefined;

/** Deep 桥发布/撤销当前会话遥测(镜像 studioFrameCaptureDiagnostics 的模块注册表模式)。 */
export function publishStudioQualityTelemetry(status: StudioQualityTelemetryStatus | undefined): void {
  publishedQualityTelemetry = status;
  // T25 性能探针调试钩子:遥测是模块变量,页面外(Playwright/性能探针)读不到;
  // 挂 window 供刀 B 类探针采集输入轨迹下的逐 pass 分解(只读镜像,非数据源)。
  (globalThis as { __deepQualityTelemetry?: unknown }).__deepQualityTelemetry = status;
}

export function readStudioQualityTelemetry(): StudioQualityTelemetryStatus | undefined {
  return publishedQualityTelemetry;
}

/**
 * T25 桥侧质量遥测采样器:把 Deep 帧循环的 FrameMetrics 低频聚合成与 Native
 * 同语义的 QualityFrameRecord(T01 schema)。默认 4Hz:帧循环内只做字段读取与
 * 累加,无 DOM、无字符串格式化;落账间隔之外的帧零额外成本。
 * 采集器拒收(fail-closed)时记录 failure 并停止采样,绝不把异常抛进渲染帧。
 */
export class StudioDeepQualityTelemetrySampler {
  private readonly collector: QualityTelemetryCollector;
  private readonly intervalMs: number;
  readonly sampleHz: number;
  private readonly activeProfile: AuthoredQualityProfile | null;
  private readonly readResidentBytes: () => number | undefined;
  private latestMemory: FrameMetrics["deviceResourceMemory"];
  private residencyMeasured = false;
  private lastResidency: number | undefined;
  private receiptMeasured = false;
  private windowFrames = 0;
  private windowLatestFrame = -1;
  private windowPassCount: number | undefined;
  private windowUploadedBytes = 0;
  private lastLevel: number | undefined;
  private adaptiveDecisions = 0;
  private lastFlushAt = 0;
  private failure: string | undefined;
  private latestPassTimings: PbrFramePassTimings | undefined;
  private visibleMeasured = false;
  private latestVisibleDraws: NonNullable<FrameMetrics["visibleDraws"]> | undefined;
  private latestExecutionCoverage: PbrFrameExecutionCoverage | undefined;

  constructor(options: StudioQualityTelemetryOptions | undefined, activeProfile: AuthoredQualityProfile | null,
    readResidentBytes: () => number | undefined) {
    this.sampleHz = options?.sampleHz ?? 4;
    this.intervalMs = this.sampleHz > 0 ? 1000 / this.sampleHz : Number.POSITIVE_INFINITY;
    const capacity = options?.collectorCapacity;
    this.collector = new QualityTelemetryCollector(
      capacity === undefined ? undefined : Math.min(4096, Math.max(16, capacity)), this.sampleHz > 0);
    this.activeProfile = activeProfile;
    this.readResidentBytes = readResidentBytes;
  }

  get enabled(): boolean { return this.collector.enabled; }

  /** 采集一帧;返回 true 表示完成一次聚合落账,调用方应发布最新 status。 */
  record(metrics: FrameMetrics, now = performance.now()): boolean {
    if (!this.collector.enabled || this.failure !== undefined) return false;
    this.latestMemory = metrics.deviceResourceMemory;
    // F1 逐 pass 计时直通:只透传最新读回,不做二次加工;metrics 未携带 = 未开启。
    this.latestPassTimings = metrics.gpuPassTimings;
    // F1 执行 coverage 与可见绘制量直通:同为量读数,只透传不加工。
    if (metrics.frameExecutionCoverage) this.latestExecutionCoverage = metrics.frameExecutionCoverage;
    if (metrics.visibleDraws) { this.visibleMeasured = true; this.latestVisibleDraws = metrics.visibleDraws; }
    this.windowFrames++;
    this.windowLatestFrame = metrics.frame;
    const receipt = metrics.frameGraphReceipt;
    if (receipt) { this.receiptMeasured = true; this.windowPassCount = receipt.passOrder.length; }
    const resident = this.readResidentBytes();
    if (resident !== undefined) {
      this.residencyMeasured = true;
      if (this.lastResidency !== undefined) this.windowUploadedBytes += Math.max(0, resident - this.lastResidency);
      this.lastResidency = resident;
    }
    const level = metrics.adaptiveQuality?.level;
    if (level !== undefined) {
      if (this.lastLevel !== undefined && level !== this.lastLevel) this.adaptiveDecisions++;
      this.lastLevel = level;
    }
    if (now - this.lastFlushAt < this.intervalMs) return false;
    this.flush(now);
    return true;
  }

  status(): StudioQualityTelemetryStatus {
    return {
      sampleHz: this.sampleHz,
      activeProfile: this.activeProfile,
      collector: this.failure !== undefined ? DISABLED_QUALITY_TELEMETRY_SNAPSHOT : this.collector.snapshot(),
      latestMemory: this.latestMemory,
      coverage: {
        passCount: this.receiptMeasured ? "frame-graph-receipt" : "unavailable",
        uploadedBytes: this.residencyMeasured ? "chunk-stream-residency-delta" : "unavailable",
        visibleInstances: this.visibleMeasured ? "main-pass-draw-calls" : "unavailable",
      },
      ...(this.latestPassTimings !== undefined ? { latestPassTimings: this.latestPassTimings } : {}),
      ...(this.latestExecutionCoverage !== undefined ? { latestExecutionCoverage: this.latestExecutionCoverage } : {}),
      ...(this.latestVisibleDraws !== undefined ? { latestVisibleDraws: this.latestVisibleDraws } : {}),
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
    };  }

  private flush(now: number): void {
    // 窗口内没有任何带回执帧时不落账:没有可测的 pass 数就不产生半真记录。
    if (this.windowFrames > 0 && this.windowPassCount !== undefined) {
      try {
        this.collector.record({
          frame: this.windowLatestFrame,
          passCount: this.windowPassCount,
          uploadedBytes: this.windowUploadedBytes,
          visibleInstances: null,
          activeProfile: this.activeProfile,
          adaptiveDecisions: this.adaptiveDecisions,
        });
      } catch (reason) {
        this.failure = reason instanceof Error ? reason.message : String(reason);
      }
    }
    this.windowFrames = 0;
    this.windowPassCount = undefined;
    this.windowUploadedBytes = 0;
    this.lastFlushAt = now;
  }
}
