import { AUTHORED_QUALITY_PROFILES, type AuthoredQualityProfile, isAuthoredQualityProfile } from "./adaptiveQuality.js";

/**
 * T01 跨端同语义质量诊断 schema。
 * 词汇复用现有诊断:`AuthoredQualityProfile`(adaptiveQuality)、
 * `uploadedBytes`(gpuRenderResidencyTelemetry)、pass 口径(pbrFrameReceipt 的
 * passOrder / Native frame.rs 编码边界)。Native 镜像与采集见
 * `packages/deep-engine-native/src/renderer/quality_telemetry.rs`;
 * 关闭诊断时两侧都必须零分配、零格式化、零额外遍历。
 */
export const QUALITY_TELEMETRY_SCHEMA = "deep-engine.quality-telemetry" as const;
export const QUALITY_TELEMETRY_VERSION = 1 as const;

/** 单帧质量诊断记录;字段在 Native 侧以 camelCase 原名序列化。 */
export interface QualityFrameRecord {
  readonly frame: number;
  /** 本帧编码的 pass 边界数(与 Native render 循环同一计数规则)。 */
  readonly passCount: number;
  /** 本帧记录周期内入队的上传字节;0 是该覆盖口径下的真实零,不是缺测。 */
  readonly uploadedBytes: number;
  /** 主视锥剔除后实际绘制(幸存)实例数;null = 该端未挂读回,未测量。 */
  readonly visibleInstances: number | null;
  /** 活动质量档;null = 作者未设档(如 Native 无 DEEP_ENGINE_QUALITY_PROFILE 的传统路径)。 */
  readonly activeProfile: AuthoredQualityProfile | null;
  /** 自适应质量决策(降档+恢复)累计计数;静态档恒为 0。 */
  readonly adaptiveDecisions: number;
}

export interface QualityTelemetryTotals {
  readonly passCount: number;
  readonly uploadedBytes: number;
  /** visibleInstances 非 null 的帧数;为 0 表示该端从未测量,禁止当「全部可见」。 */
  readonly framesWithMeasuredVisibleInstances: number;
}

export interface QualityTelemetrySnapshot {
  readonly schema: typeof QUALITY_TELEMETRY_SCHEMA;
  readonly version: typeof QUALITY_TELEMETRY_VERSION;
  readonly capacity: number;
  readonly retainedFrameCount: number;
  readonly firstFrame: number | null;
  readonly lastFrame: number | null;
  readonly totals: QualityTelemetryTotals;
  /** 最新保留帧的活动质量档。 */
  readonly activeProfile: AuthoredQualityProfile | null;
  /** 最新保留帧的自适应决策累计数;无保留帧时 null。 */
  readonly adaptiveDecisions: number | null;
  readonly frames: readonly QualityFrameRecord[];
}

const EMPTY_TOTALS: QualityTelemetryTotals = Object.freeze({
  passCount: 0, uploadedBytes: 0, framesWithMeasuredVisibleInstances: 0,
});

/**
 * 诊断关闭时 snapshot() 恒等返回的冻结常量:关闭态零分配的可断言锚点。
 * capacity 0 表示关闭态不保留任何帧记录。
 */
export const DISABLED_QUALITY_TELEMETRY_SNAPSHOT: QualityTelemetrySnapshot = Object.freeze({
  schema: QUALITY_TELEMETRY_SCHEMA,
  version: QUALITY_TELEMETRY_VERSION,
  capacity: 0,
  retainedFrameCount: 0,
  firstFrame: null,
  lastFrame: null,
  totals: EMPTY_TOTALS,
  activeProfile: null,
  adaptiveDecisions: null,
  frames: Object.freeze([]),
});

const DEFAULT_CAPACITY = 256;

/**
 * Bounded quality telemetry window, mirroring `EnginePerformanceTelemetry`:
 * fail-closed validation, eviction barrier, and an entry-return disabled path
 * (关闭态入口即返回,不校验、不分配、不构造字符串)。
 */
export class QualityTelemetryCollector {
  private readonly frames = new Map<number, QualityFrameRecord>();
  private readonly order: number[] = [];
  private evictedThrough = -1;
  private totals = { passCount: 0, uploadedBytes: 0, framesWithMeasuredVisibleInstances: 0 };

  constructor(readonly capacity = DEFAULT_CAPACITY, public enabled = false) {
    if (!Number.isSafeInteger(capacity) || capacity < 16 || capacity > 4096) {
      throw new RangeError("Quality telemetry capacity must be an integer from 16 to 4096.");
    }
  }

  record(record: QualityFrameRecord): void {
    if (!this.enabled) return;
    assertFrameRecord(record);
    if (record.frame <= this.evictedThrough) {
      throw new RangeError("Quality telemetry frame arrived after its frame was evicted.");
    }
    if (this.frames.has(record.frame)) {
      throw new Error(`Quality telemetry already recorded frame ${record.frame}.`);
    }
    this.frames.set(record.frame, record);
    this.order.push(record.frame);
    this.totals.passCount += record.passCount;
    this.totals.uploadedBytes += record.uploadedBytes;
    if (record.visibleInstances !== null) this.totals.framesWithMeasuredVisibleInstances += 1;
    this.trim();
  }

  snapshot(): QualityTelemetrySnapshot {
    if (!this.enabled) return DISABLED_QUALITY_TELEMETRY_SNAPSHOT;
    const ordered = [...this.order].sort((left, right) => left - right)
      .map(frame => this.frames.get(frame)!);
    const latest = ordered.at(-1);
    return Object.freeze({
      schema: QUALITY_TELEMETRY_SCHEMA,
      version: QUALITY_TELEMETRY_VERSION,
      capacity: this.capacity,
      retainedFrameCount: ordered.length,
      firstFrame: ordered[0]?.frame ?? null,
      lastFrame: latest?.frame ?? null,
      totals: Object.freeze({ ...this.totals }),
      activeProfile: latest?.activeProfile ?? null,
      adaptiveDecisions: latest ? latest.adaptiveDecisions : null,
      frames: Object.freeze(ordered.map(record => Object.freeze({ ...record }))),
    });
  }

  /** Clears retained records while keeping the eviction barrier against late frames. */
  reset(): void {
    for (const frame of this.order) this.evictedThrough = Math.max(this.evictedThrough, frame);
    this.frames.clear();
    this.order.length = 0;
    this.totals = { passCount: 0, uploadedBytes: 0, framesWithMeasuredVisibleInstances: 0 };
  }

  private trim(): void {
    if (this.order.length <= this.capacity) return;
    const oldest = this.order.shift()!;
    this.frames.delete(oldest);
    this.evictedThrough = Math.max(this.evictedThrough, oldest);
  }
}

function assertFrameRecord(record: QualityFrameRecord): void {
  if (!Number.isSafeInteger(record.frame) || record.frame < 0) {
    throw new RangeError("Quality telemetry frame must be a non-negative safe integer.");
  }
  for (const [name, value] of [["passCount", record.passCount], ["uploadedBytes", record.uploadedBytes],
    ["adaptiveDecisions", record.adaptiveDecisions]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Quality telemetry ${name} must be a non-negative safe integer.`);
    }
  }
  if (record.visibleInstances !== null
    && (!Number.isSafeInteger(record.visibleInstances) || record.visibleInstances < 0)) {
    throw new RangeError("Quality telemetry visibleInstances must be null or a non-negative safe integer.");
  }
  if (record.activeProfile !== null && !isAuthoredQualityProfile(record.activeProfile)) {
    throw new RangeError(`Quality telemetry activeProfile must be one of ${AUTHORED_QUALITY_PROFILES.join(", ")}.`);
  }
}
