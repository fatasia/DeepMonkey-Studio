import type { PlantLiteModel, PlantLiteStudyRecord, StudyReport } from "@bim-studio/contracts";
import { buildStudyReport, renderStudyReportMarkdown } from "@bim-studio/plant-lite-simulation";

/** The saved Study is authoritative. No fabricated field-level result fingerprint or field-calibration claim. */
export function reportFromPlantLiteStudy(study: PlantLiteStudyRecord): StudyReport {
  if (study.outcome.status !== "completed" || !study.model || study.outcome.completedReplications < 2) {
    throw new Error("只有含完整模型且至少两次有效重复的已完成 Study 才能生成统计报告；请重新运行。");
  }
  const model: PlantLiteModel = study.model;
  const report = buildStudyReport({
    studyId: study.id,
    title: study.name,
    engineId: study.execution.engineId,
    engineVersion: study.execution.engineVersion,
    seed: study.seed,
    replications: study.outcome.completedReplications,
    generatedAt: study.createdAt,
    inputFingerprint: study.inputFingerprint || null,
    resultFingerprint: null,
    model: {
      nodeCount: model.nodes.length,
      resourceCount: model.resources?.length ?? 0,
      productTypeCount: model.productTypes?.length ?? 0,
      productionOrderCount: model.productionOrders?.length ?? 0,
    },
    experimentResult: {
      confidence95: {
        throughputPerHour: study.outcome.throughputPerHour,
        averageWip: study.outcome.averageWip,
        averageLeadTimeMinutes: study.outcome.averageLeadTimeMinutes,
      },
      bottlenecks: study.outcome.bottlenecks,
      measurementMinutes: study.execution.limits.durationMinutes - (study.execution.limits.warmupMinutes ?? 0),
      ...(study.outcome.energy ? { energy95: study.outcome.energy } : {}),
      ...(study.outcome.productionOrderMetrics95 ? { productionOrderMetrics95: study.outcome.productionOrderMetrics95 } : {}),
    },
    lineage: {
      baselineStudyId: study.comparison?.baselineStudyId ?? null,
      reproductionOf: study.reproductionOf ?? null,
    },
  });
  report.limitations.push("这里的“实测”仅表示 DES 仿真采样，不是现场测量；现场校核界面已有，但独立校准集尚缺，不得外推为生产认证结论。");
  report.limitations.push("持久化 Study 无独立结果指纹，报告明确标为缺失；输入指纹仅核对模型、seed 和执行输入，不证明现场精度。");
  if (model.id.endsWith("-flow-draft")) report.limitations.push("来源为 PPR 线性可编辑草稿；只表达已映射的顺序工序，不代表原工艺网络等价。非线性、条件、最小等待或复合资源无法映射时禁止正式预测。");
  if (study.trace?.truncated || !study.trace) report.limitations.push("轨迹缺失或有界截断；只根据完整 Study 的统计汇总生成指标，不将轨迹展示视作全量证据。");
  return report;
}

export function markdownFromPlantLiteStudy(study: PlantLiteStudyRecord): string {
  return renderStudyReportMarkdown(reportFromPlantLiteStudy(study));
}
