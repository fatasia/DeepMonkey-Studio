/**
 * C4 事件级持久录制:录制会话 + 文件存储(2026-09-29)。
 *
 * 现状核查定位:
 * - 复用 T24 持久订阅运行时(subscriptionRuntime.ts)的对账语义:序列水位、断段缺口
 *   闭区间、无序列号源"完整性未知"声明;录制端不另立对账规则。
 * - 复用 N11 FileSubscriptionCheckpointStore 的持久化纪律:原子写(tmp+rename)、
 *   损坏/结构无效 fail-closed 拒绝恢复,绝不带病续写。
 * - 与 T28/T17 物理位姿录制是同级不同语义格式(帧式 vs 事件式);桥接只经由
 *   contracts 的 frameMapping 帧轴投影,不互相包装。
 * - Study 证据接入走 contracts recordingEvidenceRef/attachRecordingEvidence
 *   (evidenceRefs 只读投影),本文件不建第二账本。
 *
 * 诚实边界(与 acceptance 一致):数据来源为仿真/注入事件时 sourceOrigin 必须
 * 如实声明 simulation/injected,不得标成 subscription 冒充真实采集。
 * 当前切片按事件逐条整文件重写持久化(N 条 O(N) I/O);批量高频场景的增量落盘
 * 留给后续切片,此处不静默降级。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVENT_RECORDING_SCHEMA_VERSION,
  assessEventRecording,
  deriveEventRecordingCompleteness,
  deriveEventRecordingIntegrity,
  validateEventRecordingFile,
  type EventRecordingEntry,
  type EventRecordingEventPayload,
  type EventRecordingFile,
  type EventRecordingFrameMapping,
  type EventRecordingGapEntry,
  type EventRecordingManifest,
  type EventRecordingOutOfOrderEntry,
  type EventRecordingResumeOrigin,
  type EventRecordingSegment,
  type EventRecordingSeamReason,
} from "@bim-studio/contracts";
import type { SourceSample } from "./subscriptionRuntime.js";

/** 录制输入:DataEvent 同构载荷(注入路由直接透传);sequence 缺失表示源不保证序。 */
export interface EventRecordingInput {
  source: string;
  key: string;
  value: unknown;
  /** 源工业时间(ISO 8601);缺失时落到录制器时钟——补发口径由 missingTimestamp=true? */
  timestamp: string;
  sequence?: number;
  sceneId?: string;
}

/** 单条录制回执:消费端据此知道本条落在哪类条目上(伴随断段时报 gap,事件本体也已落盘)。 */
export type EventRecordingReceipt =
  | { kind: "event"; entry: Extract<EventRecordingEntry, { kind: "event" }> }
  | { kind: "gap"; entry: EventRecordingGapEntry }
  | { kind: "out-of-order"; entry: EventRecordingOutOfOrderEntry };

export interface EventRecordingSessionOptions {
  recordingId: string;
  projectId: string;
  connectionId?: string | null;
  protocol?: string | null;
  /** 仿真/注入事件必须如实声明;不得标 subscription 冒充真实采集。 */
  sourceOrigin: EventRecordingManifest["sourceOrigin"];
  frameMapping?: EventRecordingFrameMapping | null;
  /** 单文件条目上限;超出显式报错要求开新录制,绝不静默截断。 */
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 20_000;

/**
 * 事件录制会话。
 *
 * 对账规则(与 T24 handleSample 一致,按 source 独立记账):
 * - 有序列号源:seq == 水位+1 → event;seq <= 水位 → out-of-order 条目(rejected,不静默丢);
 *   seq > 水位+1 → 先落 gap 闭区间条目再落 event(不阻塞新数据)。
 * - 无序列号源:按到达序补发 sequenceAssigned=true 的序号(不与源序混算);
 *   接缝(resume)后的首条样本 → gap{sequenceKnown:false} 完整性未知声明。
 * - 接缝:close 后 resume(checkpoint) 开新段,段首落 seam 条目声明恢复出处;
 *   checkpoint 播种序列水位,恢复后旧样本仍被幂等标注而非重复计入事件。
 */
export class EventRecordingSession {
  private readonly segments: EventRecordingSegment[] = [];
  private readonly sourceSequences = new Map<string, number>();
  private readonly assignedSequences = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly connectionId: string | null;
  private readonly protocol: string | null;
  private readonly pendingSeedRef = { seed: undefined as number | null | undefined, awaitingUnknownGap: false };
  private originEpochMs = 0;
  private startedAt = "";
  private entryCount = 0;

  constructor(private readonly options: EventRecordingSessionOptions) {
    if (!options.recordingId) throw new Error("录制 id 不能为空");
    if (!options.projectId) throw new Error("录制所属项目不能为空");
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.connectionId = options.connectionId ?? null;
    this.protocol = options.protocol ?? null;
    this.originEpochMs = this.now();
    this.startedAt = new Date(this.originEpochMs).toISOString();
    this.segments.push({ segmentId: randomUUID(), openedAt: this.startedAt, closedAt: null, resume: null, entries: [] });
  }

  /** 当前是否有开放段。 */
  get open(): boolean {
    return this.segments.some((segment) => segment.closedAt === null);
  }

  /**
   * 从已落盘文件重建会话(路由/宿主续写用)。
   * 历史条目原样保真——不重新过 record() 对账,只恢复水位状态机:
   * seam 重置水位(同 resume),源序事件推进水位,补发事件推进补发序,
   * sequenceKnown=false 的 gap 表示未知声明已消费。重建后:
   * - 有开放段 → 可直接 record() 续写;
   * - 全部闭合 → record() 会拒绝,必须显式 resume() 声明新接缝。
   */
  static fromFile(file: EventRecordingFile, now?: () => number): EventRecordingSession {
    const manifest = file.manifest;
    const session = new EventRecordingSession({
      recordingId: manifest.recordingId,
      projectId: manifest.projectId,
      ...(manifest.connectionId !== null ? { connectionId: manifest.connectionId } : {}),
      ...(manifest.protocol !== null ? { protocol: manifest.protocol } : {}),
      sourceOrigin: manifest.sourceOrigin,
      ...(manifest.frameMapping !== null ? { frameMapping: manifest.frameMapping } : {}),
      ...(now ? { now } : {}),
    });
    session.originEpochMs = manifest.originEpochMs;
    session.startedAt = manifest.startedAt;
    session.segments.splice(0, session.segments.length, ...file.segments.map((segment) => ({ ...segment, entries: [...segment.entries] })));
    session.entryCount = file.segments.reduce((total, segment) => total + segment.entries.length, 0);
    session.sourceSequences.clear();
    session.assignedSequences.clear();
    session.pendingSeedRef.seed = undefined;
    session.pendingSeedRef.awaitingUnknownGap = false;
    for (const segment of session.segments) {
      for (const entry of segment.entries) {
        if (entry.kind === "seam") {
          session.sourceSequences.clear();
          session.assignedSequences.clear();
          session.pendingSeedRef.seed = entry.resumedFrom.lastSequence;
          session.pendingSeedRef.awaitingUnknownGap = entry.resumedFrom.lastSequence === null;
        } else if (entry.kind === "event") {
          const source = entry.event.source;
          if (entry.sequenceAssigned) {
            session.pendingSeedRef.awaitingUnknownGap = false;
            session.assignedSequences.set(source, Math.max(session.assignedSequences.get(source) ?? 0, entry.sequence));
          } else {
            session.pendingSeedRef.seed = undefined;
            session.sourceSequences.set(source, Math.max(session.sourceSequences.get(source) ?? 0, entry.sequence));
          }
        } else if (entry.kind === "gap" && !entry.sequenceKnown) {
          session.pendingSeedRef.awaitingUnknownGap = false;
        }
      }
    }
    return session;
  }

  /**
   * checkpoint 恢复接缝:close 之后从持久化位置继续录制。
   * origin 与 T24 SubscriptionCheckpoint 同构;接缝只声明出处,不伪造连续性——
   * 恢复后的缺口/未知完整性由后续 record() 按对账规则落条目呈现。
   */
  resume(origin: EventRecordingResumeOrigin, reason: EventRecordingSeamReason = "checkpoint-resume"): void {
    if (!origin.connectionId) throw new Error("接缝恢复出处必须带 connectionId");
    if (!Number.isSafeInteger(origin.generation) || origin.generation < 0) throw new Error("接缝恢复出处 generation 无效");
    if (this.open) throw new Error(`录制 ${this.options.recordingId} 仍有开放段,重开前必须显式 close`);
    const at = this.now();
    const segment: EventRecordingSegment = {
      segmentId: randomUUID(),
      openedAt: new Date(at).toISOString(),
      closedAt: null,
      resume: {
        connectionId: origin.connectionId,
        generation: origin.generation,
        lastSequence: origin.lastSequence,
        lastTimestamp: origin.lastTimestamp,
      },
      entries: [{
        kind: "seam",
        reason,
        resumedFrom: { ...origin },
        detectedAt: new Date(at).toISOString(),
        monotonicMs: at - this.originEpochMs,
      }],
    };
    this.segments.push(segment);
    // 接缝播种:与 T24 相同,恢复后用 checkpoint 位置播种序列水位,旧样本幂等标注。
    this.sourceSequences.clear();
    this.assignedSequences.clear();
    this.pendingSeedRef.seed = origin.lastSequence;
    // 无序列号源:恢复后首条样本必须落"完整性未知"声明。
    this.pendingSeedRef.awaitingUnknownGap = origin.lastSequence === null;
  }

  /** 记录一条事件;返回落点回执。非 JSON 可序列化 value 显式报错(fail-closed)。 */
  record(input: EventRecordingInput): EventRecordingReceipt {
    if (!this.open) throw new Error(`录制 ${this.options.recordingId} 已闭合,继续录制请先显式 resume 声明接缝`);
    if (this.entryCount >= this.maxEntries) {
      throw new Error(`录制 ${this.options.recordingId} 条目数达到上限 ${this.maxEntries},请显式 close 后开新录制;不静默截断`);
    }
    const source = input.source?.trim();
    const key = input.key?.trim();
    if (!source || !key) throw new Error("录制事件必须包含 source 与 key");
    const value = serializeValue(input.value);
    const at = this.now();
    const industrialTime = validIso(input.timestamp) ? new Date(input.timestamp).toISOString() : new Date(at).toISOString();
    const monotonicMs = at - this.originEpochMs;
    const payload: EventRecordingEventPayload = {
      source,
      key,
      value,
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    };

    if (input.sequence !== undefined) {
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error(`录制事件序列号无效:${String(input.sequence)}`);
      // checkpoint 播种:恢复后首个有序样本用接缝位置初始化水位(T24 同款)。
      const seed = this.pendingSeedRef.seed;
      const seeded = this.sourceSequences.size === 0 && typeof seed === "number" ? seed : undefined;
      const watermark = this.sourceSequences.get(source) ?? seeded;
      this.pendingSeedRef.seed = undefined;
      if (watermark !== undefined) {
        if (input.sequence <= watermark) {
          const entry: EventRecordingOutOfOrderEntry = {
            kind: "out-of-order",
            sequence: input.sequence,
            observedSequence: watermark,
            industrialTime,
            monotonicMs,
            event: payload,
            disposition: "rejected",
          };
          this.append(entry);
          return { kind: "out-of-order", entry };
        }
        if (input.sequence > watermark + 1) {
          const gap: EventRecordingGapEntry = {
            kind: "gap",
            fromSequence: watermark + 1,
            toSequence: input.sequence - 1,
            estimatedCount: input.sequence - watermark - 1,
            fromTime: industrialTime,
            toTime: industrialTime,
            sequenceKnown: true,
            detectedAt: industrialTime,
            monotonicMs,
          };
          this.append(gap);
          this.sourceSequences.set(source, input.sequence);
          const entry: Extract<EventRecordingEntry, { kind: "event" }> = {
            kind: "event",
            sequence: input.sequence,
            sequenceAssigned: false,
            industrialTime,
            monotonicMs,
            event: payload,
          };
          this.append(entry);
          // 缺口与事件都已落盘;回执以 gap 报告,消费端据此知道本条伴随断段声明。
          return { kind: "gap", entry: gap };
        }
      }
      this.sourceSequences.set(source, input.sequence);
      const entry: Extract<EventRecordingEntry, { kind: "event" }> = {
        kind: "event",
        sequence: input.sequence,
        sequenceAssigned: false,
        industrialTime,
        monotonicMs,
        event: payload,
      };
      this.append(entry);
      return { kind: "event", entry };
    }

    // 无序列号源:接缝后首条样本 → 完整性未知声明(T24 awaitingResync 同语义)。
    if (this.pendingSeedRef.awaitingUnknownGap) {
      this.pendingSeedRef.awaitingUnknownGap = false;
      const gap: EventRecordingGapEntry = {
        kind: "gap",
        fromSequence: null,
        toSequence: null,
        estimatedCount: null,
        fromTime: industrialTime,
        toTime: industrialTime,
        sequenceKnown: false,
        detectedAt: industrialTime,
        monotonicMs,
      };
      this.append(gap);
    }
    const assigned = (this.assignedSequences.get(source) ?? 0) + 1;
    this.assignedSequences.set(source, assigned);
    const entry: Extract<EventRecordingEntry, { kind: "event" }> = {
      kind: "event",
      sequence: assigned,
      sequenceAssigned: true,
      industrialTime,
      monotonicMs,
      event: payload,
    };
    this.append(entry);
    return { kind: "event", entry };
  }

  /** 闭合当前开放段;全部段闭合后 manifest.closedAt 才有值。幂等。 */
  close(): void {
    const at = this.now();
    for (const segment of this.segments) {
      if (segment.closedAt === null) segment.closedAt = new Date(at).toISOString();
    }
  }

  /** 当前文件的权威投影:manifest 由条目实时推导,录制器永远不写与自己条目矛盾的声明。 */
  file(): EventRecordingFile {
    const derived = deriveEventRecordingIntegrity(this.segments.flatMap((segment) => segment.entries));
    const closedAt = this.segments.every((segment) => segment.closedAt !== null)
      ? this.segments.map((segment) => segment.closedAt as string).reduce((latest, at) => (at > latest ? at : latest))
      : null;
    const manifest: EventRecordingManifest = {
      schemaVersion: EVENT_RECORDING_SCHEMA_VERSION,
      recordingId: this.options.recordingId,
      projectId: this.options.projectId,
      connectionId: this.connectionId,
      protocol: this.protocol,
      sourceOrigin: this.options.sourceOrigin,
      originEpochMs: this.originEpochMs,
      startedAt: this.startedAt,
      closedAt,
      frameMapping: this.options.frameMapping ?? null,
      totals: derived.totals,
      declaredCompleteness: deriveEventRecordingCompleteness({ segments: this.segments }),
      integrity: derived.integrity,
    };
    const file: EventRecordingFile = { manifest, segments: this.segments.map((segment) => ({ ...segment, entries: [...segment.entries] })) };
    const assessment = assessEventRecording(file);
    if (!assessment.integrityOk) throw new Error(`录制 ${this.options.recordingId} 自检失败:${assessment.mismatches.join(";")}`);
    return file;
  }

  private append(entry: EventRecordingEntry): void {
    const segment = this.segments[this.segments.length - 1];
    if (!segment || segment.closedAt !== null) throw new Error(`录制 ${this.options.recordingId} 没有开放段可写`);
    segment.entries.push(entry);
    this.entryCount += 1;
  }
}

/**
 * 录制文件存储:N11 同款纪律——原子写(tmp+rename)、文件名哈希化、
 * 损坏或结构无效 fail-closed 抛错,绝不带病续写、绝不静默重建。
 */
export class EventRecordingFileStore {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "event-recordings");
  }

  /** 新建录制;同 id 已存在即拒绝(重开必须走 resume 接缝,不允许无痕重写)。检查与写入在同一排队窗口内。 */
  async begin(session: EventRecordingSession): Promise<void> {
    const file = session.file();
    const key = `${file.manifest.projectId}/${file.manifest.recordingId}`;
    await this.enqueue(key, async () => {
      const existing = await this.load(file.manifest.projectId, file.manifest.recordingId);
      if (existing) throw new Error(`录制 ${file.manifest.recordingId} 已存在;重开请用 resume 声明接缝,不允许无痕重开`);
      await mkdir(path.join(this.directory, file.manifest.projectId), { recursive: true });
      const target = this.pathFor(file.manifest.projectId, file.manifest.recordingId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(file, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async persist(session: EventRecordingSession): Promise<void> {
    const file = session.file();
    const key = `${file.manifest.projectId}/${file.manifest.recordingId}`;
    await this.enqueue(key, async () => {
      await mkdir(path.join(this.directory, file.manifest.projectId), { recursive: true });
      const target = this.pathFor(file.manifest.projectId, file.manifest.recordingId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(file, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async load(projectId: string, recordingId: string): Promise<EventRecordingFile | null> {
    let content: string;
    try {
      content = await readFile(this.pathFor(projectId, recordingId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`录制文件 ${projectId}/${recordingId} 损坏,拒绝读取或续写;请修复或显式删除后开新录制`);
    }
    if (!validateEventRecordingFile(parsed)) {
      throw new Error(`录制文件 ${projectId}/${recordingId} 结构无效(schemaVersion=${String((parsed as { manifest?: { schemaVersion?: unknown } })?.manifest?.schemaVersion)}),拒绝读取或续写`);
    }
    return parsed;
  }

  async list(projectId: string): Promise<EventRecordingManifest[]> {
    let names: string[] = [];
    try {
      names = await readdirOrEmpty(path.join(this.directory, projectId));
    } catch {
      return [];
    }
    const manifests: EventRecordingManifest[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const file = await this.load(projectId, name.slice(0, -".json".length));
      if (file) manifests.push(file.manifest);
    }
    return manifests.sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
  }

  private pathFor(projectId: string, recordingId: string): string {
    if (!projectId || !recordingId) throw new Error("projectId 与 recordingId 不能为空");
    if (!/^[A-Za-z0-9._-]+$/.test(recordingId)) throw new Error(`录制 id 只允许字母数字与 ._-:${recordingId}`);
    return path.join(this.directory, projectId, `${recordingId}.json`);
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.pending.set(key, next);
    void next.finally(() => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    }).catch(() => undefined);
    return next;
  }
}

/**
 * T24 SourceSample → 录制输入的桥(录制路由/注入侧复用)。
 * topic → source 直映;key 由调用方提供(协议适配知道 topic→信号名的映射,录制层不猜)。
 */
export function recordingInputFromSourceSample(sample: SourceSample, key: string): EventRecordingInput {
  return {
    source: sample.topic,
    key,
    value: sample.value,
    timestamp: sample.timestamp,
    ...(sample.sequence !== undefined ? { sequence: sample.sequence } : {}),
  };
}

function serializeValue(value: unknown): EventRecordingEventPayload["value"] {
  if (value === undefined) throw new Error("录制事件 value 不可序列化(undefined);请显式提供 null 或具体值");
  const serialized = JSON.parse(JSON.stringify(value)) as EventRecordingEventPayload["value"];
  if (serialized === null && value !== null) throw new Error("录制事件 value 序列化失败(非 JSON 可序列化);录制拒绝伪造 null 值");
  return serialized;
}

function validIso(value: string | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function readdirOrEmpty(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
