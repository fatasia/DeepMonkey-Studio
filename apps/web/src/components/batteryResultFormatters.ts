import type { BatteryTask } from "./batteryIntelligenceConfig";

export interface BatteryMetric {
  label: string;
  value: string;
}

export function resultMetrics(task: BatteryTask, result: Record<string, unknown>): BatteryMetric[] {
  if (task === "soc") {
    return [
      metric("当前 SOC", result.finalSoc, "%"),
      metric("最低 SOC", result.minSoc, "%"),
      metric("最高 SOC", result.maxSoc, "%"),
    ].filter(hasMetric);
  }
  if (task === "soh") {
    const pack = objectValue(objectValue(result.dataProfile)?.packAssessment);
    if (pack) return [
      metric("Pack 平均 SOH", pack.meanSohPct, "%"),
      metric("最弱电芯 SOH", pack.weakestSohPct, "%"),
      metric("SOH 极差", pack.sohSpreadPct, "%"),
    ].filter(hasMetric);
    return [
      metric("当前 SOH", result.currentSoh, "%"),
      metric("估计容量", result.predictedCapacityAh, " Ah"),
    ].filter(hasMetric);
  }
  const observation = objectValue(result.rulObservation);
  return [
    metric("预计寿命", result.predictedCycleLife, " 圈", 0),
    metric("已观测下限", observation?.lifetimeLowerBoundCycles, " 圈", 0),
  ].filter(hasMetric);
}

export function resultSummary(task: BatteryTask, result: Record<string, unknown>): string | undefined {
  const pack = objectValue(objectValue(result.dataProfile)?.packAssessment);
  if (task === "soh" && pack) {
    const cells = typeof pack.assessedCells === "number" ? pack.assessedCells.toFixed(0) : "多";
    const weakest = String(pack.weakestCellId ?? "最弱电芯");
    const spread = typeof pack.sohSpreadPct === "number" ? pack.sohSpreadPct.toFixed(1) : "—";
    return `已聚合 ${cells} 个电芯的末圈健康状态；${weakest} 为当前短板，SOH 极差 ${spread}%。`;
  }
  return typeof result.summary === "string" ? result.summary : undefined;
}

export function hasMetric(item: { value: string }) {
  return Boolean(item.value);
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function confidenceLabel(value: unknown) {
  if (value === "high") return "高置信";
  if (value === "medium") return "中等置信";
  if (value === "low") return "低置信";
  return "已完成";
}

export function runtimeLabel(runtime: Record<string, unknown>) {
  if (runtime.actual === "onnx") return "ONNX 本地推理";
  if (runtime.fellBack) return "已切换兼容运行时";
  return "外置模型运行时";
}

export function expertRoutingLabel(routing: Record<string, unknown>) {
  const expert = routing.selectedExpert === "pinn" ? "PINN 物理专家" : "标准寿命专家";
  return `正式路由 · ${expert}`;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metric(label: string, value: unknown, suffix: string, digits = 2): BatteryMetric {
  return {
    label,
    value: typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "",
  };
}
