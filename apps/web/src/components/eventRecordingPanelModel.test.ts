import { describe, expect, it } from "vitest";
import { deriveEventRecordingIntegrity, type EventRecordingEventEntry, type EventRecordingFile, type IndustrialStudyRecord } from "@bim-studio/contracts";
import { checkedRecording, parseRecordingEvent, recordingEvents, recordingStudyCopy, recordingUrl } from "./eventRecordingPanelModel";

function file(): EventRecordingFile {
  const entries: EventRecordingEventEntry[] = [
    { kind: "event", industrialTime: "2026-09-30T00:00:00.150Z", monotonicMs: 150, sequence: 9, sequenceAssigned: false, event: { source: "plc", key: "temp", value: 25 } },
    { kind: "event", industrialTime: "2026-09-30T00:00:00.220Z", monotonicMs: 220, sequence: 10, sequenceAssigned: true, event: { source: "injected", key: "temp", value: 26 } },
  ];
  const derived = deriveEventRecordingIntegrity(entries);
  return { manifest: { schemaVersion: 1, recordingId: "rec-1", projectId: "p1", connectionId: null, protocol: null, sourceOrigin: "injected", originEpochMs: Date.parse("2026-09-30T00:00:00Z"), startedAt: "2026-09-30T00:00:00Z", closedAt: "2026-09-30T00:00:01Z", frameMapping: { frameStepMs: 100, mode: "floor" }, ...derived, declaredCompleteness: "continuous" }, segments: [{ segmentId: "seg1", openedAt: "2026-09-30T00:00:00Z", closedAt: "2026-09-30T00:00:01Z", resume: null, entries }] };
}
describe("recording user entry semantics", () => {
  it("fails closed on cross-project and malformed files", () => {
    expect(() => checkedRecording(file(), "p2")).toThrow("当前项目");
    expect(() => checkedRecording({}, "p1")).toThrow("格式无效");
    expect(recordingUrl("p/a", "rec #1")).toBe("/api/projects/p%2Fa/data/recordings/rec%20%231");
  });
  it("uses industrial windows and declared frames while excluding assigned sequence from source-axis results", () => {
    const value = file();
    expect(recordingEvents(value, "sequence", "0", "100").map(event => event.sequence)).toEqual([9]);
    expect(recordingEvents(value, "time", "2026-09-30T00:00:00.200Z", "2026-09-30T00:00:01Z").map(event => event.sequence)).toEqual([10]);
    expect(recordingEvents(value, "frame", "1", "").map(event => event.sequence)).toEqual([9]);
    value.manifest.frameMapping = null;
    expect(() => recordingEvents(value, "frame", "1", "")).toThrow("未声明帧映射");
    expect(() => recordingEvents(value, "sequence", "5", "3")).toThrow("终止源序");
    expect(() => recordingEvents(value, "time", "2026-10-01", "2026-09-30")).toThrow("终止时间");
  });
  it("preserves unknown source sequence and rejects false sequence/timestamps before mutation", () => {
    expect(parseRecordingEvent('{"source":"manual","key":"temp","value":27}')).not.toHaveProperty("sequence");
    expect(() => parseRecordingEvent('{"source":"manual","key":"temp","value":27,"sequence":1.5}')).toThrow("源序");
    expect(() => parseRecordingEvent('{"source":"manual","key":"temp","value":27,"timestamp":"bad"}')).toThrow("timestamp");
    expect(() => parseRecordingEvent("null")).toThrow("source");
    expect(() => parseRecordingEvent('{"source":"manual","key":"temp","value":27,"action":"color"}')).toThrow("其他字段尚未接入");
  });
  it("exports an immutable Study projection and rejects corrupt evidence, missing result, and cross-project pairing", () => {
    const study = { projectId: "p1", result: { evidenceRefs: ["original"] } } as IndustrialStudyRecord;
    const copy = recordingStudyCopy(study, file());
    expect(copy.study.result?.evidenceRefs).toHaveLength(2); expect(study.result?.evidenceRefs).toEqual(["original"]);
    const corrupt = file(); corrupt.manifest.integrity.contentFingerprint = "wrong";
    expect(() => recordingStudyCopy(study, corrupt)).toThrow("完整性");
    expect(() => recordingStudyCopy({ ...study, result: null }, file())).toThrow("尚无结果");
    expect(() => recordingStudyCopy({ ...study, projectId: "p2" }, file())).toThrow("同一项目");
  });
});
