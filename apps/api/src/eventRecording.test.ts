import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessEventRecording, validateEventRecordingFile, type EventRecordingEntry, type EventRecordingFile } from "@bim-studio/contracts";
import { EventRecordingFileStore, EventRecordingSession } from "./eventRecording.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

/** 确定时钟:第 n 次调用返回 1000+n 毫秒;monotonicMs 相对录制原点。 */
function deterministicClock() {
  let tick = 0;
  return () => 1000 + tick++ * 100;
}

function openSession(options: Partial<ConstructorParameters<typeof EventRecordingSession>[0]> = {}): EventRecordingSession {
  return new EventRecordingSession({
    recordingId: options.recordingId ?? "rec-test",
    projectId: options.projectId ?? "p1",
    sourceOrigin: options.sourceOrigin ?? "simulation",
    ...options,
    ...(options.now ? { now: options.now } : { now: deterministicClock() }),
  });
}

describe("C4 事件录制:正常连续与 schema 自检", () => {
  it("连续有序录制 → continuous,manifest 由条目推导且自检通过,totals 逐类计数", () => {
    const session = openSession({ recordingId: "rec-cont" });
    for (const sequence of [1, 2, 3]) {
      const receipt = session.record({ source: "plc-a", key: "temperature", value: 21.5, timestamp: "2026-09-29T00:00:0" + sequence + ".000Z", sequence });
      expect(receipt.kind).toBe("event");
    }
    session.close();
    const file = session.file();
    expect(validateEventRecordingFile(file)).toBe(true);
    expect(file.manifest.totals).toEqual({ eventCount: 3, gapCount: 0, outOfOrderCount: 0, seamCount: 0, entryCount: 3 });
    expect(file.manifest.declaredCompleteness).toBe("continuous");
    expect(file.manifest.integrity).toMatchObject({ firstSequence: 1, lastSequence: 3, sourceSequenceKnown: true });
    expect(assessEventRecording(file)).toMatchObject({ completeness: "continuous", integrityOk: true, mismatches: [] });
    // 双轴显式齐备:每条事件都有工业时间与录制单调毫秒(原点=会话构造时刻)。
    const entries = file.segments[0]?.entries ?? [];
    expect(entries.map((entry) => entry.monotonicMs)).toEqual([100, 200, 300]);
    expect(entries.every((entry) => entry.kind !== "event" || Number.isFinite(Date.parse(entry.industrialTime)))).toBe(true);
  });

  it("非 JSON 可序列化 value 显式拒绝:录制不伪造 null,不静默丢字段", () => {
    const session = openSession();
    expect(() => session.record({ source: "s", key: "k", value: undefined, timestamp: "2026-09-29T00:00:00.000Z" })).toThrow(/不可序列化/);
    expect(() => session.record({ source: "s", key: "k", value: Number.NaN, timestamp: "2026-09-29T00:00:00.000Z" })).toThrow(/null/);
  });

  it("条目达到显式上限 → 报错要求开新录制,绝不静默截断", () => {
    const session = openSession({ maxEntries: 2 });
    session.record({ source: "s", key: "k", value: 1, timestamp: "2026-09-29T00:00:00.000Z" });
    session.record({ source: "s", key: "k", value: 2, timestamp: "2026-09-29T00:00:01.000Z" });
    expect(() => session.record({ source: "s", key: "k", value: 3, timestamp: "2026-09-29T00:00:02.000Z" })).toThrow(/上限/);
  });
});

describe("C4 断段/乱序/重开:缺口是一等公民,不伪造完整性", () => {
  it("断段:序列跳跃落显式 gap 闭区间条目,缺失事件绝不补造", () => {
    const session = openSession({ recordingId: "rec-gap" });
    session.record({ source: "plc-a", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    session.record({ source: "plc-a", key: "k", value: 2, timestamp: "2026-09-29T00:00:02.000Z", sequence: 2 });
    const jumped = session.record({ source: "plc-a", key: "k", value: 5, timestamp: "2026-09-29T00:00:05.000Z", sequence: 5 });
    expect(jumped.kind).toBe("gap");
    session.close();
    const file = session.file();
    const assessment = assessEventRecording(file);
    expect(assessment.completeness).toBe("gapped");
    expect(assessment.integrityOk).toBe(true);
    const gap = file.segments[0]?.entries.find((entry) => entry.kind === "gap");
    expect(gap).toMatchObject({ kind: "gap", fromSequence: 3, toSequence: 4, estimatedCount: 2, sequenceKnown: true });
    // 完整性即事实:事件只有 3 条,缺口声明 [3,4];不存在任何伪造的 3/4 号事件。
    const file2 = file as EventRecordingFile;
    const sequences = file2.segments.flatMap((segment) => segment.entries).filter((entry): entry is Extract<EventRecordingEntry, { kind: "event" }> => entry.kind === "event").map((entry) => entry.sequence);
    expect(sequences).toEqual([1, 2, 5]);
    expect(file2.manifest.totals.eventCount).toBe(3);
    expect(file2.manifest.totals.gapCount).toBe(1);
  });

  it("乱序:迟到/重复样本落 out-of-order 条目(disposition=rejected)显式呈现,不静默丢弃也不计入事件", () => {
    const session = openSession({ recordingId: "rec-ooo" });
    session.record({ source: "plc-a", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    session.record({ source: "plc-a", key: "k", value: 2, timestamp: "2026-09-29T00:00:02.000Z", sequence: 2 });
    const late = session.record({ source: "plc-a", key: "k", value: 1.5, timestamp: "2026-09-29T00:00:01.500Z", sequence: 1 });
    expect(late.kind).toBe("out-of-order");
    expect(late.entry).toMatchObject({ kind: "out-of-order", sequence: 1, observedSequence: 2, disposition: "rejected" });
    // 乱序不污染水位:后续 3 号照常连续,不再误报缺口。
    const next = session.record({ source: "plc-a", key: "k", value: 3, timestamp: "2026-09-29T00:00:03.000Z", sequence: 3 });
    expect(next.kind).toBe("event");
    session.close();
    const file = session.file();
    expect(assessEventRecording(file)).toMatchObject({ completeness: "gapped", integrityOk: true });
    expect(file.manifest.totals).toEqual({ eventCount: 3, gapCount: 0, outOfOrderCount: 1, seamCount: 0, entryCount: 4 });
    expect(file.manifest.integrity.lastSequence).toBe(3);
  });

  it("重开(checkpoint 恢复,有序源):seam 条目声明出处,恢复后跳跃按接缝水位落 gap", () => {
    const session = openSession({ recordingId: "rec-reopen", connectionId: "conn-1" });
    session.record({ source: "plc-a", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    session.record({ source: "plc-a", key: "k", value: 2, timestamp: "2026-09-29T00:00:02.000Z", sequence: 2 });
    session.close();
    const before = session.file();
    expect(before.manifest.closedAt).not.toBeNull();
    // 恢复后继续录制:接缝 = T24 checkpoint 位置。
    session.resume({ connectionId: "conn-1", generation: 3, lastSequence: 2, lastTimestamp: "2026-09-29T00:00:02.000Z" });
    const afterSeam = session.record({ source: "plc-a", key: "k", value: 5, timestamp: "2026-09-29T00:00:09.000Z", sequence: 5 });
    expect(afterSeam.kind).toBe("gap");
    session.close();
    const file = session.file();
    // 两段 + 一条 seam:接缝显式声明 checkpoint 出处,不宣称无缝连续。
    expect(file.segments).toHaveLength(2);
    expect(file.segments[1]?.resume).toEqual({ connectionId: "conn-1", generation: 3, lastSequence: 2, lastTimestamp: "2026-09-29T00:00:02.000Z" });
    const seam = file.segments[1]?.entries[0];
    expect(seam).toMatchObject({ kind: "seam", reason: "checkpoint-resume", resumedFrom: { connectionId: "conn-1", generation: 3, lastSequence: 2 } });
    // 接缝后跳跃按接缝水位对账:gap [3,4],不是假装从 5 连续开始。
    const secondEntries = file.segments[1]?.entries ?? [];
    expect(secondEntries.find((entry) => entry.kind === "gap")).toMatchObject({ fromSequence: 3, toSequence: 4, estimatedCount: 2, sequenceKnown: true });
    expect(assessEventRecording(file)).toMatchObject({ completeness: "gapped", integrityOk: true });
    expect(file.manifest.totals.seamCount).toBe(1);
  });

  it("重开(无序列号源):接缝后首条样本落 sequenceKnown=false 缺口——完整性未知,不假装连续", () => {
    const session = openSession({ recordingId: "rec-unknown", connectionId: "conn-mqtt" });
    session.record({ source: "mqtt/topic", key: "k", value: "a", timestamp: "2026-09-29T00:00:01.000Z" });
    session.close();
    session.resume({ connectionId: "conn-mqtt", generation: 2, lastSequence: null, lastTimestamp: "2026-09-29T00:00:01.000Z" });
    const resumed = session.record({ source: "mqtt/topic", key: "k", value: "b", timestamp: "2026-09-29T00:00:05.000Z" });
    expect(resumed.kind).toBe("event");
    session.close();
    const file = session.file();
    const assessment = assessEventRecording(file);
    expect(assessment.completeness).toBe("open-unknown");
    expect(assessment.integrityOk).toBe(true);
    const unknownGap = file.segments.flatMap((segment) => segment.entries).find((entry) => entry.kind === "gap");
    expect(unknownGap).toMatchObject({ kind: "gap", fromSequence: null, toSequence: null, estimatedCount: null, sequenceKnown: false });
    // 断线区间确实丢失,无法量化:事件数如实只有 2,estimatedCount 不许编数。
    expect(file.manifest.totals.eventCount).toBe(2);
  });

  it("重开后重复投递:接缝水位播种,旧样本幂等标注 out-of-order 而非重复计事件", () => {
    const session = openSession({ recordingId: "rec-dup", connectionId: "conn-1" });
    session.record({ source: "plc-a", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    session.record({ source: "plc-a", key: "k", value: 2, timestamp: "2026-09-29T00:00:02.000Z", sequence: 2 });
    session.close();
    session.resume({ connectionId: "conn-1", generation: 2, lastSequence: 2, lastTimestamp: "2026-09-29T00:00:02.000Z" });
    const replayed = session.record({ source: "plc-a", key: "k", value: 2, timestamp: "2026-09-29T00:00:02.000Z", sequence: 2 });
    expect(replayed.kind).toBe("out-of-order");
    const fresh = session.record({ source: "plc-a", key: "k", value: 3, timestamp: "2026-09-29T00:00:03.000Z", sequence: 3 });
    expect(fresh.kind).toBe("event");
    session.close();
    const file = session.file();
    expect(file.manifest.totals.eventCount).toBe(3);
    expect(file.manifest.totals.outOfOrderCount).toBe(1);
    expect(file.manifest.totals.gapCount).toBe(0);
  });
});

describe("C4 文件存储与续写:N11 同款 fail-closed 纪律", () => {
  async function createStore() {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-event-recording-"));
    directories.push(dataDir);
    return { dataDir, store: new EventRecordingFileStore(dataDir) };
  }

  it("同 id 无痕重开被拒:重开必须走 resume 接缝;落盘文件读回自检一致", async () => {
    const { store } = await createStore();
    const session = openSession({ recordingId: "rec-store", projectId: "p-store" });
    session.record({ source: "s", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    await store.begin(session);
    const second = openSession({ recordingId: "rec-store", projectId: "p-store" });
    await expect(store.begin(second)).rejects.toThrow(/无痕重开/);
    const loaded = await store.load("p-store", "rec-store");
    expect(loaded).not.toBeNull();
    expect(assessEventRecording(loaded as EventRecordingFile).integrityOk).toBe(true);
    expect(await store.load("p-store", "missing")).toBeNull();
  });

  it("文件损坏 fail-closed:JSON 残缺抛错拒绝读取,绝不带病解析或静默重建", async () => {
    const { dataDir, store } = await createStore();
    const session = openSession({ recordingId: "rec-corrupt", projectId: "p-c" });
    await store.begin(session);
    const filePath = path.join(dataDir, "event-recordings", "p-c", "rec-corrupt.json");
    await writeFile(filePath, "{ not-json", "utf8");
    await expect(store.load("p-c", "rec-corrupt")).rejects.toThrow(/损坏/);
    await writeFile(filePath, JSON.stringify({ manifest: { schemaVersion: 1 } }), "utf8");
    await expect(store.load("p-c", "rec-corrupt")).rejects.toThrow(/结构无效/);
  });

  it("fromFile 重建:历史条目保真;闭合文件直接续写被拒,显式 resume 后接缝水位正确", async () => {
    const { store } = await createStore();
    const session = openSession({ recordingId: "rec-resume", projectId: "p-r", connectionId: "conn-1" });
    session.record({ source: "plc-a", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    session.close();
    await store.persist(session);
    const loaded = await store.load("p-r", "rec-resume") as EventRecordingFile;
    const restored = EventRecordingSession.fromFile(loaded);
    expect(restored.open).toBe(false);
    expect(() => restored.record({ source: "plc-a", key: "k", value: 9, timestamp: "2026-09-29T00:00:09.000Z", sequence: 9 })).toThrow(/resume/);
    restored.resume({ connectionId: "conn-1", generation: 4, lastSequence: 1, lastTimestamp: "2026-09-29T00:00:01.000Z" });
    restored.record({ source: "plc-a", key: "k", value: 4, timestamp: "2026-09-29T00:00:04.000Z", sequence: 4 });
    await store.persist(restored);
    const merged = await store.load("p-r", "rec-resume") as EventRecordingFile;
    expect(merged.segments).toHaveLength(2);
    // 历史段保真:首段仍只有 1 号事件;接缝后跳跃按恢复水位落 gap [2,3]。
    expect(merged.segments[0]?.entries).toHaveLength(1);
    expect(merged.segments[1]?.entries.find((entry) => entry.kind === "gap")).toMatchObject({ fromSequence: 2, toSequence: 3 });
    expect(assessEventRecording(merged)).toMatchObject({ completeness: "gapped", integrityOk: true });
  });
});
