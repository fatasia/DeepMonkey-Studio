import type { BatteryPredictionInput } from "./batteryModelGateway.js";
import type { BatteryMformerModelMetadata, PreparedBatteryMformerInput } from "./batteryMformerPreprocessing.js";

export type BatteryMformerConditionMode = "exact-batterylife" | "centroid";

/** 将归一化 SOH 轨迹还原为产品 RUL，并保留观测锚定、单调修正和右删失语义。 */
export function completeBatteryMformerPrediction(
  normalized: readonly number[],
  input: BatteryPredictionInput,
  prepared: PreparedBatteryMformerInput,
  model: BatteryMformerModelMetadata,
  conditionMode: BatteryMformerConditionMode,
  modelVersion: string,
): Record<string, unknown> {
  if (normalized.length !== model.predictionLength || normalized.some((value) => !Number.isFinite(value))) {
    throw new Error(`BatteryMFormer ONNX 输出应为 ${model.predictionLength} 个有限轨迹点`);
  }
  const trajectory = normalized.map((value) => value * (1 - model.eolThreshold) + model.eolThreshold);
  const observed = [...prepared.observedSohFull];
  const cycleNumbers = [...prepared.observedCycleNumbers];
  if (cycleNumbers.length > 0 && Math.min(...cycleNumbers) === 0) {
    for (let index = 0; index < cycleNumbers.length; index += 1) cycleNumbers[index] = cycleNumbers[index]! + 1;
  }
  const valid = cycleNumbers.map((cycle, index) => Number.isFinite(observed[index]) && cycle >= 1 && cycle <= trajectory.length);
  const validSoh = observed.filter((_, index) => valid[index]);
  const validCycles = cycleNumbers.filter((_, index) => valid[index]);
  if (validSoh.length === 0) throw new Error("BatteryMFormer 观测循环全部超出模型轨迹范围");
  const observedCycles = validCycles.length > 0 ? Math.max(...validCycles) : prepared.observedCycles;
  if (validCycles.length > 0) {
    for (let cycle = 1; cycle <= observedCycles; cycle += 1) trajectory[cycle - 1] = interpolate(cycle, validCycles, validSoh);
  }
  if (observedCycles > 0 && observedCycles < trajectory.length) {
    const offset = validSoh.at(-1)! - trajectory[observedCycles]!;
    let previous = Number.POSITIVE_INFINITY;
    for (let index = observedCycles; index < trajectory.length; index += 1) {
      previous = Math.min(previous, trajectory[index]! + offset);
      trajectory[index] = previous;
    }
  }
  for (let index = 0; index < trajectory.length; index += 1) trajectory[index] = clamp(trajectory[index]!, 0, 1.2);

  const targetThreshold = (input.targetCapacityRetention ?? 80) / 100;
  const crossing = trajectory.findIndex((value) => value <= targetThreshold);
  let predictedLife = crossing >= 0 ? crossing + 1 : trajectory.length;
  const hasCensorMarker = input.records.some((record) => [
    "rulEventObserved", "observedSurvivalCycles", "lifetimeLowerBoundCycles", "rulTargetSemantics",
  ].some((key) => key in record));
  const declaredEvent = input.records.some((record) => truthy(record.rulEventObserved));
  const declaredLowerBounds = input.records.flatMap((record) => ["observedSurvivalCycles", "lifetimeLowerBoundCycles"]
    .map((key) => positiveInteger(record[key])).filter((value): value is number => value !== undefined));
  const lifetimeLowerBound = Math.max(observedCycles, ...declaredLowerBounds);
  const rightCensored = hasCensorMarker && !declaredEvent;
  if (rightCensored) predictedLife = Math.max(predictedLife, lifetimeLowerBound);

  const step = Math.max(1, Math.floor(trajectory.length / 200));
  const sohCurve = trajectory.flatMap((soh, index) => index % step === 0
    ? [{ cycle: index + 1, soh: round(soh * 100, 3) }]
    : []);
  const gate = model.confidenceGate ?? {};
  const trainingDatasets = new Set(gate.training_datasets ?? []);
  const filePrefix = input.fileName.split("_")[0]?.replace("UL-PUR", "UL_PUR") ?? "";
  const recordDatasets = new Set(input.records.map((record) => String(record.sourceDataset ?? "")
    .trim().replaceAll("\\", "/").split("/").at(-1)?.replace("UL-PUR", "UL_PUR") ?? "").filter(Boolean));
  const coveredDataset = trainingDatasets.has(filePrefix) || [...recordDatasets].some((dataset) => trainingDatasets.has(dataset));
  const highConfidence = Boolean(gate.passed && conditionMode === "exact-batterylife" && coveredDataset);
  const domainAssessment = highConfidence
    ? { status: "supported" as const, reasons: [], metrics: { conditionMode, coveredDataset } }
    : {
        status: "indeterminate" as const,
        reasons: [conditionMode === "centroid"
          ? "未命中已批准工况嵌入，使用受控训练域质心"
          : "当前数据集不在正式 checkpoint 的已声明训练覆盖中"],
        metrics: { conditionMode, coveredDataset },
      };
  const warnings = [...prepared.warnings, "寿命由独立测试集验收的 SOH 轨迹过阈值估算，不使用未校准的寿命终点头。"];
  if (rightCensored) warnings.push(`该电芯在 ${lifetimeLowerBound} 圈仍未达到目标 SOH；真实寿命仅知大于等于该值，后续圈数是模型外推而非实测 EOL。`);
  if (conditionMode === "centroid") warnings.push("未提供目标电芯老化工况，使用 CALB 训练工况质心；跨工况结果仅作参考。");
  else if (gate.passed && !coveredDataset) warnings.push("目标电芯子集不在该扩充 checkpoint 的训练覆盖范围内，置信度降为中等。");
  if (crossing < 0) warnings.push("预测轨迹未在模型输出长度内达到目标 SOH 阈值。");
  return {
    predictedCycleLife: predictedLife,
    sohCurve,
    confidence: highConfidence ? "high" : gate.passed ? "medium" : "low",
    summary: rightCensored
      ? `该电芯已实测存活至少 ${lifetimeLowerBound} 圈；BatteryMFormer 对 ${Math.round(targetThreshold * 100)}% SOH 阈值的外推点估计约为 ${predictedLife} 圈。`
      : `BatteryMFormer 估算 ${Math.round(targetThreshold * 100)}% SOH 阈值寿命约为 ${predictedLife} 圈。`,
    rationale: [
      "使用正式 BatteryMFormer checkpoint 导出的 FP32 ONNX 标准专家。",
      "输入包含早期循环电压、电流、容量、SOC以及库仑/能量效率。",
      "标准专家未加入物理损失；PINN 物理专家按正式物理风险路由独立执行。",
      "未来 SOH 轨迹以最后已观测 SOH 锚定；输出端执行统一的单调工程校正。",
      `运行时：ONNX Runtime CPU；工况嵌入：${conditionMode === "exact-batterylife" ? "精确匹配" : "CALB 质心回退"}。`,
    ],
    warnings,
    modelVersion,
    domainAssessment,
  };
}

function interpolate(value: number, sourceX: number[], sourceY: number[]): number {
  if (value <= sourceX[0]!) return sourceY[0]!;
  if (value >= sourceX.at(-1)!) return sourceY.at(-1)!;
  let right = 1;
  while (right < sourceX.length && sourceX[right]! < value) right += 1;
  const left = right - 1;
  const ratio = (value - sourceX[left]!) / Math.max(sourceX[right]! - sourceX[left]!, 1e-12);
  return sourceY[left]! * (1 - ratio) + sourceY[right]! * ratio;
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "y"].includes(String(value ?? "").trim().toLowerCase());
}

function positiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
