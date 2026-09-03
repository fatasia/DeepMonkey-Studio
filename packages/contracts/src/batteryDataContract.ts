import type { AiDataBindingFeature } from "./aiDataBinding.js";

export type BatteryPredictionModel = "socformer" | "bmsformer" | "batterymformer";

export interface BatteryContractField {
  key: string;
  label?: string;
  type?: string;
}

export interface BatteryContractMatch {
  modelField: string;
  sourceField: string;
  label: string;
  required: boolean;
  declaredType?: string;
}

export interface BatteryDataContractAssessment {
  model: BatteryPredictionModel;
  compatible: boolean;
  matches: BatteryContractMatch[];
  missing: string[];
  warnings: string[];
  runtimeCheck: string;
}

interface FieldDefinition {
  modelField: string;
  label: string;
  aliases: readonly string[];
}

const DEFINITIONS = {
  cycle: field("cycle", "循环编号", ["cycleIndex", "cycleId", "cycleNo", "循环", "循环次数", "循环编号", "圈次"]),
  time: field("time", "采样时间", ["timeS", "timeInS", "timestamp", "elapsedTime", "datetime", "采样时间", "时间", "时间戳"]),
  voltage: field("voltage", "电压", ["voltageV", "voltageInV", "cellVoltage", "terminalVoltage", "单体电压", "端电压", "电池电压", "电压"]),
  current: field("current", "电流", ["currentA", "currentInA", "cellCurrent", "packCurrent", "单体电流", "电池电流", "电流"]),
  temperature: field("temperature", "温度", ["temperatureC", "temperatureInC", "cellTemperature", "环境温度", "单体温度", "电池温度", "温度"]),
  capacity: field("capacityAh", "放电容量", ["dischargeCapacityAh", "dischargeCapacityInAh", "dischargeCapacity", "capacity", "容量", "放电容量", "可用容量"]),
  chargeCapacity: field("chargeCapacityAh", "充电容量", ["chargeCapacityInAh", "chargeCapacity", "充电容量"]),
  soh: field("soh", "SOH", ["stateOfHealth", "health", "健康度", "电池健康度"]),
  soc: field("soc", "SOC", ["stateOfCharge", "referenceSoc", "referenceSocPct", "荷电状态"]),
} as const;

/**
 * 只校验模型入口真正消费的字段，不把任意数值列误判为电池数据。
 * 样本数、循环完整度、数值范围仍由运行适配器基于实际记录校验。
 */
export function assessBatteryDataContract(
  model: BatteryPredictionModel,
  fields: readonly BatteryContractField[],
  options: { nominalCapacityProvided?: boolean } = {},
): BatteryDataContractAssessment {
  const found = new Map<keyof typeof DEFINITIONS, BatteryContractField>();
  for (const key of Object.keys(DEFINITIONS) as Array<keyof typeof DEFINITIONS>) {
    const match = findField(fields, DEFINITIONS[key]);
    if (match) found.set(key, match);
  }

  const required = model === "socformer"
    ? ["time", "voltage", "current"] as const
    : model === "bmsformer"
      ? ["cycle", "time", "voltage", "current"] as const
      : ["cycle", "time", "voltage", "current", "capacity", "chargeCapacity"] as const;
  const requiredKeys = new Set<keyof typeof DEFINITIONS>(required);
  const missing = required.filter((key) => !found.has(key)).map((key) => DEFINITIONS[key].label);

  if (model === "socformer" && !options.nominalCapacityProvided) missing.push("额定容量 Ah（参数）");
  if (model === "bmsformer" && !found.has("soh") && !found.has("capacity")) {
    missing.push("SOH 或放电容量");
  } else if (model === "bmsformer") {
    requiredKeys.add(found.has("soh") ? "soh" : "capacity");
  }

  const matches = [...found.entries()].map(([key, source]) => ({
    modelField: DEFINITIONS[key].modelField,
    sourceField: source.key,
    label: DEFINITIONS[key].label,
    required: requiredKeys.has(key),
    ...(source.type ? { declaredType: source.type } : {}),
  }));
  const warnings = matches
    .filter((match) => match.declaredType && match.declaredType !== "number")
    .map((match) => `${match.label}声明为${match.declaredType}，运行时将校验数值可解析性`);
  return {
    model,
    compatible: missing.length === 0,
    matches,
    missing,
    warnings,
    runtimeCheck: model === "socformer"
      ? "运行时继续校验连续时间序列、采样量和物理范围"
      : model === "bmsformer"
        ? "运行时继续校验有效循环数、充放电阶段和物理范围"
        : "运行时继续校验早期循环数及每圈完整充放电采样",
  };
}

export function batteryBindingFeatures(assessment: BatteryDataContractAssessment): AiDataBindingFeature[] {
  if (!assessment.compatible) throw new Error(batteryContractFailureMessage(assessment));
  return assessment.matches.map((match) => ({
    modelField: match.modelField,
    sourceField: match.sourceField,
    required: match.required,
  }));
}

export function normalizeBatteryRecords(
  records: Array<Record<string, string | number>>,
  assessment: BatteryDataContractAssessment,
): Array<Record<string, string | number>> {
  if (!assessment.compatible) throw new Error(batteryContractFailureMessage(assessment));
  return records.map((record) => {
    const normalized = { ...record };
    for (const match of assessment.matches) {
      const value = record[match.sourceField];
      if (value !== undefined && normalized[match.modelField] === undefined) normalized[match.modelField] = value;
    }
    return normalized;
  });
}

export function batteryContractFailureMessage(assessment: BatteryDataContractAssessment): string {
  return assessment.compatible ? "电池数据字段合同已通过" : `电池数据不满足模型合同，缺少：${assessment.missing.join("、")}`;
}

function field(modelField: string, label: string, aliases: readonly string[]): FieldDefinition {
  return { modelField, label, aliases: [modelField, ...aliases] };
}

function findField(fields: readonly BatteryContractField[], definition: FieldDefinition): BatteryContractField | undefined {
  const aliases = new Set(definition.aliases.map(normalizeName));
  return fields.find((candidate) => aliases.has(normalizeName(candidate.key)))
    ?? fields.find((candidate) => candidate.label && aliases.has(normalizeName(candidate.label)));
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s_\-./\\]/g, "");
}
