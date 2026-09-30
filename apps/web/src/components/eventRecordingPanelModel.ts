import {
  assessEventRecording, attachRecordingEvidence, eventsAtFrame, eventsBySequenceRange,
  eventsInIndustrialWindow, flattenEventRecordingEntries, validateEventRecordingFile,
  type EventRecordingFile, type EventRecordingEventEntry, type IndustrialStudyRecord,
} from "@bim-studio/contracts";

export type RecordingAxis = "all" | "time" | "sequence" | "frame";
export type RecordingRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
export function recordingUrl(projectId: string, recordingId?: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/data/recordings`;
  return recordingId ? `${base}/${encodeURIComponent(recordingId)}` : base;
}
export function checkedRecording(value: unknown, projectId: string): EventRecordingFile {
  if (!validateEventRecordingFile(value)) throw new Error("录制格式无效，请检查文件结构");
  const file = value;
  if (file.manifest.projectId !== projectId) throw new Error("录制不属于当前项目");
  return file;
}
export function recordingEvents(file: EventRecordingFile, axis: RecordingAxis, from: string, to: string): EventRecordingEventEntry[] {
  const entries = flattenEventRecordingEntries(file);
  if (axis === "all") return entries.filter((entry): entry is EventRecordingEventEntry => entry.kind === "event");
  if (axis === "time") {
    if (Date.parse(from) > Date.parse(to)) throw new Error("终止时间须晚于或等于起始时间");
    return eventsInIndustrialWindow(entries, from, to);
  }
  const first = Number(from), last = Number(to);
  if (!from.trim() || !Number.isSafeInteger(first) || first < 0) throw new Error("请输入非负整数");
  if (axis === "frame") return eventsAtFrame(entries, first, file.manifest);
  if (!to.trim() || !Number.isSafeInteger(last) || last < first) throw new Error("终止源序必须是大于或等于起始源序的整数");
  return eventsBySequenceRange(entries, first, last);
}
export function parseRecordingEvent(text: string) {
  const event = JSON.parse(text) as Record<string, unknown>;
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.source !== "string" || !event.source.trim() || typeof event.key !== "string" || !event.key.trim() || !("value" in event)) throw new Error("事件须包含 source、key、value");
  const supported = new Set(["source", "key", "value", "sequence", "timestamp", "sceneId"]);
  if (Object.keys(event).some(key => !supported.has(key))) throw new Error("本入口支持 source、key、value、sequence、timestamp、sceneId；其他字段尚未接入录制路由");
  if (event.sequence !== undefined && (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0)) throw new Error("源序须为非负整数，未知时省略 sequence");
  if (event.timestamp !== undefined && (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)))) throw new Error("timestamp 须为合法时间");
  return event;
}
export function recordingStudyCopy(study: IndustrialStudyRecord, file: EventRecordingFile) {
  if (study.projectId !== file.manifest.projectId) throw new Error("运行记录和录制必须属于同一项目");
  if (!study.result) throw new Error("运行记录尚无结果，不能追加证据");
  const assessment = assessEventRecording(file);
  if (!assessment.integrityOk) throw new Error("录制完整性校验失败，请先检查不符项");
  return { study: attachRecordingEvidence(study, file), recording: file, assessment };
}
