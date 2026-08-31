import type { AiDataBinding } from "@bim-studio/contracts";
import type { AiDatasetSnapshot } from "./aiDatasetSource.js";

export interface PreparedAiBindingSnapshot {
  records: Array<Record<string, string | number>>;
  numericRows: Array<Record<string, number>>;
}

/**
 * 在能力调用前统一执行实体筛选、时间排序、窗口裁剪、质量校验与字段换算。
 * 模型只接收映射后的字段，避免每个插件重复猜测工业数据含义。
 */
export function prepareAiBindingSnapshot(
  binding: AiDataBinding,
  snapshot: AiDatasetSnapshot,
  now = Date.now(),
): PreparedAiBindingSnapshot {
  let records = filterEntities(binding, snapshot.records);
  records = orderByTime(binding, records);
  records = applyDurationWindow(binding, records);
  if (binding.window.rows) records = records.slice(-binding.window.rows);

  validateQuality(binding, records, now);
  const mappedRecords = records.map((record) => mapRecord(binding, record));
  return { records: mappedRecords, numericRows: mappedRecords.map(toNumericRow) };
}

function filterEntities(
  binding: AiDataBinding,
  records: Array<Record<string, string | number>>,
): Array<Record<string, string | number>> {
  const selected = binding.entity?.selectedKeys;
  if (!binding.entity || !selected?.length) return [...records];
  const accepted = new Set(selected.map(String));
  return records.filter((record) => accepted.has(String(record[binding.entity!.keyField] ?? "")));
}

function orderByTime(
  binding: AiDataBinding,
  records: Array<Record<string, string | number>>,
): Array<Record<string, string | number>> {
  if (!binding.time) return records;
  const direction = binding.time.order === "desc" ? -1 : 1;
  return [...records].sort((left, right) => direction * (timestamp(left[binding.time!.field]) - timestamp(right[binding.time!.field])));
}

function applyDurationWindow(
  binding: AiDataBinding,
  records: Array<Record<string, string | number>>,
): Array<Record<string, string | number>> {
  if (!binding.time || !binding.window.durationSeconds || records.length === 0) return records;
  const latest = Math.max(...records.map((record) => timestamp(record[binding.time!.field])).filter(Number.isFinite));
  if (!Number.isFinite(latest)) return records;
  const earliest = latest - binding.window.durationSeconds * 1_000;
  return records.filter((record) => timestamp(record[binding.time!.field]) >= earliest);
}

function validateQuality(binding: AiDataBinding, records: Array<Record<string, string | number>>, now: number): void {
  if (records.length < binding.quality.minimumSamples) {
    throw new Error(`有效样本不足：${records.length}/${binding.quality.minimumSamples}`);
  }
  const requiredFields = binding.features.filter((feature) => feature.required).map((feature) => feature.sourceField);
  if (requiredFields.length > 0) {
    const missing = records.reduce(
      (count, record) => count + requiredFields.filter((field) => isMissing(record[field])).length,
      0,
    );
    const missingRate = missing / (records.length * requiredFields.length);
    if (missingRate > binding.quality.maximumMissingRate) {
      throw new Error(`必需字段缺失率 ${(missingRate * 100).toFixed(1)}%，超过门限 ${(binding.quality.maximumMissingRate * 100).toFixed(1)}%`);
    }
  }
  if (binding.time) {
    const latest = Math.max(...records.map((record) => timestamp(record[binding.time!.field])).filter(Number.isFinite));
    if (Number.isFinite(latest)) {
      const ageSeconds = (now - latest) / 1_000;
      if (ageSeconds > binding.quality.maxAgeSeconds) throw new Error(`数据已过期 ${Math.round(ageSeconds)} 秒`);
    }
  }
}

function mapRecord(binding: AiDataBinding, record: Record<string, string | number>): Record<string, string | number> {
  if (binding.features.length === 0) return { ...record };
  const mapped: Record<string, string | number> = {};
  for (const feature of binding.features) {
    const source = record[feature.sourceField];
    if (source === undefined || source === "") continue;
    if (typeof source === "number") {
      mapped[feature.modelField] = source * (feature.scale ?? 1) + (feature.offset ?? 0);
    } else {
      mapped[feature.modelField] = source;
    }
  }
  return mapped;
}

function toNumericRow(record: Record<string, string | number>): Record<string, number> {
  const row: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) row[key] = number;
  }
  return row;
}

function timestamp(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1_000 : value;
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isMissing(value: string | number | undefined): boolean {
  return value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value));
}
