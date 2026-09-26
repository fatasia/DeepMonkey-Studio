import type { PlantAnalyticsGanttAnalysis, PlantAnalyticsSankeyAnalysis } from "./plantAnalytics.js";

/**
 * 仿真实验报告生成与导出合同(Plant 平替的 Study 报告闭环)。
 * 报告是 Study 权威记录 + 实验结果摘要的只读投影:不复制求解器状态、不做 IO、不取时钟,
 * 因此生成是纯内存组装,同输入两次构建逐位一致;Markdown 渲染是纯函数,可直接落盘/下载。
 * PDF/Word 导出、服务端批量渲染、图表位图嵌入均不在本层合同内。
 */

/** 数值证据口径:measured = 仿真实测统计;estimated = 无轨迹估算,仅示意,禁止当实测宣示。 */
export type StudyReportProvenance = "measured" | "estimated";

/** 95% 置信区间(去掉与 value 重复的 mean);samples 为进入统计的已完成重复数。 */
export interface StudyReportCi95 {
  lower95: number;
  upper95: number;
  samples: number;
}

/** 报告中的单个数值;unit 与 ci95 按指标语义省略(如占比类以百分数呈现)。 */
export interface StudyReportKpi {
  key: string;
  label: string;
  value: number;
  unit?: string;
  ci95?: StudyReportCi95;
  provenance: StudyReportProvenance;
}

/** 实验结果摘要的置信区间口径(与内核 ConfidenceInterval 结构兼容,允许整只结果直接传入)。 */
export interface StudyReportConfidenceInterval {
  mean: number;
  lower95: number;
  upper95: number;
  samples: number;
}

/** 节点瓶颈频率(对位内核 BottleneckFrequency)。 */
export interface StudyReportBottleneckFrequency {
  nodeId: string;
  occurrences: number;
  probability: number;
}

/** 报告中的瓶颈条目:top-3,带口径标注。 */
export interface StudyReportBottleneck {
  nodeId: string;
  occurrences: number;
  probability: number;
  provenance: StudyReportProvenance;
}

/** 能耗 95% 区间组(模型配置能耗时存在;与内核 energy95 键位一致)。 */
export interface StudyReportEnergyIntervals {
  activeEnergyKwh: StudyReportConfidenceInterval;
  idleEnergyKwh: StudyReportConfidenceInterval;
  totalEnergyKwh: StudyReportConfidenceInterval;
  energyPerCompletedItemKwh: StudyReportConfidenceInterval;
  electricityCost: StudyReportConfidenceInterval;
  electricityCostPerCompletedItem: StudyReportConfidenceInterval;
  carbonEmissionKg: StudyReportConfidenceInterval;
  carbonEmissionPerCompletedItemKg: StudyReportConfidenceInterval;
  peakDemandKw: StudyReportConfidenceInterval;
  /** 工位或共享资源 ID -> 总电量区间。 */
  consumerEnergyKwh: Record<string, StudyReportConfidenceInterval>;
}

/** 单订单 95% 区间组(模型配置生产订单时存在;准交率以计划数量为分母)。 */
export interface StudyReportOrderIntervals {
  completedItems: StudyReportConfidenceInterval;
  completionRate: StudyReportConfidenceInterval;
  onTimeFulfillmentRate: StudyReportConfidenceInterval;
  fullyCompletedRate: StudyReportConfidenceInterval;
  observedTardinessMinutes: StudyReportConfidenceInterval;
}

/**
 * 实验结果摘要:报告构建所需的最小投影。
 * 传入整只 PlantLiteExperimentResult / PlantLiteStudyOutcome 均可(结构超集被忽略)。
 */
export interface StudyReportExperimentSummary {
  confidence95: {
    throughputPerHour: StudyReportConfidenceInterval;
    averageWip: StudyReportConfidenceInterval;
    averageLeadTimeMinutes: StudyReportConfidenceInterval;
  };
  bottlenecks: StudyReportBottleneckFrequency[];
  /** 仅在模型配置能耗时生成。 */
  energy95?: StudyReportEnergyIntervals;
  /** 仅在模型配置生产订单时生成;键为订单 ID。 */
  productionOrderMetrics95?: Record<string, StudyReportOrderIntervals>;
  /** 正式统计窗口分钟数(总时长减预热);用于 limitation 文案与报告头,缺省则用通用表述。 */
  measurementMinutes?: number;
}

/** 模型规模摘要(节点/资源数,附产品与订单计数)。 */
export interface StudyReportModelSummary {
  nodeCount: number;
  resourceCount: number;
  productTypeCount?: number;
  productionOrderCount?: number;
}

export interface StudyReportInput {
  studyId: string;
  title?: string;
  engineId: string;
  engineVersion: string;
  seed: string | number;
  replications: number;
  /** 调用方时钟;构建器不取时钟,保证同输入逐位一致。 */
  generatedAt: string;
  /** 运行记录指纹透传;旧记录允许为 null,报告中原样展示。 */
  inputFingerprint: string | null;
  resultFingerprint: string | null;
  /** 缺省由构建器按吞吐区间生成确定性 headline。 */
  headline?: string;
  experimentResult: StudyReportExperimentSummary;
  model: StudyReportModelSummary;
  /** 可选渲染数据层产物(contracts/plantAnalytics.ts),直接嵌入报告。 */
  analytics?: {
    sankey?: PlantAnalyticsSankeyAnalysis;
    gantt?: PlantAnalyticsGanttAnalysis;
  };
  lineage?: {
    baselineStudyId?: string | null;
    reproductionOf?: string | null;
  };
}

/** 订单行:比率以百分数呈现(0-100),拖期单位分钟。 */
export interface StudyReportOrderRow {
  orderId: string;
  completionRate: StudyReportKpi;
  onTimeFulfillmentRate: StudyReportKpi;
  fullyCompletedRate: StudyReportKpi;
  observedTardinessMinutes: StudyReportKpi;
}

/** 能耗分节:主 KPI 表收录汇总四项,分节保留完整能耗经济账。 */
export interface StudyReportEnergy {
  activeEnergyKwh: StudyReportKpi;
  idleEnergyKwh: StudyReportKpi;
  totalEnergyKwh: StudyReportKpi;
  energyPerCompletedItemKwh: StudyReportKpi;
  electricityCost: StudyReportKpi;
  electricityCostPerCompletedItem: StudyReportKpi;
  carbonEmissionKg: StudyReportKpi;
  carbonEmissionPerCompletedItemKg: StudyReportKpi;
  peakDemandKw: StudyReportKpi;
  /** 按 consumerId 升序,保证渲染确定性。 */
  consumerEnergyKwh: Array<{ consumerId: string; energyKwh: StudyReportKpi }>;
}

export interface StudyReport {
  meta: {
    studyId: string;
    engineId: string;
    engineVersion: string;
    seed: string | number;
    replications: number;
    generatedAt: string;
    inputFingerprint: string | null;
    resultFingerprint: string | null;
  };
  title?: string;
  headline: string;
  model: StudyReportModelSummary;
  /** 主 KPI 表:吞吐/WIP/交付周期 + 能耗汇总(如有)+ 订单准交率(如有),顺序固定。 */
  kpis: StudyReportKpi[];
  /** top-3 瓶颈(按频次降序,节点 ID 升序破平)。 */
  bottlenecks: StudyReportBottleneck[];
  energy?: StudyReportEnergy;
  orders?: StudyReportOrderRow[];
  sankey?: PlantAnalyticsSankeyAnalysis;
  gantt?: PlantAnalyticsGanttAnalysis;
  lineage: {
    baselineStudyId?: string | null;
    reproductionOf?: string | null;
  };
  /** 固定四条:置信区间口径、预热窗口、estimated 模式标注、非认证结论声明。 */
  limitations: string[];
  /** 报告级口径:存在任一 estimated 成分(Sankey/Gantt)即为 estimated,否则 measured。 */
  provenance: StudyReportProvenance;
}
