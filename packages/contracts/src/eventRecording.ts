/**
 * C4 事件级持久录制合同(2026-09-29)。
 *
 * 定位(现状核查结论):
 * - 事件流来源语义复用 T24 持久订阅运行时(data.ts 的 DataSubscriptionGapReport 语义):
 *   缺口是闭区间一等公民,sequenceKnown=false 表示"完整性未知",绝不静默填平。
 * - 与 T28/T17 物理位姿录制(physicsPoseRecorder 的固定步长帧)是同级不同语义格式:
 *   T17 帧式(均匀步长、每帧必有)记录位姿;本合同事件式(工业时间非均匀、事件序为权威轴)
 *   记录数据事件。桥接点是可选的帧映射(frameMapping):把工业时间投影到固定步长帧轴,
 *   供与 T17 回放按帧对齐;不把事件塞进帧格式。
 * - Study 证据纪律复用 industrialStudy.ts:evidenceRefs 是只读投影追加项;
 *   null 表示缺失必须如实展示;指纹体系沿用 fingerprint.ts(FNV-1a,能如实暴露意外漂移,
 *   对抗性整体重算不在防线内——与 provenance.ts 既定边界一致)。
 *
 * 本文件只有类型、fail-closed 校验、完整性指纹与纯装配/对齐函数,不含存储与 I/O
 * (存储在 apps/api eventRecording.ts;重开接缝由录制会话产出 seam 条目)。
 */

import { fingerprint64 } from "./fingerprint.js";
import type { JsonValue } from "./application.js";
import type { DataEventAction, DataEventTarget } from "./data.js";

/** 录制文件 schema 版本;字段语义变更必须换版本并同步校验函数,旧版本 fail-closed 拒绝。 */
export const EVENT_RECORDING_SCHEMA_VERSION = 1 as const;

/** 双轴之一:工业时间轴(源时间戳,ISO 8601;允许非整倍帧率,不做整倍化)。 */
export type EventRecordingIndustrialTime = string;

/** 录制条目种类。event/gap/out-of-order/seam 四类,缺口与乱序都是一等公民条目。 */
export type EventRecordingEntryKind = "event" | "gap" | "out-of-order" | "seam";

/** 录制内单个事件的负载:DataEvent 的可校验投影(value 收紧为 JSON 可序列化)。 */
export interface EventRecordingEventPayload {
  source: string;
  key: string;
  value: JsonValue;
  sequence?: number;
  sceneId?: string;
  action?: DataEventAction;
  target?: DataEventTarget;
}

/** 接缝的恢复出处:与 T24 SubscriptionCheckpoint 同语义(只引用,不复制治理逻辑)。 */
export interface EventRecordingResumeOrigin {
  connectionId: string;
  generation: number;
  lastSequence: number | null;
  lastTimestamp: string | null;
}

export type EventRecordingSeamReason = "checkpoint-resume" | "manual-reopen";

/** seam 条目:重开接缝的显式声明。接缝不是事件,不占事件序,但占用录制时间轴。 */
export interface EventRecordingSeamEntry {
  kind: "seam";
  reason: EventRecordingSeamReason;
  resumedFrom: EventRecordingResumeOrigin;
  detectedAt: EventRecordingIndustrialTime;
  monotonicMs: number;
}

/**
 * gap 条目:断段缺口的显式建模(T24 DataSubscriptionGapReport 同语义)。
 * from/to 为期望序列号闭区间;sequenceKnown=false 表示源无序列号、丢失量未知——
 * 这是"完整性未知"的诚实声明,读取端必须展示,不得当作连续。
 */
export interface EventRecordingGapEntry {
  kind: "gap";
  fromSequence: number | null;
  toSequence: number | null;
  estimatedCount: number | null;
  fromTime: EventRecordingIndustrialTime;
  toTime: EventRecordingIndustrialTime;
  sequenceKnown: boolean;
  detectedAt: EventRecordingIndustrialTime;
  monotonicMs: number;
}

/**
 * out-of-order 条目:乱序/重复样本的显式标注。
 * 对账规则与 T24 一致(seq <= 水位 = 重复或迟到),但录制端不静默丢弃——
 * 落一条 rejected 条目保留证据,发布语义(丢弃)由消费端按 disposition 决定。
 */
export interface EventRecordingOutOfOrderEntry {
  kind: "out-of-order";
  sequence: number;
  /** 对账时该主题的既有序列水位。 */
  observedSequence: number;
  industrialTime: EventRecordingIndustrialTime;
  monotonicMs: number;
  event: EventRecordingEventPayload;
  disposition: "rejected";
}

/** event 条目:双轴时间显式齐备——工业时间轴 + 录制单调轴 + 权威事件序。 */
export interface EventRecordingEventEntry {
  kind: "event";
  /** 源序列号(权威事件序);源不保证序时由录制器按到达序补发,并置 sequenceAssigned=true。 */
  sequence: number;
  /** 序列号是源自带(false=录制器按到达序补发)。补发序不得与源序混淆对账。 */
  sequenceAssigned: boolean;
  industrialTime: EventRecordingIndustrialTime;
  /** 录制单调轴:相对录制起点 originEpochMs 的毫秒(录制器时钟)。 */
  monotonicMs: number;
  event: EventRecordingEventPayload;
}

export type EventRecordingEntry = EventRecordingEventEntry | EventRecordingGapEntry | EventRecordingOutOfOrderEntry | EventRecordingSeamEntry;

/**
 * 可选帧映射:工业时间 → T17/T28 固定步长帧轴的投影规则。
 * frameStepMs 必须为正;floor/nearest 声明取整方式(同一映射重放可复现)。
 * null = 未声明帧轴;此时按帧对齐的重放不可用,如实报错,不得退化成猜测。
 */
export interface EventRecordingFrameMapping {
  frameStepMs: number;
  mode: "floor" | "nearest";
}

/** 单次打开-关闭的录制段;重开产生新段,段间用 seam 条目声明接缝。 */
export interface EventRecordingSegment {
  segmentId: string;
  openedAt: EventRecordingIndustrialTime;
  /** null = 仍在录制(诚实状态:文件未闭合,完整性结论不得宣称最终)。 */
  closedAt: EventRecordingIndustrialTime | null;
  /** 本段打开时的接缝声明;首段为 null。 */
  resume: EventRecordingResumeOrigin | null;
  entries: EventRecordingEntry[];
}

/** 录制者声明口径:写入时由录制器计算,读取时必须重算比对,不一致即 integrity 失败。 */
export interface EventRecordingTotals {
  eventCount: number;
  gapCount: number;
  outOfOrderCount: number;
  seamCount: number;
  entryCount: number;
}

/** 完整性摘要:序列边界 + 内容指纹。firstSequence/lastSequence 对有序源为实际边界,否则 null。 */
export interface EventRecordingIntegrity {
  firstSequence: number | null;
  lastSequence: number | null;
  /** 源序是否全程已知(全部 event 条目 sequenceAssigned=false 时为 true)。 */
  sourceSequenceKnown: boolean;
  /** 对全部条目的 canonical JSON 做 FNV-1a 指纹;读回必须重算比对。 */
  contentFingerprint: string;
}

/** 完整性结论(读取端推导,不从声明采信)。 */
export type EventRecordingCompleteness =
  | "continuous"
  | "gapped"
  | "open-unknown"
  | "open";

export interface EventRecordingManifest {
  schemaVersion: typeof EVENT_RECORDING_SCHEMA_VERSION;
  recordingId: string;
  projectId: string;
  /** 关联的订阅连接;仿真/注入事件可为 null(来源如实标注在 sourceOrigin)。 */
  connectionId: string | null;
  protocol: string | null;
  /** 数据来源声明:仿真/注入/真实订阅;不伪造真实采集来源。 */
  sourceOrigin: "simulation" | "injected" | "subscription";
  /** 录制时间原点(首段 openedAt 的墙钟毫秒);monotonicMs 相对它计算。 */
  originEpochMs: number;
  startedAt: EventRecordingIndustrialTime;
  /** 全部段闭合时间;仍有开放段时为 null。 */
  closedAt: EventRecordingIndustrialTime | null;
  frameMapping: EventRecordingFrameMapping | null;
  totals: EventRecordingTotals;
  /** 录制者声明;assessEventRecording 重算比对,声明与条目不符即完整性问题。 */
  declaredCompleteness: EventRecordingCompleteness;
  integrity: EventRecordingIntegrity;
}

export interface EventRecordingFile {
  manifest: EventRecordingManifest;
  segments: EventRecordingSegment[];
}

/** 完整性评估结论:完整性推导 + 声明比对,全部 fail-closed。 */
export interface EventRecordingAssessment {
  /** 从条目重算的完整性;open-unknown 优先于 gapped(未知比已知缺口更严重)。 */
  completeness: EventRecordingCompleteness;
  /** 声明口径与重算口径是否一致(totals/integrity/declaredCompleteness 任一不符即 false)。 */
  integrityOk: boolean;
  /** integrityOk=false 时的具体不符项;读取端必须如实展示,不得静默采用任一口径。 */
  mismatches: string[];
  totals: EventRecordingTotals;
  integrity: EventRecordingIntegrity;
}

/** 逐条目结构校验(不含跨条目对账);失败即整文件拒绝,不降级解析。 */
export function validateEventRecordingFile(value: unknown): value is EventRecordingFile {
  if (!isRecord(value)) return false;
  const manifest = value.manifest;
  if (!isRecord(manifest)) return false;
  if (manifest.schemaVersion !== EVENT_RECORDING_SCHEMA_VERSION) return false;
  if (typeof manifest.recordingId !== "string" || manifest.recordingId.length === 0) return false;
  if (typeof manifest.projectId !== "string" || manifest.projectId.length === 0) return false;
  if (manifest.connectionId !== null && typeof manifest.connectionId !== "string") return false;
  if (manifest.protocol !== null && typeof manifest.protocol !== "string") return false;
  if (manifest.sourceOrigin !== "simulation" && manifest.sourceOrigin !== "injected" && manifest.sourceOrigin !== "subscription") return false;
  if (!Number.isSafeInteger(manifest.originEpochMs)) return false;
  if (!validIso(manifest.startedAt)) return false;
  if (manifest.closedAt !== null && !validIso(manifest.closedAt)) return false;
  if (!validFrameMapping(manifest.frameMapping)) return false;
  if (!validTotals(manifest.totals)) return false;
  if (!validCompleteness(manifest.declaredCompleteness)) return false;
  const integrity = manifest.integrity;
  if (!isRecord(integrity)) return false;
  if (integrity.firstSequence !== null && !Number.isSafeInteger(integrity.firstSequence)) return false;
  if (integrity.lastSequence !== null && !Number.isSafeInteger(integrity.lastSequence)) return false;
  if (typeof integrity.sourceSequenceKnown !== "boolean") return false;
  if (typeof integrity.contentFingerprint !== "string" || integrity.contentFingerprint.length === 0) return false;
  if (!Array.isArray(value.segments) || value.segments.length === 0) return false;
  for (const segment of value.segments) {
    if (!validSegment(segment)) return false;
  }
  return true;
}

function validSegment(segment: unknown): segment is EventRecordingSegment {
  if (!isRecord(segment)) return false;
  if (typeof segment.segmentId !== "string" || segment.segmentId.length === 0) return false;
  if (!validIso(segment.openedAt)) return false;
  if (segment.closedAt !== null && !validIso(segment.closedAt)) return false;
  if (segment.resume !== null && !validResume(segment.resume)) return false;
  if (!Array.isArray(segment.entries)) return false;
  for (const entry of segment.entries) {
    if (!validEntry(entry)) return false;
  }
  return true;
}

function validEntry(entry: unknown): entry is EventRecordingEntry {
  if (!isRecord(entry)) return false;
  if (!nonNegativeInt(entry.monotonicMs)) return false;
  switch (entry.kind) {
    case "event":
      if (!nonNegativeInt(entry.sequence)) return false;
      if (typeof entry.sequenceAssigned !== "boolean") return false;
      if (!validIso(entry.industrialTime)) return false;
      return validEventPayload(entry.event);
    case "gap":
      if (entry.fromSequence !== null && !Number.isSafeInteger(entry.fromSequence)) return false;
      if (entry.toSequence !== null && !Number.isSafeInteger(entry.toSequence)) return false;
      if (entry.estimatedCount !== null && !Number.isSafeInteger(entry.estimatedCount)) return false;
      if (typeof entry.sequenceKnown !== "boolean") return false;
      return validIso(entry.fromTime) && validIso(entry.toTime) && validIso(entry.detectedAt);
    case "out-of-order":
      if (!Number.isSafeInteger(entry.sequence) || !Number.isSafeInteger(entry.observedSequence)) return false;
      if (entry.disposition !== "rejected") return false;
      if (!validIso(entry.industrialTime)) return false;
      return validEventPayload(entry.event);
    case "seam":
      if (entry.reason !== "checkpoint-resume" && entry.reason !== "manual-reopen") return false;
      if (!validResume(entry.resumedFrom)) return false;
      return validIso(entry.detectedAt);
    default:
      return false;
  }
}

function validEventPayload(value: unknown): value is EventRecordingEventPayload {
  if (!isRecord(value)) return false;
  if (typeof value.source !== "string" || value.source.length === 0) return false;
  if (typeof value.key !== "string" || value.key.length === 0) return false;
  return value.value !== undefined;
}

function validResume(value: unknown): value is EventRecordingResumeOrigin {
  if (!isRecord(value)) return false;
  if (typeof value.connectionId !== "string" || value.connectionId.length === 0) return false;
  if (!nonNegativeInt(value.generation)) return false;
  if (value.lastSequence !== null && !Number.isSafeInteger(value.lastSequence)) return false;
  if (value.lastTimestamp !== null && !validIso(value.lastTimestamp)) return false;
  return true;
}

function validFrameMapping(value: unknown): value is EventRecordingFrameMapping | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (typeof value.frameStepMs !== "number" || !Number.isFinite(value.frameStepMs) || value.frameStepMs <= 0) return false;
  return value.mode === "floor" || value.mode === "nearest";
}

function validTotals(value: unknown): value is EventRecordingTotals {
  if (!isRecord(value)) return false;
  return nonNegativeInt(value.eventCount) && nonNegativeInt(value.gapCount)
    && nonNegativeInt(value.outOfOrderCount) && nonNegativeInt(value.seamCount)
    && nonNegativeInt(value.entryCount);
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCompleteness(value: unknown): value is EventRecordingCompleteness {
  return value === "continuous" || value === "gapped" || value === "open-unknown" || value === "open";
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 展开全部条目(按段序);对账与重放都工作在这个平坦序列上。 */
export function flattenEventRecordingEntries(file: Pick<EventRecordingFile, "segments">): EventRecordingEntry[] {
  return file.segments.flatMap((segment) => segment.entries);
}

/** 对全部条目 canonical JSON 取 FNV-1a 指纹;键序无关,同内容恒同值。 */
export function eventRecordingContentFingerprint(entries: readonly EventRecordingEntry[]): string {
  return fingerprint64({ entries: [...entries], kind: "event-recording-entries/v1" });
}

/** 从条目重算统计与完整性摘要(不读任何声明字段)。 */
export function deriveEventRecordingIntegrity(entries: readonly EventRecordingEntry[]): { totals: EventRecordingTotals; integrity: EventRecordingIntegrity } {
  let eventCount = 0;
  let gapCount = 0;
  let outOfOrderCount = 0;
  let seamCount = 0;
  let firstSequence: number | null = null;
  let lastSequence: number | null = null;
  let sourceSequenceKnown = true;
  for (const entry of entries) {
    if (entry.kind === "event") {
      eventCount += 1;
      if (entry.sequenceAssigned) sourceSequenceKnown = false;
      else {
        if (firstSequence === null || entry.sequence < firstSequence) firstSequence = entry.sequence;
        if (lastSequence === null || entry.sequence > lastSequence) lastSequence = entry.sequence;
      }
    } else if (entry.kind === "gap") gapCount += 1;
    else if (entry.kind === "out-of-order") outOfOrderCount += 1;
    else seamCount += 1;
  }
  return {
    totals: { eventCount, gapCount, outOfOrderCount, seamCount, entryCount: entries.length },
    integrity: { firstSequence, lastSequence, sourceSequenceKnown, contentFingerprint: eventRecordingContentFingerprint(entries) },
  };
}

/** 从条目与段闭合状态推导完整性;open-unknown > gapped > open > continuous(未知最严重)。 */
export function deriveEventRecordingCompleteness(file: Pick<EventRecordingFile, "segments">): EventRecordingCompleteness {
  const entries = flattenEventRecordingEntries(file);
  const hasUnknownGap = entries.some((entry) => entry.kind === "gap" && !entry.sequenceKnown);
  const hasGap = entries.some((entry) => entry.kind === "gap" || entry.kind === "out-of-order");
  const hasOpenSegment = file.segments.some((segment) => segment.closedAt === null);
  if (hasUnknownGap) return "open-unknown";
  if (hasGap) return "gapped";
  if (hasOpenSegment) return "open";
  return "continuous";
}

/**
 * 完整性评估(读取端唯一可信入口):重算 totals/integrity/completeness 并与声明比对。
 * 任一不符 → integrityOk=false 并列出不符项;调用方必须如实呈现,不得静默采用任一口径。
 */
export function assessEventRecording(file: EventRecordingFile): EventRecordingAssessment {
  const { totals, integrity } = deriveEventRecordingIntegrity(flattenEventRecordingEntries(file));
  const completeness = deriveEventRecordingCompleteness(file);
  const mismatches: string[] = [];
  if (file.manifest.totals.eventCount !== totals.eventCount) mismatches.push(`eventCount 声明 ${file.manifest.totals.eventCount} ≠ 重算 ${totals.eventCount}`);
  if (file.manifest.totals.gapCount !== totals.gapCount) mismatches.push(`gapCount 声明 ${file.manifest.totals.gapCount} ≠ 重算 ${totals.gapCount}`);
  if (file.manifest.totals.outOfOrderCount !== totals.outOfOrderCount) mismatches.push(`outOfOrderCount 声明 ${file.manifest.totals.outOfOrderCount} ≠ 重算 ${totals.outOfOrderCount}`);
  if (file.manifest.totals.seamCount !== totals.seamCount) mismatches.push(`seamCount 声明 ${file.manifest.totals.seamCount} ≠ 重算 ${totals.seamCount}`);
  if (file.manifest.totals.entryCount !== totals.entryCount) mismatches.push(`entryCount 声明 ${file.manifest.totals.entryCount} ≠ 重算 ${totals.entryCount}`);
  if (file.manifest.integrity.firstSequence !== integrity.firstSequence) mismatches.push("firstSequence 声明与重算不一致");
  if (file.manifest.integrity.lastSequence !== integrity.lastSequence) mismatches.push("lastSequence 声明与重算不一致");
  if (file.manifest.integrity.sourceSequenceKnown !== integrity.sourceSequenceKnown) mismatches.push("sourceSequenceKnown 声明与重算不一致");
  if (file.manifest.integrity.contentFingerprint !== integrity.contentFingerprint) mismatches.push("contentFingerprint 条目内容与声明不一致(疑似篡改或截断)");
  if (file.manifest.declaredCompleteness !== completeness) mismatches.push(`declaredCompleteness 声明 ${file.manifest.declaredCompleteness} ≠ 重算 ${completeness}`);
  return { completeness, integrityOk: mismatches.length === 0, mismatches, totals, integrity };
}

// ---------------------------------------------------------------------------
// 三轴重放对齐(纯函数):工业时间轴 / 事件序轴 / 可选帧轴,任一轴可对齐。
// ---------------------------------------------------------------------------

/** 按工业时间轴对齐:闭窗口筛选(ISO 8601 比较用毫秒);与事件序无耦合。 */
export function eventsInIndustrialWindow(
  entries: readonly EventRecordingEntry[],
  fromIso: string,
  toIso: string,
): EventRecordingEventEntry[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("工业时间窗口必须是合法 ISO 8601 时间");
  return entries.filter(isEventWithIndustrialTime).filter((entry) => {
    const at = Date.parse(entry.industrialTime);
    return at >= from && at <= to;
  });
}

/** 按事件序轴对齐:只返回源序条目(补发序不参与),闭区间筛选并按序列升序。 */
export function eventsBySequenceRange(entries: readonly EventRecordingEntry[], fromSequence: number, toSequence: number): EventRecordingEventEntry[] {
  return entries.filter(isSourcedEvent).filter((entry) => entry.sequence >= fromSequence && entry.sequence <= toSequence).sort((left, right) => left.sequence - right.sequence);
}

/** 帧轴投影:工业时间相对录制原点的帧号;未声明帧映射时 fail-closed 报错。 */
export function eventRecordingFrameIndex(industrialTimeIso: string, file: Pick<EventRecordingManifest, "originEpochMs" | "frameMapping">): number {
  if (!file.frameMapping) throw new Error("录制未声明帧映射,按帧轴对齐不可用;请勿退化为猜测帧号");
  const step = file.frameMapping.frameStepMs;
  const elapsed = Date.parse(industrialTimeIso) - file.originEpochMs;
  return file.frameMapping.mode === "floor" ? Math.floor(elapsed / step) : Math.round(elapsed / step);
}

/** 按帧轴对齐:帧号 → 该帧时间窗内的事件;窗口按映射模式取整,与 eventRecordingFrameIndex 同一投影。 */
export function eventsAtFrame(entries: readonly EventRecordingEntry[], frameIndex: number, manifest: Pick<EventRecordingManifest, "originEpochMs" | "frameMapping">): EventRecordingEventEntry[] {
  if (!manifest.frameMapping) throw new Error("录制未声明帧映射,按帧轴对齐不可用;请勿退化为猜测帧号");
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error("帧号必须是非负整数");
  const step = manifest.frameMapping.frameStepMs;
  const center = manifest.originEpochMs + frameIndex * step;
  // floor 帧 = [center, center+step);nearest 帧 = [center-step/2, center+step/2)。
  const from = manifest.frameMapping.mode === "floor" ? center : center - step / 2;
  const to = manifest.frameMapping.mode === "floor" ? center + step : center + step / 2;
  return entries.filter(isEventWithIndustrialTime).filter((entry) => {
    const at = Date.parse(entry.industrialTime);
    return at >= from && at < to;
  });
}

function isEventWithIndustrialTime(entry: EventRecordingEntry): entry is EventRecordingEventEntry {
  return entry.kind === "event";
}

function isSourcedEvent(entry: EventRecordingEntry): entry is EventRecordingEventEntry {
  return entry.kind === "event" && !entry.sequenceAssigned;
}

// ---------------------------------------------------------------------------
// Study 证据资产接入(复用既有证据纪律,不建第二账本):
// 录制以 evidenceRef 形式追加进 IndustrialStudyRecord.result.evidenceRefs;
// 校验失败或文件不完整时如实标注,不追加"看起来可信"的引用。
// ---------------------------------------------------------------------------

/** 证据引用格式:`event-recording:<recordingId>@<contentFingerprint>`;指纹变了引用即失效。 */
export function recordingEvidenceRef(manifest: EventRecordingManifest): string {
  return `event-recording:${manifest.recordingId}@${manifest.integrity.contentFingerprint}`;
}

export interface EventRecordingStudyEvidence {
  ref: string;
  recordingId: string;
  completeness: EventRecordingCompleteness;
  integrityOk: boolean;
  /** integrityOk=false 时的不符项,如实透传给读取端。 */
  mismatches: string[];
}

/** 只读评估:不改文件、不补造完整性;读取端按 completeness/mismatches 决定展示口径。 */
export function describeRecordingEvidence(file: EventRecordingFile): EventRecordingStudyEvidence {
  const assessment = assessEventRecording(file);
  return {
    ref: recordingEvidenceRef(file.manifest),
    recordingId: file.manifest.recordingId,
    completeness: assessment.completeness,
    integrityOk: assessment.integrityOk,
    mismatches: assessment.mismatches,
  };
}

/**
 * 把录制证据追加进 Study 记录的只读投影。
 * 纪律(与 industrialStudy.ts/operationsStudyIndex.ts 一致):
 * - 不修改入参(immutable);原 study.result 为 null 时返回原引用(无结果可挂证据,不造结果);
 * - integrityOk=false 的录制不追加引用——证据指纹对不上等于没有证据,宁可缺失不可伪造;
 * - completenes 非 continuous 时引用照加(缺口是事实不是否定),由读取端按 mismatches 展示。
 */
export function attachRecordingEvidence<S extends { result: { evidenceRefs: string[] } | null }>(study: S, file: EventRecordingFile): S {
  const evidence = describeRecordingEvidence(file);
  if (!study.result || !evidence.integrityOk) return study;
  if (study.result.evidenceRefs.includes(evidence.ref)) return study;
  return {
    ...study,
    result: { ...study.result, evidenceRefs: [...study.result.evidenceRefs, evidence.ref] },
  };
}
