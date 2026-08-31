import type { BatteryPredictionInput } from "./batteryModelGateway.js";
import { inferChemistry } from "./batteryBmsOnnxAdapter.js";
import { assessNormalizedTensorDomain } from "./batteryInferenceGovernance.js";
import type { BatteryInputDomainEvidence } from "@bim-studio/contracts";

const SOC_FEATURE_NAMES = [
  "normalized_voltage", "c_rate", "temperature_c", "phase",
  "coulomb_soc_anchor", "delta_time_s", "is_lfp",
] as const;

export interface SocOnnxAdapterModel {
  windowSize: number;
  inputFeatures: number;
  featureNames: string[];
  featureMean: number[];
  featureStd: number[];
  deepCorrectionWeight: number;
  chemistryScope: string[];
  chemistryMetrics?: Record<string, { passed?: boolean }>;
  confidenceGate?: { passed?: boolean; max_test_mae?: number };
  testMae?: number;
}

export interface PreparedSocInput {
  data: Float32Array;
  dimensions: [number, number, number];
  features: number[][];
  physicalAnchors: number[];
  anchorMode: "cumulative-capacity" | "coulomb-integration" | "legacy";
  integrationCapacityAh: number;
  usedObservedCapacity: boolean;
  chemistry: string;
  records: BatteryPredictionInput["records"];
  domainAssessment: BatteryInputDomainEvidence;
}

/** 构造与正式 SOCFormer v2 一致的窗口、安时积分锚和标准化张量。 */
export function prepareSocOnnxInput(input: BatteryPredictionInput, model: SocOnnxAdapterModel): PreparedSocInput {
  if (input.records.length < 2) throw new Error("SOCFormer 至少需要 2 条连续采样记录");
  const nominal = input.nominalCapacityAh ?? 0;
  if (!Number.isFinite(nominal) || nominal <= 0) throw new Error("SOCFormer ONNX 需要有效标称容量");
  if (model.featureMean.length !== model.inputFeatures || model.featureStd.length !== model.inputFeatures) {
    throw new Error("SOCFormer 运行适配器的特征统计与模型维度不一致");
  }

  const currentFeatures = equalNames(model.featureNames, SOC_FEATURE_NAMES);
  if (!currentFeatures && model.inputFeatures !== 4) throw new Error(`不支持的 SOCFormer 特征定义：${model.featureNames.join(", ")}`);
  const observedCapacity = maximumNumber(input.records, ["capacityAh", "discharge_capacity_in_Ah", "dischargeCapacityAh"]);
  const usedObservedCapacity = observedCapacity !== undefined && observedCapacity >= nominal * 0.5 && observedCapacity <= nominal * 1.3;
  const integrationCapacityAh = usedObservedCapacity ? observedCapacity! : nominal;
  const chemistry = inferChemistry(input);
  const features = currentFeatures
    ? sequenceFeatures(input.records, nominal, chemistry, integrationCapacityAh)
    : input.records.map((record) => legacyPointFeatures(record, nominal));
  const windows = leftPaddedWindows(features, model.windowSize);
  const data = Float32Array.from(windows.flat(2).map((value, flatIndex) => {
    const featureIndex = flatIndex % model.inputFeatures;
    return (value - model.featureMean[featureIndex]!) / Math.max(Math.abs(model.featureStd[featureIndex]!), 1e-6);
  }));
  const domainAssessment = assessNormalizedTensorDomain(data, "SOCFormer 归一化时序窗口");
  const capacityAnchors = currentFeatures ? capacitySocAnchors(input.records, integrationCapacityAh) : undefined;
  return {
    data,
    dimensions: [input.records.length, model.windowSize, model.inputFeatures],
    features,
    physicalAnchors: currentFeatures
      ? capacityAnchors ?? features.map((row) => row[4]! * 100)
      : [],
    anchorMode: !currentFeatures ? "legacy" : capacityAnchors ? "cumulative-capacity" : "coulomb-integration",
    integrationCapacityAh,
    usedObservedCapacity,
    chemistry,
    records: input.records,
    domainAssessment,
  };
}

export function completeSocOnnxPrediction(
  rawFractions: readonly number[],
  prepared: PreparedSocInput,
  model: SocOnnxAdapterModel,
  modelVersion: string,
): Record<string, unknown> {
  if (rawFractions.length !== prepared.records.length || rawFractions.some((value) => !Number.isFinite(value))) {
    throw new Error("SOCFormer ONNX 输出长度或数值无效");
  }
  const rawPercent = rawFractions.map((value) => clamp(value * 100, 0, 100));
  const weight = clamp(model.deepCorrectionWeight, 0, 1);
  const output = prepared.anchorMode === "legacy"
    ? rawPercent
    : rawPercent.map((value, index) => clamp(prepared.physicalAnchors[index]! * (1 - weight) + value * weight, 0, 100));
  const references: Array<[number, number]> = [];
  const points = prepared.records.map((record, index) => {
    const estimatedSoc = round(output[index]!, 3);
    const reference = numberFrom(record, ["referenceSoc", "reference_soc_pct", "soc"]);
    if (reference !== undefined) references.push([output[index]!, reference]);
    return {
      time: numberFrom(record, ["time", "time_s", "timestamp"]) ?? 0,
      current: numberFrom(record, ["current", "current_a"]) ?? 0,
      voltage: numberFrom(record, ["voltage", "voltage_v"]) ?? 0,
      temperature: numberFrom(record, ["temperature", "temperature_c"]) ?? 25,
      estimatedSoc,
      voltageSoc: estimatedSoc,
      ...(reference !== undefined ? { referenceSoc: reference } : {}),
    };
  });
  const mae = references.length > 0
    ? references.reduce((sum, [prediction, reference]) => sum + Math.abs(prediction - reference), 0) / references.length
    : undefined;
  const chemistrySupported = model.chemistryScope.includes(prepared.chemistry);
  const chemistryGate = model.chemistryMetrics?.[prepared.chemistry];
  const domainPassed = !model.chemistryMetrics || Object.keys(model.chemistryMetrics).length === 0 || Boolean(chemistryGate?.passed);
  const uploadLimit = (model.confidenceGate?.max_test_mae ?? 0.03) * 100;
  const uploadPassed = mae === undefined || mae <= uploadLimit;
  const passed = Boolean(model.confidenceGate?.passed);
  const highConfidence = passed && uploadPassed && chemistrySupported && domainPassed
    && prepared.domainAssessment.status === "supported";
  const warnings = !chemistrySupported || !domainPassed
    ? ["当前化学体系不在该 checkpoint 的 High 适用范围内。"]
    : passed && !uploadPassed
      ? ["当前文件的参考 SOC 误差超过 high 门槛。"]
      : passed ? [] : ["该 checkpoint 尚未通过 high 独立测试门槛。"];
  if (prepared.domainAssessment.status !== "supported") warnings.push(...prepared.domainAssessment.reasons);
  return {
    initialSoc: round(output[0]!, 3),
    finalSoc: round(output.at(-1)!, 3),
    minSoc: round(Math.min(...output), 3),
    maxSoc: round(Math.max(...output), 3),
    meanAbsError: mae === undefined ? null : round(mae, 3),
    points,
    confidence: highConfidence ? "high" : "medium",
    summary: `SOCFormer 以安时积分为主锚、深度网络为校正，对 ${prepared.records.length} 个连续采样点完成 SOC 混合估计。`,
    rationale: [
      "输入电压、倍率、温度与充放电相位的连续窗口。",
      `独立测试 MAE：${((model.testMae ?? 0) * 100).toFixed(2)} 个百分点。`,
      "运行时：ONNX Runtime CPU；保留与正式 Python 适配器一致的前后处理。",
      `化学体系：${prepared.chemistry.toUpperCase()}；对应子域门槛：${domainPassed ? "通过" : "未通过"}。`,
      `物理锚权重 ${((1 - weight) * 100).toFixed(0)}%，深度校正权重 ${(weight * 100).toFixed(0)}%；锚点来源：${prepared.anchorMode === "cumulative-capacity" ? "累计放电容量" : "安时积分"}。`,
      `容量采用${prepared.usedObservedCapacity ? "完整放电观测值" : "标称值"} ${prepared.integrationCapacityAh.toFixed(3)} Ah。`,
    ],
    warnings,
    modelVersion,
    domainAssessment: prepared.domainAssessment,
  };
}

function sequenceFeatures(
  records: BatteryPredictionInput["records"],
  nominal: number,
  chemistry: string,
  integrationCapacity: number,
): number[][] {
  const result: number[][] = [];
  let previousTime: number | undefined;
  let previousCurrent = 0;
  let previousPhase = 0;
  let throughput = 0;
  let anchor = 0.5;
  for (const record of records) {
    const current = numberFrom(record, ["current", "current_a", "current_in_A"]) ?? 0;
    const phase = current > nominal * 0.01 ? 1 : current < -nominal * 0.01 ? -1 : 0;
    const timestamp = numberFrom(record, ["time", "time_s", "time_in_s", "timestamp"]) ?? 0;
    const delta = previousTime === undefined ? 0 : Math.max(0, timestamp - previousTime);
    if (phase && phase !== previousPhase) {
      throughput = 0;
      anchor = phase > 0 ? 0 : 1;
    }
    if (phase && previousPhase === phase && delta > 0) {
      throughput += Math.abs((current + previousCurrent) * 0.5) * delta / 3600 / Math.max(integrationCapacity, 1e-6);
      anchor = phase > 0 ? throughput : 1 - throughput;
    }
    result.push(pointFeatures(record, nominal, chemistry, anchor, delta));
    previousTime = timestamp;
    previousCurrent = current;
    if (phase) previousPhase = phase;
  }
  return result;
}

function pointFeatures(record: BatteryPredictionInput["records"][number], nominal: number, chemistry: string, anchor: number, delta: number): number[] {
  const voltage = numberFrom(record, ["voltage", "voltage_v", "voltage_in_V"]) ?? 0;
  const current = numberFrom(record, ["current", "current_a", "current_in_A"]) ?? 0;
  const temperature = numberFrom(record, ["temperature", "temperature_c", "temperature_in_C"]) ?? 25;
  const cRate = current / Math.max(nominal, 1e-6);
  const phase = cRate > 0.01 ? 1 : cRate < -0.01 ? -1 : 0;
  const [low, high] = chemistry === "lfp" ? [2.5, 3.65] : [2.7, 4.25];
  return [clamp((voltage - low) / (high - low), -0.25, 1.25), cRate, temperature, phase, clamp(anchor, 0, 1), clamp(delta, 0, 3600), chemistry === "lfp" ? 1 : 0];
}

function legacyPointFeatures(record: BatteryPredictionInput["records"][number], nominal: number): number[] {
  const voltage = numberFrom(record, ["voltage", "voltage_v", "voltage_in_V"]) ?? 0;
  const current = numberFrom(record, ["current", "current_a", "current_in_A"]) ?? 0;
  const temperature = numberFrom(record, ["temperature", "temperature_c", "temperature_in_C"]) ?? 25;
  const cRate = current / Math.max(nominal, 1e-6);
  return [voltage, cRate, temperature, cRate > 0.01 ? 1 : cRate < -0.01 ? -1 : 0];
}

function leftPaddedWindows(features: number[][], windowSize: number): number[][][] {
  return features.map((_, end) => {
    const window = features.slice(Math.max(0, end - windowSize + 1), end + 1);
    return [...Array.from({ length: windowSize - window.length }, () => window[0]!), ...window];
  });
}

function capacitySocAnchors(records: BatteryPredictionInput["records"], capacity: number): number[] | undefined {
  if (capacity <= 0 || records.length < 2) return undefined;
  const discharge = records.map((record) => numberFrom(record, ["capacityAh", "discharge_capacity_in_Ah", "dischargeCapacityAh"]));
  const charge = records.map((record) => numberFrom(record, ["chargeCapacityAh", "charge_capacity_in_Ah"]));
  if (!discharge.every((value): value is number => value !== undefined && value >= 0 && value <= capacity * 1.05)) return undefined;
  const monotonic = discharge.slice(1).filter((value, index) => value + capacity * 1e-4 >= discharge[index]!).length / Math.max(1, discharge.length - 1);
  const dischargeSpan = Math.max(...discharge) - Math.min(...discharge);
  const validCharge = charge.every((value): value is number => value !== undefined && value >= 0 && value <= capacity * 1.05);
  const chargeSpan = validCharge ? Math.max(...charge) - Math.min(...charge) : 0;
  if (monotonic < 0.9 || Math.max(dischargeSpan, chargeSpan) < capacity * 0.5) return undefined;
  const currents = records.map((record) => numberFrom(record, ["current", "current_a", "current_in_A"]) ?? 0);
  const hasCurrent = records.some((record) => ["current", "current_a", "current_in_A"].some((key) => key in record));
  if (!hasCurrent) return discharge.map((value) => clamp((1 - value / capacity) * 100, 0, 100));
  let anchor = (currents.find((current) => Math.abs(current) > capacity * 0.005) ?? -1) > 0 ? 0 : 100;
  return currents.map((current, index) => {
    if (current > capacity * 0.005 && validCharge) anchor = charge[index]! / capacity * 100;
    else if (current < -capacity * 0.005) anchor = (1 - discharge[index]! / capacity) * 100;
    return clamp(anchor, 0, 100);
  });
}

function maximumNumber(records: BatteryPredictionInput["records"], names: string[]): number | undefined {
  const values = records.map((record) => numberFrom(record, names)).filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function numberFrom(record: BatteryPredictionInput["records"][number], names: string[]): number | undefined {
  for (const name of names) {
    const raw = record[name];
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
