import { describe, expect, it } from "vitest";
import {
  EVENT_RECORDING_SCHEMA_VERSION,
  assessEventRecording,
  attachRecordingEvidence,
  deriveEventRecordingCompleteness,
  deriveEventRecordingIntegrity,
  describeRecordingEvidence,
  eventRecordingContentFingerprint,
  eventRecordingFrameIndex,
  eventsAtFrame,
  eventsBySequenceRange,
  eventsInIndustrialWindow,
  flattenEventRecordingEntries,
  recordingEvidenceRef,
  validateEventRecordingFile,
  type EventRecordingEntry,
  type EventRecordingEventEntry,
  type EventRecordingFile,
  type EventRecordingManifest,
} from "./eventRecording.js";

/** 手工装配合法最小文件(测试用);entries 假定已按序。 */
function buildFile(entries: EventRecordingEntry[], overrides: Partial<EventRecordingManifest> = {}): EventRecordingFile {
  const derived = deriveEventRecordingIntegrity(entries);
  const segments = [{
    segmentId: "seg-1",
    openedAt: "2026-09-29T00:00:00.000Z",
    closedAt: "2026-09-29T00:01:00.000Z" as const | null,
    resume: null,
    entries,
  }];
  const manifest: EventRecordingManifest = {
    schemaVersion: EVENT_RECORDING_SCHEMA_VERSION,
    recordingId: "rec-1",
    projectId: "p1",
    connectionId: null,
    protocol: null,
    sourceOrigin: "simulation",
    originEpochMs: 0,
    startedAt: "2026-09-29T00:00:00.000Z",
    closedAt: segments[0]?.closedAt ?? null,
    frameMapping: null,
    totals: derived.totals,
    declaredCompleteness: deriveEventRecordingCompleteness({ segments }),
    integrity: derived.integrity,
    ...overrides,
  };
  return { manifest, segments };
}

function event(sequence: number, industrialTime: string, monotonicMs = 0): EventRecordingEventEntry {
  return {
    kind: "event",
    sequence,
    sequenceAssigned: false,
    industrialTime,
    monotonicMs,
    event: { source: "plc-a", key: "temperature", value: 21.5 },
  };
}

describe("C4 事件录制合同:schema 版本化与 fail-closed 校验", () => {
  it("未知 schemaVersion 拒绝:旧文件结构变更必须显式迁移,不允许带病解析", () => {
    const file = buildFile([event(1, "2026-09-29T00:00:01.000Z")]);
    const mutated = JSON.parse(JSON.stringify(file)) as EventRecordingFile;
    mutated.manifest.schemaVersion = 999 as unknown as typeof EVENT_RECORDING_SCHEMA_VERSION;
    expect(validateEventRecordingFile(file)).toBe(true);
    expect(validateEventRecordingFile(mutated)).toBe(false);
    expect(validateEventRecordingFile({ ...file, segments: [] })).toBe(false);
  });

  it("逐事件可校验:缺序列号轴/缺工业时间轴/未知条目种类都整体拒绝", () => {
    const missingSequence = buildFile([{ ...event(1, "2026-09-29T00:00:01.000Z"), sequence: undefined } as unknown as EventRecordingEntry]);
    expect(validateEventRecordingFile(missingSequence)).toBe(false);
    const badTime = buildFile([event(1, "not-a-date")]);
    expect(validateEventRecordingFile(badTime)).toBe(false);
    const unknownKind = buildFile([{ kind: "mystery", monotonicMs: 0 } as unknown as EventRecordingEntry]);
    expect(validateEventRecordingFile(unknownKind)).toBe(false);
    const negativeMonotonic = buildFile([event(1, "2026-09-29T00:00:01.000Z", -1)]);
    expect(validateEventRecordingFile(negativeMonotonic)).toBe(false);
  });
});

describe("C4 完整性:声明 vs 重算,不采信任何单方口径", () => {
  it("指纹重算:条目被篡改/截断即 integrityOk=false,mismatches 原样列出", () => {
    const file = buildFile([event(1, "2026-09-29T00:00:01.000Z"), event(2, "2026-09-29T00:00:02.000Z")]);
    expect(assessEventRecording(file).integrityOk).toBe(true);
    // 篡改事件值但不动 manifest → 内容指纹对不上。
    const tampered = JSON.parse(JSON.stringify(file)) as EventRecordingFile;
    const first = tampered.segments[0]?.entries[0];
    if (first?.kind === "event") first.event.value = 999;
    const tamperedAssessment = assessEventRecording(tampered);
    expect(tamperedAssessment.integrityOk).toBe(false);
    expect(tamperedAssessment.mismatches.join("\n")).toContain("contentFingerprint");
    // 声明 continuous 但条目里真有 gap → 完整性声明被重算推翻。
    const gapped = buildFile([
      event(1, "2026-09-29T00:00:01.000Z"),
      { kind: "gap", fromSequence: 2, toSequence: 3, estimatedCount: 2, fromTime: "2026-09-29T00:00:02.000Z", toTime: "2026-09-29T00:00:05.000Z", sequenceKnown: true, detectedAt: "2026-09-29T00:00:05.000Z", monotonicMs: 5000 },
      event(4, "2026-09-29T00:00:06.000Z"),
    ], { declaredCompleteness: "continuous" });
    const gappedAssessment = assessEventRecording(gapped);
    expect(gappedAssessment.completeness).toBe("gapped");
    expect(gappedAssessment.integrityOk).toBe(false);
    expect(gappedAssessment.mismatches.join("\n")).toContain("declaredCompleteness");
  });

  it("完整性推导优先级:open-unknown > gapped > open > continuous(未知最严重)", () => {
    const knownGap = { kind: "gap" as const, fromSequence: 2, toSequence: 3, estimatedCount: 2, fromTime: "t1", toTime: "t2", sequenceKnown: true, detectedAt: "t2", monotonicMs: 1 };
    const unknownGap = { ...knownGap, fromSequence: null, toSequence: null, estimatedCount: null, sequenceKnown: false };
    expect(deriveEventRecordingCompleteness({ segments: [{ segmentId: "s", openedAt: "a", closedAt: "b", resume: null, entries: [event(1, "t")] }] })).toBe("continuous");
    expect(deriveEventRecordingCompleteness({ segments: [{ segmentId: "s", openedAt: "a", closedAt: null, resume: null, entries: [event(1, "t")] }] })).toBe("open");
    expect(deriveEventRecordingCompleteness({ segments: [{ segmentId: "s", openedAt: "a", closedAt: "b", resume: null, entries: [event(1, "t"), knownGap, event(4, "t")] }] })).toBe("gapped");
    expect(deriveEventRecordingCompleteness({ segments: [{ segmentId: "s", openedAt: "a", closedAt: "b", resume: null, entries: [unknownGap] }] })).toBe("open-unknown");
    // 已知缺口与未知缺口并存 → 按未知上报。
    expect(deriveEventRecordingCompleteness({ segments: [{ segmentId: "s", openedAt: "a", closedAt: "b", resume: null, entries: [knownGap, unknownGap] }] })).toBe("open-unknown");
  });
});

describe("C4 双轴时间映射:工业时间与事件序任一轴对齐,帧轴显式声明才可用", () => {
  it("工业时间轴与事件序轴独立对齐;补发序不参与事件序轴", () => {
    // 非整倍帧率语义:工业时间戳间隔 700ms/1100ms,不落在任何整齐网格上。
    const entries: EventRecordingEntry[] = [
      event(0, "2026-09-29T00:00:00.700Z", 700),
      event(1, "2026-09-29T00:00:01.800Z", 1800),
      event(2, "2026-09-29T00:00:02.900Z", 2900),
      { kind: "event", sequence: 1, sequenceAssigned: true, industrialTime: "2026-09-29T00:00:03.000Z", monotonicMs: 3000, event: { source: "sim", key: "tick", value: 1 } },
    ];
    const window = eventsInIndustrialWindow(entries, "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:02.000Z");
    expect(window.map((entry) => entry.industrialTime)).toEqual(["2026-09-29T00:00:00.700Z", "2026-09-29T00:00:01.800Z"]);
    const bySequence = eventsBySequenceRange(entries, 1, 2);
    expect(bySequence.map((entry) => entry.sequence)).toEqual([1, 2]);
    // 补发条目不冒充源序:按序对齐只有 3 条源序事件。
    expect(entries.filter((entry) => entry.kind === "event" && !entry.sequenceAssigned)).toHaveLength(3);
    expect(eventsBySequenceRange(entries, 99, 100)).toEqual([]);
    expect(() => eventsInIndustrialWindow(entries, "bad", "2026-09-29T00:00:00.000Z")).toThrow();
  });

  it("帧轴:floor/nearest 投影 + 按帧取事件;未声明帧映射时 fail-closed 报错", () => {
    const entries: EventRecordingEntry[] = [event(1, "2026-09-29T00:00:00.700Z"), event(2, "2026-09-29T00:00:01.400Z")];
    const floorFile = buildFile(entries, { originEpochMs: Date.parse("2026-09-29T00:00:00.000Z"), frameMapping: { frameStepMs: 500, mode: "floor" } });
    expect(eventRecordingFrameIndex("2026-09-29T00:00:00.700Z", floorFile.manifest)).toBe(1);
    expect(eventRecordingFrameIndex("2026-09-29T00:00:01.400Z", floorFile.manifest)).toBe(2);
    expect(eventsAtFrame(entries, 1, floorFile.manifest).map((entry) => entry.sequence)).toEqual([1]);
    const nearestFile = buildFile(entries, { originEpochMs: Date.parse("2026-09-29T00:00:00.000Z"), frameMapping: { frameStepMs: 500, mode: "nearest" } });
    // 700ms 距 500ms 帧 200ms、距 1000ms 帧 300ms → 最近帧 1;1400ms 恰在 1500 帧边界内取 3。
    expect(eventRecordingFrameIndex("2026-09-29T00:00:00.700Z", nearestFile.manifest)).toBe(1);
    expect(eventRecordingFrameIndex("2026-09-29T00:00:01.400Z", nearestFile.manifest)).toBe(3);
    // nearest 帧窗覆盖整帧 [center-step/2, center+step/2):300ms 落帧 1 前半,不得漏。
    expect(eventsAtFrame(entries, 1, nearestFile.manifest).map((entry) => entry.sequence)).toEqual([1]);
    // 未声明帧轴:按帧对齐不可用,必须报错而不是退化猜测。
    const noFrameFile = buildFile(entries);
    expect(() => eventRecordingFrameIndex("2026-09-29T00:00:00.700Z", noFrameFile.manifest)).toThrow(/帧映射/);
    expect(() => eventsAtFrame(entries, 0, noFrameFile.manifest)).toThrow(/帧映射/);
  });

  it("内容指纹:键序无关、同内容恒同值;flatten 后指纹一致", () => {
    const entries = [event(1, "2026-09-29T00:00:01.000Z")];
    const reordered = JSON.parse(JSON.stringify(entries)) as EventRecordingEntry[];
    const first = reordered[0];
    if (first?.kind === "event") {
      const eventPayload = { ...first.event, value: first.event.value, source: first.event.source, key: first.event.key };
      first.event = { key: eventPayload.key, source: eventPayload.source, value: eventPayload.value };
    }
    expect(eventRecordingContentFingerprint(entries)).toBe(eventRecordingContentFingerprint(reordered));
    const file = buildFile(entries);
    expect(eventRecordingContentFingerprint(flattenEventRecordingEntries(file))).toBe(file.manifest.integrity.contentFingerprint);
  });
});

describe("C4 Study 证据接入:只读投影,不伪造、不重复、不可变", () => {
  it("integrityOk=false 的录制不追加引用——指纹对不上等于没有证据", () => {
    const file = buildFile([event(1, "2026-09-29T00:00:01.000Z")]);
    const tampered = JSON.parse(JSON.stringify(file)) as EventRecordingFile;
    const first = tampered.segments[0]?.entries[0];
    if (first?.kind === "event") first.event.value = "伪造";
    const study = { result: { evidenceRefs: ["solver-fp-1"] } };
    const attached = attachRecordingEvidence(study, tampered);
    expect(attached).toBe(study);
    expect(study.result.evidenceRefs).toEqual(["solver-fp-1"]);
    expect(describeRecordingEvidence(tampered).integrityOk).toBe(false);
  });

  it("追加是 immutable 投影:原 study 不动、引用去重、ref 携带内容指纹", () => {
    const file = buildFile([event(1, "2026-09-29T00:00:01.000Z")]);
    const ref = recordingEvidenceRef(file.manifest);
    expect(ref).toBe(`event-recording:rec-1@${file.manifest.integrity.contentFingerprint}`);
    const study = { result: { evidenceRefs: ["solver-fp-1"] } };
    const once = attachRecordingEvidence(study, file);
    expect(once).not.toBe(study);
    expect(once.result.evidenceRefs).toEqual(["solver-fp-1", ref]);
    expect(study.result.evidenceRefs).toEqual(["solver-fp-1"]);
    // 幂等:同一录制重复挂不产生重复引用。
    const twice = attachRecordingEvidence(once, file);
    expect(twice.result.evidenceRefs).toEqual(["solver-fp-1", ref]);
    // 缺 result(无证据位)如实保持缺失,不造结果位。
    const withoutResult = { result: null };
    expect(attachRecordingEvidence(withoutResult, file)).toBe(withoutResult);
    // gap 录制照常可引用(缺口是事实不是否定),completeness 原样透出。
    const gapped = buildFile([
      event(1, "2026-09-29T00:00:01.000Z"),
      { kind: "gap", fromSequence: 2, toSequence: 4, estimatedCount: 3, fromTime: "t", toTime: "t2", sequenceKnown: true, detectedAt: "t2", monotonicMs: 1 },
    ]);
    expect(describeRecordingEvidence(gapped)).toMatchObject({ completeness: "gapped", integrityOk: true });
  });
});
