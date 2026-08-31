import type { BatteryPredictionInput } from "./batteryModelGateway.js";
import { assessNormalizedTensorDomain } from "./batteryInferenceGovernance.js";
import type { BatteryInputDomainEvidence } from "@bim-studio/contracts";

const LEGACY_FEATURES = ["log1p_ccct_4.16_4.17_s", "log1p_ccdt_3.8_3.4_s"] as const;
const MULTI_CHEMISTRY_FEATURES = [
  "observed_soh",
  "log1p_charge_duration_s",
  "log1p_discharge_duration_s",
  "log1p_relative_upper_charge_duration_s",
  "log1p_relative_mid_discharge_duration_s",
  "voltage_span_v",
] as const;

export interface BmsOnnxAdapterModel {
  windowSize: number;
  inputFeatures: number;
  featureNames: string[];
  featureMean: number[];
  featureStd: number[];
  chemistryScope: string[];
  chemistryMetrics?: Record<string, { passed?: boolean }>;
  confidenceGate?: { passed?: boolean };
}

export interface PreparedBmsInput {
  data: Float32Array;
  dimensions: [1, number, number];
  warnings: string[];
  nominalCapacityAh?: number;
  chemistry: string;
  domainAssessment: BatteryInputDomainEvidence;
}

interface CycleIndicator {
  chargeTime416417: number;
  dischargeTime380340: number;
  chargeDuration: number;
  dischargeDuration: number;
  relativeUpperChargeDuration: number;
  relativeMidDischargeDuration: number;
  voltageSpan: number;
  soh?: number;
}

/** 复刻正式 BMSFormer 的跨化学体系健康窗口，不把原始记录直接喂给裸模型。 */
export function prepareBmsOnnxInput(input: BatteryPredictionInput, model: BmsOnnxAdapterModel): PreparedBmsInput {
  const indicators = extractIndicators(input.records);
  const names = model.featureNames.length > 0 ? model.featureNames : [...LEGACY_FEATURES];
  const legacy = equalNames(names, LEGACY_FEATURES);
  if (!legacy && !equalNames(names, MULTI_CHEMISTRY_FEATURES)) {
    throw new Error(`不支持的 BMSFormer 特征定义：${names.join(", ")}`);
  }
  if (names.length !== model.inputFeatures || model.featureMean.length !== names.length || model.featureStd.length !== names.length) {
    throw new Error("BMSFormer 运行适配器的特征统计与模型维度不一致");
  }
  const usable = indicators.filter((item) => legacy
    ? item.chargeTime416417 > 0 || item.dischargeTime380340 > 0
    : item.soh !== undefined && (item.chargeDuration > 0 || item.dischargeDuration > 0));
  if (usable.length < model.windowSize) {
    throw new Error(`BMSFormer 至少需要 ${model.windowSize} 个有效循环；当前只有 ${usable.length} 个`);
  }

  const selected = usable.slice(-model.windowSize);
  const warnings: string[] = [];
  if (selected.some((item) => item.chargeDuration === 0 || item.dischargeDuration === 0)) {
    warnings.push("部分循环仅包含充电或放电健康指标，模型置信度已降低。");
  }
  const values = selected.flatMap((item) => {
    const row = legacy
      ? [Math.log1p(item.chargeTime416417), Math.log1p(item.dischargeTime380340)]
      : [
          item.soh!, Math.log1p(item.chargeDuration), Math.log1p(item.dischargeDuration),
          Math.log1p(item.relativeUpperChargeDuration), Math.log1p(item.relativeMidDischargeDuration), item.voltageSpan,
        ];
    return row.map((value, index) => (value - model.featureMean[index]!) / Math.max(Math.abs(model.featureStd[index]!), 1e-6));
  });
  const capacityValues = positiveValues(input.records, "capacityAh");
  const nominalValues = positiveValues(input.records, "nominalCapacityAh");
  const nominalCapacityAh = capacityValues.length > 0 ? Math.max(...capacityValues) : nominalValues[0];
  const data = Float32Array.from(values);
  const domainAssessment = assessNormalizedTensorDomain(data, "BMSFormer 归一化健康窗口");
  if (domainAssessment.status !== "supported") warnings.push(...domainAssessment.reasons);
  return {
    data,
    dimensions: [1, model.windowSize, model.inputFeatures],
    warnings,
    ...(nominalCapacityAh !== undefined ? { nominalCapacityAh } : {}),
    chemistry: inferChemistry(input),
    domainAssessment,
  };
}

export function completeBmsOnnxPrediction(
  rawSoh: number,
  prepared: PreparedBmsInput,
  model: BmsOnnxAdapterModel,
  modelVersion: string,
): Record<string, unknown> {
  if (!Number.isFinite(rawSoh)) throw new Error("BMSFormer ONNX 返回非有限 SOH");
  const currentSoh = round(clamp(rawSoh, 0, 1.2) * 100, 3);
  const chemistrySupported = model.chemistryScope.includes(prepared.chemistry);
  const chemistryGate = model.chemistryMetrics?.[prepared.chemistry];
  const domainPassed = !model.chemistryMetrics || Object.keys(model.chemistryMetrics).length === 0 || Boolean(chemistryGate?.passed);
  const warnings = [...prepared.warnings];
  if (!chemistrySupported || !domainPassed) warnings.push("当前化学体系尚未通过独立子域门槛，结果不会标为 High。");
  const confidence = model.confidenceGate?.passed && chemistrySupported && domainPassed
    && prepared.domainAssessment.status === "supported" && warnings.length === 0
    ? "high" : warnings.length === 0 ? "medium" : "low";
  const predictedCapacityAh = prepared.nominalCapacityAh === undefined
    ? null : round(prepared.nominalCapacityAh * currentSoh / 100, 4);
  return {
    currentSoh,
    predictedCapacityAh,
    confidence,
    summary: `BMSFormer 根据最近 ${model.windowSize} 个循环的跨化学体系健康指标估计当前 SOH 为 ${currentSoh.toFixed(2)}%。`,
    rationale: [
      "使用相对电压区间、充放电时长和历史可观测 SOH。",
      `化学体系：${prepared.chemistry.toUpperCase()}；对应子域门槛：${domainPassed ? "通过" : "未通过"}。`,
      "运行时：ONNX Runtime CPU；保留与正式 Python 适配器一致的前后处理。",
      ...(prepared.nominalCapacityAh === undefined ? [] : [`按 ${prepared.nominalCapacityAh.toPrecision(4)} Ah 首圈实测基准容量换算最新循环容量。`]),
    ],
    warnings,
    modelVersion,
    domainAssessment: prepared.domainAssessment,
  };
}

function extractIndicators(records: BatteryPredictionInput["records"]): CycleIndicator[] {
  const grouped = new Map<number, BatteryPredictionInput["records"]>();
  for (const record of records) {
    const cycle = finiteNumber(record.cycle);
    if (cycle === undefined || cycle < 0) continue;
    const key = Math.round(cycle);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  let firstCapacity: number | undefined;
  return [...grouped.entries()].sort(([left], [right]) => left - right).map(([, rows]) => {
    const capacities = rows.map((row) => finiteNumber(row.capacityAh));
    const capacity = [...capacities].reverse().find((value) => value !== undefined && value > 0);
    let soh = [...rows].reverse().map((row) => finiteNumber(row.soh)).find((value) => value !== undefined);
    if (firstCapacity === undefined && capacity !== undefined) firstCapacity = capacity;
    if (soh !== undefined && soh > 1.5) soh /= 100;
    if (soh === undefined && capacity !== undefined && firstCapacity) soh = capacity / firstCapacity;
    const generic = genericDurations(rows);
    return {
      chargeTime416417: durationInWindow(rows, 4.16, 4.17, 1),
      dischargeTime380340: durationInWindow(rows, 3.4, 3.8, -1),
      ...generic,
      ...(soh !== undefined ? { soh } : {}),
    };
  });
}

function genericDurations(rows: BatteryPredictionInput["records"]): Omit<CycleIndicator, "chargeTime416417" | "dischargeTime380340" | "soh"> {
  const voltages = rows.map((row) => finiteNumber(row.voltage)).filter((value): value is number => value !== undefined);
  if (voltages.length < 2) return { chargeDuration: 0, dischargeDuration: 0, relativeUpperChargeDuration: 0, relativeMidDischargeDuration: 0, voltageSpan: 0 };
  const low = Math.min(...voltages);
  const high = Math.max(...voltages);
  const span = Math.max(high - low, 1e-6);
  return {
    chargeDuration: durationInWindow(rows, low, high, 1),
    dischargeDuration: durationInWindow(rows, low, high, -1),
    relativeUpperChargeDuration: durationInWindow(rows, low + 0.75 * span, low + 0.95 * span, 1),
    relativeMidDischargeDuration: durationInWindow(rows, low + 0.2 * span, low + 0.6 * span, -1),
    voltageSpan: span,
  };
}

function durationInWindow(rows: BatteryPredictionInput["records"], low: number, high: number, direction: 1 | -1): number {
  const ordered = [...rows].sort((left, right) => (finiteNumber(left.time) ?? 0) - (finiteNumber(right.time) ?? 0));
  let duration = 0;
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const left = ordered[index]!;
    const right = ordered[index + 1]!;
    const values = [left.time, right.time, left.voltage, right.voltage, left.current, right.current].map(finiteNumber);
    if (values.some((value) => value === undefined)) continue;
    const [time0, time1, voltage0, voltage1, current0, current1] = values as [number, number, number, number, number, number];
    if (time1 <= time0 || (direction > 0 ? current0 <= 0 || current1 <= 0 : current0 >= 0 || current1 >= 0)) continue;
    const midpoint = (voltage0 + voltage1) / 2;
    if (midpoint >= low && midpoint <= high) duration += time1 - time0;
  }
  return duration;
}

export function inferChemistry(input: BatteryPredictionInput): string {
  if (input.chemistry) return input.chemistry;
  const dataset = String(input.records[0]?.sourceDataset ?? "");
  const text = `${dataset}/${input.fileName}`.toUpperCase();
  if (text.includes("NA-ION")) return "na-ion";
  if (text.includes("LFP") || ["HUST", "MATR"].includes(dataset)) return "lfp";
  return "ncm";
}

function positiveValues(records: BatteryPredictionInput["records"], field: string): number[] {
  return records.map((record) => finiteNumber(record[field])).filter((value): value is number => value !== undefined && value > 0);
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function equalNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
