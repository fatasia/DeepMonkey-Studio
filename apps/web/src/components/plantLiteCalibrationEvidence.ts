import type {
  DataDatasetPreview,
  DataDatasetRecord,
  PlantLiteConfidenceInterval,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";
import { createEvidenceFingerprint, EVIDENCE_FINGERPRINT_ALGORITHM } from "@bim-studio/studio-core";

export type PlantLiteCalibrationStatus = "passed" | "conditional" | "failed" | "insufficient-data";
export type PlantLiteCalibrationMetricKey = "throughputPerHour" | "averageWip" | "averageLeadTimeMinutes";
export type PlantLiteCalibrationUnit = "item-per-hour" | "item-per-minute" | "item-per-second" | "item" | "minute" | "second" | "hour";

export interface PlantLiteCalibrationMetricMapping {
  field: string;
  unit: PlantLiteCalibrationUnit;
  tolerancePercent: number;
}

export interface PlantLiteCalibrationMapping {
  timestampField: string;
  throughputPerHour: PlantLiteCalibrationMetricMapping;
  averageWip: PlantLiteCalibrationMetricMapping;
  averageLeadTimeMinutes: PlantLiteCalibrationMetricMapping;
}

export interface PlantLiteCalibrationWindow {
  startInclusive: string;
  endInclusive: string;
}

export interface PlantLiteCalibrationMetricEvidence {
  key: PlantLiteCalibrationMetricKey;
  field: string;
  sourceUnit: PlantLiteCalibrationUnit;
  canonicalUnit: "item-per-hour" | "item" | "minute";
  tolerancePercent: number;
  sampleCount: number;
  rejectedSampleCount: number;
  measuredMean?: number;
  simulatedMean?: number;
  simulated95?: { lower: number; upper: number; samples: number };
  absoluteError?: number;
  relativeErrorPercent?: number;
  status: PlantLiteCalibrationStatus;
  reason: string;
}

export interface PlantLiteCalibrationEvidence {
  status: PlantLiteCalibrationStatus;
  study: { id: string; inputFingerprint: string; modelFingerprint: string | null };
  source: {
    datasetId: string;
    datasetName: string;
    connectionId: string;
    datasetUpdatedAt: string;
    previewDurationMs: number;
    previewRowCount: number;
    windowRowCount: number;
    snapshotFingerprint: string;
    fingerprintAlgorithm: typeof EVIDENCE_FINGERPRINT_ALGORITHM;
  };
  mapping: PlantLiteCalibrationMapping;
  window: { startInclusive: string; endInclusive: string; minimumSamples: number };
  metrics: PlantLiteCalibrationMetricEvidence[];
  issues: string[];
  evidenceFingerprint: string;
  declaration: string;
}

export interface PlantLiteCalibrationInput {
  study: PlantLiteStudyRecord;
  dataset: DataDatasetRecord;
  preview: DataDatasetPreview;
  mapping: PlantLiteCalibrationMapping;
  window: PlantLiteCalibrationWindow;
  minimumSamples?: number;
}

const METRICS: Array<{
  key: PlantLiteCalibrationMetricKey;
  canonicalUnit: PlantLiteCalibrationMetricEvidence["canonicalUnit"];
  interval: (study: PlantLiteStudyRecord) => PlantLiteConfidenceInterval;
}> = [
  { key: "throughputPerHour", canonicalUnit: "item-per-hour", interval: (study) => study.outcome.throughputPerHour },
  { key: "averageWip", canonicalUnit: "item", interval: (study) => study.outcome.averageWip },
  { key: "averageLeadTimeMinutes", canonicalUnit: "minute", interval: (study) => study.outcome.averageLeadTimeMinutes },
];

export const EMPTY_PLANT_LITE_CALIBRATION_MAPPING: PlantLiteCalibrationMapping = {
  timestampField: "",
  throughputPerHour: { field: "", unit: "item-per-hour", tolerancePercent: 10 },
  averageWip: { field: "", unit: "item", tolerancePercent: 10 },
  averageLeadTimeMinutes: { field: "", unit: "minute", tolerancePercent: 10 },
};

export function plantLiteCalibrationWindowBounds(
  preview: DataDatasetPreview,
  timestampField: string,
): PlantLiteCalibrationWindow | undefined {
  const timestamps = preview.rows
    .map((row) => parseTimestamp(row[timestampField]))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  if (!timestamps.length) return undefined;
  return { startInclusive: new Date(timestamps[0]!).toISOString(), endInclusive: new Date(timestamps.at(-1)!).toISOString() };
}

/**
 * 用选定的现场样本验证 Study 结果。该函数只生成校核证据，不拟合参数、不修改模型，
 * 也不会把数据预览窗口描述成完整历史数据。
 */
export function buildPlantLiteCalibrationEvidence(input: PlantLiteCalibrationInput): PlantLiteCalibrationEvidence {
  const minimumSamples = normalizeMinimumSamples(input.minimumSamples);
  const start = parseTimestamp(input.window.startInclusive);
  const end = parseTimestamp(input.window.endInclusive);
  const issues = sourceIssues(input, start, end);
  const windowRows = start === undefined || end === undefined || start > end
    ? []
    : input.preview.rows.filter((row) => {
      const timestamp = parseTimestamp(row[input.mapping.timestampField]);
      return timestamp !== undefined && timestamp >= start && timestamp <= end;
    });
  const sourceFingerprint = createEvidenceFingerprint({
    dataset: sourceDatasetIdentity(input.dataset),
    previewDataset: sourceDatasetIdentity(input.preview.dataset),
    mapping: input.mapping,
    window: input.window,
    rows: windowRows.map((row) => mappedRow(row, input.mapping)),
  });
  const metrics = METRICS.map((definition) => assessMetric(
    definition,
    input.study,
    input.dataset,
    input.mapping[definition.key],
    windowRows,
    minimumSamples,
    issues,
  ));
  const status = overallStatus(metrics);
  const evidenceBase = {
    status,
    study: {
      id: input.study.id,
      inputFingerprint: input.study.inputFingerprint,
      modelFingerprint: input.study.modelFingerprint ?? null,
    },
    source: {
      datasetId: input.dataset.id,
      datasetName: input.dataset.name,
      connectionId: input.dataset.connectionId,
      datasetUpdatedAt: input.dataset.updatedAt,
      previewDurationMs: input.preview.durationMs,
      previewRowCount: input.preview.rows.length,
      windowRowCount: windowRows.length,
      snapshotFingerprint: sourceFingerprint,
      fingerprintAlgorithm: EVIDENCE_FINGERPRINT_ALGORITHM,
    },
    mapping: structuredClone(input.mapping),
    window: {
      startInclusive: start === undefined ? input.window.startInclusive : new Date(start).toISOString(),
      endInclusive: end === undefined ? input.window.endInclusive : new Date(end).toISOString(),
      minimumSamples,
    },
    metrics,
    issues,
    declaration: "现场数据仅用于验证本次仿真结果；未自动修改模型参数，预览样本也不代表数据集完整历史。",
  };
  return { ...evidenceBase, evidenceFingerprint: createEvidenceFingerprint(evidenceBase) };
}

function assessMetric(
  definition: (typeof METRICS)[number],
  study: PlantLiteStudyRecord,
  dataset: DataDatasetRecord,
  mapping: PlantLiteCalibrationMetricMapping,
  rows: Array<Record<string, unknown>>,
  minimumSamples: number,
  sourceProblems: string[],
): PlantLiteCalibrationMetricEvidence {
  const interval = definition.interval(study);
  const base = {
    key: definition.key,
    field: mapping.field,
    sourceUnit: mapping.unit,
    canonicalUnit: definition.canonicalUnit,
    tolerancePercent: mapping.tolerancePercent,
  };
  const values = rows
    .map((row) => canonicalMetricValue(definition.key, row[mapping.field], mapping.unit))
    .filter((value): value is number => value !== undefined && value >= 0);
  const counts = { sampleCount: values.length, rejectedSampleCount: Math.max(0, rows.length - values.length) };
  const mappingIssue = metricMappingIssue(definition.key, dataset, mapping);
  const intervalIssue = simulationIntervalIssue(study, interval);
  if (sourceProblems.length || mappingIssue || intervalIssue || values.length < minimumSamples) {
    const reason = sourceProblems[0] ?? mappingIssue ?? intervalIssue
      ?? `有效样本 ${values.length} 条，少于最低要求 ${minimumSamples} 条`;
    return { ...base, ...counts, status: "insufficient-data", reason };
  }
  const measuredMean = mean(values);
  const absoluteError = Math.abs(interval.mean - measuredMean);
  const relativeErrorPercent = measuredMean === 0
    ? interval.mean === 0 ? 0 : Number.POSITIVE_INFINITY
    : absoluteError / Math.abs(measuredMean) * 100;
  const tolerance = measuredMean * mapping.tolerancePercent / 100;
  const acceptedLower = measuredMean - tolerance;
  const acceptedUpper = measuredMean + tolerance;
  const status: PlantLiteCalibrationStatus = interval.lower95 >= acceptedLower && interval.upper95 <= acceptedUpper
    ? "passed"
    : intervalsOverlap(interval.lower95, interval.upper95, acceptedLower, acceptedUpper)
      ? "conditional"
      : "failed";
  const reason = status === "passed"
    ? "仿真 95% 区间完整落在实测容差带内"
    : status === "conditional"
      ? "均值超出容差，但仿真 95% 区间与实测容差带重叠"
      : "仿真 95% 区间与实测容差带不重叠";
  return {
    ...base,
    ...counts,
    measuredMean,
    simulatedMean: interval.mean,
    simulated95: { lower: interval.lower95, upper: interval.upper95, samples: interval.samples },
    absoluteError,
    relativeErrorPercent,
    status,
    reason,
  };
}

function sourceIssues(input: PlantLiteCalibrationInput, start: number | undefined, end: number | undefined): string[] {
  const issues: string[] = [];
  if (input.preview.dataset.id !== input.dataset.id) issues.push("预览数据与所选数据集不一致，请重新读取样本");
  if (input.preview.dataset.updatedAt !== input.dataset.updatedAt) issues.push("数据集定义已更新，请重新读取最新样本");
  if (!input.mapping.timestampField) issues.push("请选择时间字段");
  else if (!datasetHasField(input.dataset, input.mapping.timestampField)) issues.push("时间字段不属于所选数据集");
  if (start === undefined || end === undefined) issues.push("实测窗口时间无效");
  else if (start > end) issues.push("实测窗口开始时间不能晚于结束时间");
  return issues;
}

function metricMappingIssue(
  key: PlantLiteCalibrationMetricKey,
  dataset: DataDatasetRecord,
  mapping: PlantLiteCalibrationMetricMapping,
): string | undefined {
  if (!mapping.field) return "请选择实测字段";
  if (!datasetHasField(dataset, mapping.field)) return "实测字段不属于所选数据集";
  if (!unitAllowedForMetric(key, mapping.unit)) return "所选单位与指标不兼容";
  if (!Number.isFinite(mapping.tolerancePercent) || mapping.tolerancePercent <= 0 || mapping.tolerancePercent > 100) return "容差必须大于 0% 且不超过 100%";
  return undefined;
}

function simulationIntervalIssue(study: PlantLiteStudyRecord, interval: PlantLiteConfidenceInterval): string | undefined {
  if (study.outcome.status !== "completed") return "Study 尚未完成，不能生成校准结论";
  if (interval.samples < 2 || interval.samples !== study.outcome.completedReplications) return "Study 统计样本不完整";
  if (![interval.mean, interval.lower95, interval.upper95].every(Number.isFinite)) return "Study 统计区间无效";
  return undefined;
}

function canonicalMetricValue(key: PlantLiteCalibrationMetricKey, raw: unknown, unit: PlantLiteCalibrationUnit): number | undefined {
  if (raw === null || raw === "" || typeof raw === "boolean") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !unitAllowedForMetric(key, unit)) return undefined;
  if (key === "throughputPerHour") return value * ({ "item-per-hour": 1, "item-per-minute": 60, "item-per-second": 3600 } as const)[unit as "item-per-hour" | "item-per-minute" | "item-per-second"];
  if (key === "averageLeadTimeMinutes") return value * ({ minute: 1, second: 1 / 60, hour: 60 } as const)[unit as "minute" | "second" | "hour"];
  return value;
}

function unitAllowedForMetric(key: PlantLiteCalibrationMetricKey, unit: PlantLiteCalibrationUnit): boolean {
  if (key === "throughputPerHour") return unit === "item-per-hour" || unit === "item-per-minute" || unit === "item-per-second";
  if (key === "averageLeadTimeMinutes") return unit === "minute" || unit === "second" || unit === "hour";
  return unit === "item";
}

function mappedRow(row: Record<string, unknown>, mapping: PlantLiteCalibrationMapping): Record<string, unknown> {
  return {
    timestamp: row[mapping.timestampField],
    throughputPerHour: row[mapping.throughputPerHour.field],
    averageWip: row[mapping.averageWip.field],
    averageLeadTimeMinutes: row[mapping.averageLeadTimeMinutes.field],
  };
}

function sourceDatasetIdentity(dataset: DataDatasetRecord): Record<string, unknown> {
  return {
    id: dataset.id,
    connectionId: dataset.connectionId,
    updatedAt: dataset.updatedAt,
    sourceKey: dataset.sourceKey ?? null,
    query: dataset.query ?? null,
    fields: dataset.fields,
    computedFields: dataset.computedFields ?? [],
  };
}

function datasetHasField(dataset: DataDatasetRecord, key: string): boolean {
  return dataset.fields.some((field) => field.key === key)
    || (dataset.computedFields ?? []).some((field) => field.key === key);
}

function parseTimestamp(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw >= 1e12) return raw;
    if (raw >= 1e9) return raw * 1000;
    return undefined;
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeMinimumSamples(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(10_000, Math.max(2, Math.floor(value!)));
}

function intervalsOverlap(leftLower: number, leftUpper: number, rightLower: number, rightUpper: number): boolean {
  return Math.max(leftLower, rightLower) <= Math.min(leftUpper, rightUpper);
}

function overallStatus(metrics: PlantLiteCalibrationMetricEvidence[]): PlantLiteCalibrationStatus {
  if (metrics.some((metric) => metric.status === "insufficient-data")) return "insufficient-data";
  if (metrics.some((metric) => metric.status === "failed")) return "failed";
  if (metrics.some((metric) => metric.status === "conditional")) return "conditional";
  return "passed";
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
