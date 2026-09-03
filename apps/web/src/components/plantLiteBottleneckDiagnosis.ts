import type { PlantLiteStudyRecord } from "@bim-studio/contracts";

export type PlantLiteBottleneckClass =
  | "upstream-starved"
  | "downstream-blocked"
  | "buffer-balance"
  | "transport-capacity"
  | "process-capacity";

export interface PlantLiteBottleneckDiagnosis {
  nodeName: string;
  probability: number;
  classification: PlantLiteBottleneckClass;
  evidence: string;
  action: string;
}

/**
 * Converts the saved DES state-loss evidence into an operator-facing next step.
 * This is a deterministic diagnostic, not a causal or optimization claim.
 */
export function diagnosePlantLiteBottleneck(study: PlantLiteStudyRecord): PlantLiteBottleneckDiagnosis | undefined {
  const bottleneck = study.outcome.bottlenecks[0];
  if (!bottleneck) return undefined;
  const node = study.model?.nodes.find((candidate) => candidate.id === bottleneck.nodeId);
  const metric = study.outcome.nodeMetrics95?.[bottleneck.nodeId];
  const nodeName = node?.name ?? bottleneck.nodeId;
  const formalWindow = Math.max(1, study.execution.limits.durationMinutes - (study.execution.limits.warmupMinutes ?? 0));
  const blocked = metric?.blockedMinutes.mean ?? 0;
  const starved = metric?.starvedMinutes.mean ?? 0;
  const utilization = metric?.utilization.mean;
  const meaningfulLoss = formalWindow * .05;
  const evidence = metric
    ? `正式窗口平均阻塞 ${formatMinutes(blocked)}、缺料 ${formatMinutes(starved)}${utilization === undefined ? "" : `、利用率 ${formatPercent(utilization)}`}`
    : "旧记录缺少阻塞与缺料时间证据";

  if (blocked >= meaningfulLoss && blocked > starved * 1.25) {
    return {
      nodeName, probability: bottleneck.probability, classification: "downstream-blocked", evidence,
      action: "优先检查下游工位、搬运与缓冲约束，避免直接给当前节点加产能。",
    };
  }
  if (starved >= meaningfulLoss && starved > blocked * 1.25) {
    return {
      nodeName, probability: bottleneck.probability, classification: "upstream-starved", evidence,
      action: "优先检查前序供料、搬运与班次可用性，再评估当前节点扩容。",
    };
  }
  if (node?.kind === "buffer" || node?.kind === "queue-buffer") {
    return {
      nodeName, probability: bottleneck.probability, classification: "buffer-balance", evidence,
      action: "用缓冲区单变量实验比较扩大缓冲容量或平衡上下游节拍后的方案，同时验证减容候选，不能只扩大库存。",
    };
  }
  if (node?.kind === "transport") {
    return {
      nodeName, probability: bottleneck.probability, classification: "transport-capacity", evidence,
      action: "比较车辆数、搬运耗时与可靠性方案，并核对充电和拥堵假设。",
    };
  }
  return {
    nodeName, probability: bottleneck.probability, classification: "process-capacity", evidence,
    action: "比较加工节拍与并行工位方案；区间重叠时保持为候选，不直接宣称改善。",
  };
}

export function plantLiteBottleneckClassLabel(value: PlantLiteBottleneckClass): string {
  return ({
    "upstream-starved": "上游缺料",
    "downstream-blocked": "下游阻塞",
    "buffer-balance": "缓冲失衡",
    "transport-capacity": "搬运能力",
    "process-capacity": "加工能力",
  })[value];
}

function formatMinutes(value: number): string {
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")} 分钟`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
