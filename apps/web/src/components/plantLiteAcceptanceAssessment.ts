import type {
  PlantLiteAcceptanceTargets,
  PlantLiteConfidenceInterval,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";

export type PlantLiteAcceptanceStatus = "met" | "at-risk" | "not-met" | "insufficient-data";

export interface PlantLiteAcceptanceCheck {
  key: keyof Omit<PlantLiteAcceptanceTargets, "basis">;
  label: string;
  unit: string;
  direction: "minimum" | "maximum";
  target: number;
  interval?: PlantLiteConfidenceInterval;
  status: PlantLiteAcceptanceStatus;
  action: string;
}

export interface PlantLiteAcceptanceAssessment {
  status: PlantLiteAcceptanceStatus;
  basis?: string;
  checks: PlantLiteAcceptanceCheck[];
}

interface MetricDefinition {
  key: PlantLiteAcceptanceCheck["key"];
  label: string;
  unit: string;
  direction: PlantLiteAcceptanceCheck["direction"];
  interval: (study: PlantLiteStudyRecord) => PlantLiteConfidenceInterval | undefined;
  action: string;
}

const METRICS: MetricDefinition[] = [
  {
    key: "minimumThroughputPerHour", label: "吞吐", unit: "件/时", direction: "minimum",
    interval: (study) => study.outcome.throughputPerHour,
    action: "优先验证首要瓶颈的节拍、并行能力与搬运资源。",
  },
  {
    key: "maximumAverageWip", label: "平均 WIP", unit: "件", direction: "maximum",
    interval: (study) => study.outcome.averageWip,
    action: "检查投放节拍、阻塞点与缓冲容量，避免用堆积掩盖产能问题。",
  },
  {
    key: "maximumAverageLeadTimeMinutes", label: "平均交付周期", unit: "分钟", direction: "maximum",
    interval: (study) => study.outcome.averageLeadTimeMinutes,
    action: "缩短瓶颈队列与等待时间，并复核运行班次是否造成跨班等待。",
  },
  {
    key: "maximumEnergyPerCompletedItemKwh", label: "单位能耗", unit: "kWh/件", direction: "maximum",
    interval: (study) => study.outcome.energy?.energyPerCompletedItemKwh,
    action: "先补齐设备功率证据，再比较节拍、待机与关停策略。",
  },
  {
    key: "maximumElectricityCostPerCompletedItem", label: "单位电费", unit: "元/件", direction: "maximum",
    interval: (study) => study.outcome.energy?.electricityCostPerCompletedItem,
    action: "复核项目电价口径，并降低无产出时段的待机电耗。",
  },
  {
    key: "maximumCarbonEmissionPerCompletedItemKg", label: "单位碳排", unit: "kgCO₂e/件", direction: "maximum",
    interval: (study) => study.outcome.energy?.carbonEmissionPerCompletedItemKg,
    action: "复核排放因子口径，并优先处理单位能耗最高的消费者。",
  },
];

export function assessPlantLiteAcceptance(study: PlantLiteStudyRecord): PlantLiteAcceptanceAssessment | undefined {
  const targets = study.acceptanceTargets;
  if (!targets) return undefined;
  const checks = METRICS.flatMap((metric) => {
    const target = targets[metric.key];
    if (typeof target !== "number") return [];
    const interval = metric.interval(study);
    return [{
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      direction: metric.direction,
      target,
      ...(interval ? { interval } : {}),
      status: assessInterval(study, interval, target, metric.direction),
      action: metric.action,
    } satisfies PlantLiteAcceptanceCheck];
  });
  if (!checks.length) return undefined;
  return { status: overallStatus(checks), ...(targets.basis ? { basis: targets.basis } : {}), checks };
}

function assessInterval(
  study: PlantLiteStudyRecord,
  interval: PlantLiteConfidenceInterval | undefined,
  target: number,
  direction: PlantLiteAcceptanceCheck["direction"],
): PlantLiteAcceptanceStatus {
  if (study.outcome.status !== "completed" || !interval || interval.samples < 2
    || interval.samples !== study.outcome.completedReplications
    || !Number.isFinite(interval.lower95) || !Number.isFinite(interval.upper95)) return "insufficient-data";
  if (direction === "minimum") {
    if (interval.lower95 >= target) return "met";
    if (interval.upper95 < target) return "not-met";
    return "at-risk";
  }
  if (interval.upper95 <= target) return "met";
  if (interval.lower95 > target) return "not-met";
  return "at-risk";
}

function overallStatus(checks: PlantLiteAcceptanceCheck[]): PlantLiteAcceptanceStatus {
  if (checks.some((check) => check.status === "not-met")) return "not-met";
  if (checks.some((check) => check.status === "insufficient-data")) return "insufficient-data";
  if (checks.some((check) => check.status === "at-risk")) return "at-risk";
  return "met";
}
