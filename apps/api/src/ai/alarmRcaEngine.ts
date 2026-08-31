import { createHash } from "node:crypto";
import { ALARM_RCA_RULES, type AlarmRcaRule } from "./alarmRcaRules.js";
import type {
  AlarmMeasurementAnomaly, AlarmRcaExplanationEnvelope, AlarmRcaInput, AlarmRcaResult,
  RcaCauseCandidate, RcaConfidenceBand, RcaEvidenceItem, RcaValidationStep,
} from "./alarmRcaTypes.js";

const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export class AlarmRcaInputError extends Error {
  public constructor(message: string) { super(message); this.name = "AlarmRcaInputError"; }
}

/** 确定性生成候选原因与验证闭环；分数表达证据支持度，不表达因果概率。 */
export function analyzeAlarmRca(input: AlarmRcaInput): AlarmRcaResult {
  const time = validateInput(input);
  const excludedRecordIds: string[] = [];
  const events = input.events.filter((item) => includeRecord(item.id, item.assetId, item.occurredAt, input.asset.id, time, excludedRecordIds));
  const anomalies = input.anomalies.filter((item) => includeRecord(item.id, item.assetId, item.observedAt, input.asset.id, time, excludedRecordIds));
  const maintenance = input.maintenanceHistory.filter((item) => {
    const relevant = item.assetId === input.asset.id && Date.parse(item.startedAt) <= time.alarmAt;
    if (!relevant) excludedRecordIds.push(item.id);
    return relevant;
  });
  const candidates = ALARM_RCA_RULES
    .map((rule) => buildCandidate(rule, input, anomalies, events, maintenance, time))
    .filter((item): item is Omit<RcaCauseCandidate, "rank"> => item !== undefined && item.score >= .12)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 5)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const missingEvidence = globalMissingEvidence(input, candidates, anomalies, events);
  const confidence = overallConfidence(candidates);
  const confidenceBand = confidenceBandFor(confidence, candidates[0]?.evidence.length ?? 0);
  const validationSteps = buildValidationSteps(candidates);
  const evidenceFingerprint = fingerprint({ schemaVersion: input.schemaVersion, asset: input.asset, alarm: input.alarm, window: input.window, events, anomalies, maintenance, candidates, missingEvidence });
  return {
    schemaVersion: 1,
    generatedBy: "deterministic-alarm-rca",
    decisionStatus: candidates.length === 0 ? "insufficient-data" : input.alarm.severity === "info" && confidence < .35 ? "monitor" : "investigation-required",
    confidence,
    confidenceBand,
    candidates,
    missingEvidence,
    validationSteps,
    workOrderDraft: {
      id: `wo-draft:${input.alarm.id}`,
      status: "draft",
      title: `核查：${input.asset.name} · ${input.alarm.label}`,
      priority: input.alarm.severity === "critical" ? "high" : input.alarm.severity === "warning" ? "medium" : "low",
      assetId: input.asset.id,
      alarmId: input.alarm.id,
      summary: candidates[0]
        ? `优先验证“${candidates[0].title}”；该项仅为证据支持的候选原因，尚未形成根因结论。`
        : "当前证据不足，先补齐测点、事件和维护记录后再开展根因分析。",
      checklist: validationSteps.map((item) => item.title),
      requiresConfirmation: true,
      closePolicy: "human-only",
      evidenceFingerprint,
    },
    excludedRecordIds: unique(excludedRecordIds),
    limitations: [
      "候选分数表示时间与模式证据的支持度，不代表因果概率或已确认根因",
      "工单仅为草稿，创建、处置和关闭均需授权人员确认",
      "语言模型只能解释本结果，不能新增证据、改变评分或替代现场验证",
    ],
    evidenceFingerprint,
  };
}

/** 给可选 LLM 的输入只包含冻结结果；它没有执行工具和改写领域结论的权限。 */
export function buildAlarmRcaExplanationEnvelope(result: AlarmRcaResult): AlarmRcaExplanationEnvelope {
  const snapshot = {
    decisionStatus: result.decisionStatus,
    confidence: result.confidence,
    confidenceBand: result.confidenceBand,
    candidates: result.candidates.map(({ id, rank, title, score, statement, evidence, missingEvidence }) => ({ id, rank, title, score, statement, evidence, missingEvidence })),
    missingEvidence: result.missingEvidence,
    validationSteps: result.validationSteps,
    limitations: result.limitations,
    evidenceFingerprint: result.evidenceFingerprint,
  };
  return {
    instructions: "只解释给定确定性 RCA 结果。必须使用‘候选、相关、待验证’措辞；不得宣称因果、补造证据、修改分数、执行工具或关闭工单。",
    input: JSON.stringify(snapshot),
    evidenceFingerprint: result.evidenceFingerprint,
  };
}

function buildCandidate(rule: AlarmRcaRule, input: AlarmRcaInput, anomalies: AlarmRcaInput["anomalies"], events: AlarmRcaInput["events"], maintenance: AlarmRcaInput["maintenanceHistory"], time: TimeContext): Omit<RcaCauseCandidate, "rank"> | undefined {
  const alarmText = `${input.alarm.code} ${input.alarm.label}`;
  const evidence: RcaEvidenceItem[] = [];
  const missingEvidence: string[] = [];
  for (const selector of rule.selectors) {
    const matches = selector.kind === "measurement"
      ? anomalies
        .filter((item) => (rule.id === "sensor-communication" || item.quality !== "invalid") && selector.pattern.test(`${item.signal} ${item.label} ${item.direction}`))
        .map((item) => measurementEvidence(item, selector.weight, time, rule.id === "sensor-communication"))
      : selector.kind === "event"
        ? events.filter((item) => selector.pattern.test(`${item.code} ${item.label}`)).map((item) => timedEvidence(item, "event", item.occurredAt, item.qualityScore ?? .8, selector.weight, time))
        : maintenance.filter((item) => selector.pattern.test(`${item.category} ${item.summary} ${(item.affectedSignals ?? []).join(" ")}`)).map((item) => timedEvidence(item, "maintenance", item.completedAt ?? item.startedAt, item.status === "completed" ? .75 : .45, selector.weight, time));
    if (matches.length) evidence.push(matches.sort((left, right) => right.contribution - left.contribution)[0]!);
    else missingEvidence.push(selector.missingLabel);
  }
  const alarmMatch = rule.alarmPattern.test(alarmText);
  const evidenceKinds = new Set(evidence.map((item) => item.kind));
  if (!alarmMatch && evidence.length < 2) return undefined;
  let score = clamp(evidence.reduce((sum, item) => sum + item.contribution, alarmMatch ? .08 : 0), 0, 1);
  if (evidenceKinds.size < 2) score = Math.min(score, .54);
  return {
    id: rule.id,
    title: rule.title,
    score: round(score),
    confidence: confidenceBandFor(score, evidence.length),
    status: "hypothesis",
    statement: `现有证据与“${rule.title}”在时间或模式上相关；这不是因果结论，需按验证步骤确认或排除。`,
    evidence: evidence.sort((left, right) => right.contribution - left.contribution),
    missingEvidence: unique(missingEvidence),
  };
}

function measurementEvidence(item: AlarmMeasurementAnomaly, weight: number, time: TimeContext, measurementChain = false): RcaEvidenceItem {
  const deviation = clamp(Math.abs(item.deviationScore) / 3, .15, 1);
  const processReliability = item.qualityScore * (item.quality === "suspect" ? .6 : item.quality === "invalid" ? 0 : 1);
  const chainReliability = item.quality === "valid" ? Math.max(.25, item.qualityScore) : Math.max(.6, 1 - item.qualityScore);
  return timedEvidence(item, "measurement", item.observedAt, (measurementChain ? chainReliability : processReliability) * deviation, weight, time);
}

function timedEvidence(item: { id: string; label?: string; summary?: string; source?: string }, kind: RcaEvidenceItem["kind"], observedAt: string, reliability: number, weight: number, time: TimeContext): RcaEvidenceItem {
  const temporalProximity = clamp(1 - Math.abs(Date.parse(observedAt) - time.alarmAt) / Math.max(1, time.windowMs), 0, 1);
  const normalizedReliability = clamp(reliability, 0, 1);
  return {
    id: item.id, kind, label: item.label ?? item.summary ?? item.id, source: item.source ?? `${kind}:${item.id}`, observedAt,
    reliability: round(normalizedReliability), temporalProximity: round(temporalProximity),
    contribution: round(weight * normalizedReliability * (.2 + .8 * temporalProximity)),
  };
}

function buildValidationSteps(candidates: RcaCauseCandidate[]): RcaValidationStep[] {
  return candidates.slice(0, 3).flatMap((candidate) => {
    const rule = ALARM_RCA_RULES.find((item) => item.id === candidate.id);
    return (rule?.validation ?? []).map((step, index) => ({
      id: `${candidate.id}:validation:${index + 1}`, candidateId: candidate.id,
      priority: candidate.rank === 1 && index === 0 ? "now" as const : "next" as const,
      ...step, requiresHuman: true as const,
    }));
  }).slice(0, 8);
}

function globalMissingEvidence(input: AlarmRcaInput, candidates: RcaCauseCandidate[], anomalies: AlarmRcaInput["anomalies"], events: AlarmRcaInput["events"]): string[] {
  return unique([
    ...(anomalies.some((item) => item.quality !== "invalid") ? [] : ["告警时间窗内没有有效过程测点异常"]),
    ...(events.length ? [] : ["告警时间窗内没有状态、联锁或操作事件"]),
    ...(input.maintenanceHistory.some((item) => item.assetId === input.asset.id) ? [] : ["设备没有可用维护历史"]),
    ...(candidates[0]?.evidence.filter((item) => item.kind === "measurement").length ?? 0) < 2 ? ["缺少两个独立测量来源的交叉验证"] : [],
    ...candidates.slice(0, 3).flatMap((item) => item.missingEvidence),
  ]).slice(0, 20);
}

interface TimeContext { startAt: number; endAt: number; alarmAt: number; windowMs: number }
function validateInput(input: AlarmRcaInput): TimeContext {
  if (input.schemaVersion !== 1) throw new AlarmRcaInputError("不支持的 RCA 输入版本");
  requireText(input.asset.id, "asset.id"); requireText(input.asset.name, "asset.name"); requireText(input.alarm.id, "alarm.id"); requireText(input.alarm.code, "alarm.code"); requireText(input.alarm.label, "alarm.label");
  if (input.events.length > 5_000 || input.anomalies.length > 2_000 || input.maintenanceHistory.length > 2_000) throw new AlarmRcaInputError("RCA 输入记录超过单次分析上限");
  const startAt = parseTime(input.window.startAt, "window.startAt");
  const endAt = parseTime(input.window.endAt, "window.endAt");
  const alarmAt = parseTime(input.alarm.triggeredAt, "alarm.triggeredAt");
  if (endAt <= startAt || endAt - startAt > MAX_WINDOW_MS) throw new AlarmRcaInputError("RCA 时间窗必须为不超过 30 天的正向区间");
  if (alarmAt < startAt || alarmAt > endAt) throw new AlarmRcaInputError("告警时间不在 RCA 时间窗内");
  for (const anomaly of input.anomalies) {
    requireText(anomaly.id, "anomaly.id"); requireText(anomaly.signal, "anomaly.signal"); parseTime(anomaly.observedAt, "anomaly.observedAt");
    if (!Number.isFinite(anomaly.deviationScore) || !Number.isFinite(anomaly.qualityScore) || anomaly.qualityScore < 0 || anomaly.qualityScore > 1) throw new AlarmRcaInputError(`测点异常 ${anomaly.id} 的偏差或质量分无效`);
  }
  for (const event of input.events) {
    requireText(event.id, "event.id"); requireText(event.code, "event.code"); parseTime(event.occurredAt, "event.occurredAt");
    if (event.qualityScore !== undefined && (!Number.isFinite(event.qualityScore) || event.qualityScore < 0 || event.qualityScore > 1)) throw new AlarmRcaInputError(`事件 ${event.id} 的质量分无效`);
  }
  for (const record of input.maintenanceHistory) {
    requireText(record.id, "maintenance.id"); requireText(record.summary, "maintenance.summary"); parseTime(record.startedAt, "maintenance.startedAt");
    if (record.completedAt) parseTime(record.completedAt, "maintenance.completedAt");
  }
  ensureUnique([...input.events.map((item) => item.id), ...input.anomalies.map((item) => item.id), ...input.maintenanceHistory.map((item) => item.id)]);
  return { startAt, endAt, alarmAt, windowMs: endAt - startAt };
}

function includeRecord(id: string, assetId: string | undefined, observedAt: string, expectedAssetId: string, time: TimeContext, excluded: string[]): boolean {
  const timestamp = parseTime(observedAt, `${id}.time`);
  const included = (!assetId || assetId === expectedAssetId) && timestamp >= time.startAt && timestamp <= time.endAt;
  if (!included) excluded.push(id);
  return included;
}
function overallConfidence(candidates: RcaCauseCandidate[]): number {
  const lead = candidates[0];
  if (!lead) return 0;
  const evidenceDiversity = Math.min(1, new Set(lead.evidence.map((item) => item.kind)).size / 3);
  return round(Math.min(lead.score, lead.score * (.65 + .35 * evidenceDiversity)));
}
function confidenceBandFor(score: number, evidenceCount: number): RcaConfidenceBand {
  if (!evidenceCount || score < .15) return "insufficient";
  if (score < .4) return "low";
  if (score < .7 || evidenceCount < 3) return "medium";
  return "high";
}
function requireText(value: string, path: string): void { if (!value?.trim() || value.length > 500) throw new AlarmRcaInputError(`${path} 必须是有效短文本`); }
function parseTime(value: string, path: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new AlarmRcaInputError(`${path} 不是有效时间`); return parsed; }
function ensureUnique(ids: string[]): void { if (new Set(ids).size !== ids.length) throw new AlarmRcaInputError("RCA 证据记录 ID 必须唯一"); }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function round(value: number): number { return Math.round(value * 1_000) / 1_000; }
