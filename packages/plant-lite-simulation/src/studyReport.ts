/**
 * 仿真实验报告生成(Plant 平替 Study 报告闭环;合同见 contracts/studyReport.ts)。
 * buildStudyReport:纯内存组装——无 IO、无时钟、无随机,生成耗时与仿真规模无关(P95 可测);
 * renderStudyReportMarkdown:纯函数产 Markdown(表格 + 指纹 + limitations),可直接落盘/下载。
 * 不做 PDF/Word 导出、服务端批量渲染与图表位图嵌入;Markdown + JSON 已支撑下载与展示。
 */

import { compareText } from "./textOrder.js";
import {
  type StudyReport,
  type StudyReportBottleneck,
  type StudyReportConfidenceInterval,
  type StudyReportEnergy,
  type StudyReportEnergyIntervals,
  type StudyReportExperimentSummary,
  type StudyReportInput,
  type StudyReportKpi,
  type StudyReportOrderIntervals,
  type StudyReportOrderRow,
} from "@bim-studio/contracts";

/** 从实验结果摘要 + 模型摘要 + 可选分析组装报告;同输入两次构建逐位一致。 */
export function buildStudyReport(input: StudyReportInput): StudyReport {
  if (!Number.isSafeInteger(input.replications) || input.replications < 1) {
    throw new RangeError(`replications 必须为正整数,收到 ${input.replications}`);
  }
  const summary = input.experimentResult;
  if (summary.confidence95.throughputPerHour.samples < 1) {
    throw new Error("实验结果没有已完成的 replication,无法生成报告(insufficient-data)");
  }
  const estimatedParts: string[] = [];
  if (input.analytics?.sankey?.estimated) estimatedParts.push("物料流(Sankey)");
  if (input.analytics?.gantt?.rows.some((row) => row.estimated)) estimatedParts.push("时序图(Gantt)");
  return {
    meta: {
      studyId: input.studyId,
      engineId: input.engineId,
      engineVersion: input.engineVersion,
      seed: input.seed,
      replications: input.replications,
      generatedAt: input.generatedAt,
      inputFingerprint: input.inputFingerprint,
      resultFingerprint: input.resultFingerprint,
    },
    ...(input.title === undefined ? {} : { title: input.title }),
    headline: input.headline ?? defaultHeadline(summary, input.replications),
    model: input.model,
    kpis: buildKpis(summary),
    bottlenecks: topBottlenecks(summary),
    ...(summary.energy95 ? { energy: buildEnergy(summary.energy95) } : {}),
    ...(hasEntries(summary.productionOrderMetrics95) ? { orders: buildOrders(summary.productionOrderMetrics95) } : {}),
    ...(input.analytics?.sankey ? { sankey: input.analytics.sankey } : {}),
    ...(input.analytics?.gantt ? { gantt: input.analytics.gantt } : {}),
    lineage: {
      baselineStudyId: input.lineage?.baselineStudyId ?? null,
      reproductionOf: input.lineage?.reproductionOf ?? null,
    },
    limitations: buildLimitations(input, estimatedParts),
    provenance: estimatedParts.length > 0 ? "estimated" : "measured",
  };
}

function buildKpis(summary: StudyReportExperimentSummary): StudyReportKpi[] {
  const confidence = summary.confidence95;
  const kpis: StudyReportKpi[] = [
    intervalKpi("throughput-per-hour", "平均吞吐", confidence.throughputPerHour, "件/h"),
    intervalKpi("average-wip", "平均在制品", confidence.averageWip, "件"),
    intervalKpi("average-lead-time-minutes", "平均交付周期", confidence.averageLeadTimeMinutes, "min"),
  ];
  if (summary.energy95) {
    kpis.push(
      intervalKpi("energy-total", "能耗合计", summary.energy95.totalEnergyKwh, "kWh"),
      intervalKpi("energy-per-item", "单件能耗", summary.energy95.energyPerCompletedItemKwh, "kWh/件"),
      intervalKpi("carbon-emission", "碳排放", summary.energy95.carbonEmissionKg, "kg"),
      intervalKpi("peak-demand", "峰值功率", summary.energy95.peakDemandKw, "kW"),
    );
  }
  const orders = summary.productionOrderMetrics95;
  if (hasEntries(orders)) {
    for (const orderId of Object.keys(orders).sort()) {
      kpis.push(percentKpi(`order-${orderId}-on-time`, `订单 ${orderId} 准交率`, orders[orderId]!.onTimeFulfillmentRate));
    }
  }
  return kpis;
}

/** 旧记录/无订单模型的 productionOrderMetrics95 是空对象(truthy),空集必须视为"无分节"。 */
function hasEntries(orders: StudyReportExperimentSummary["productionOrderMetrics95"]): orders is Record<string, StudyReportOrderIntervals> {
  return orders !== undefined && Object.keys(orders).length > 0;
}

/** top-3 瓶颈:频次降序,节点 ID 升序破平;与内核排序语义一致但不再信任输入顺序。 */
function topBottlenecks(summary: StudyReportExperimentSummary): StudyReportBottleneck[] {
  return [...summary.bottlenecks]
    .sort((left, right) => right.occurrences - left.occurrences || compareText(left.nodeId, right.nodeId))
    .slice(0, 3)
    .map((entry): StudyReportBottleneck => ({
      nodeId: entry.nodeId,
      occurrences: entry.occurrences,
      probability: entry.probability,
      provenance: "measured",
    }));
}

function buildEnergy(energy95: StudyReportEnergyIntervals): StudyReportEnergy {
  return {
    activeEnergyKwh: intervalKpi("energy-active", "有效加工能耗", energy95.activeEnergyKwh, "kWh"),
    idleEnergyKwh: intervalKpi("energy-idle", "空载能耗", energy95.idleEnergyKwh, "kWh"),
    totalEnergyKwh: intervalKpi("energy-total", "能耗合计", energy95.totalEnergyKwh, "kWh"),
    energyPerCompletedItemKwh: intervalKpi("energy-per-item", "单件能耗", energy95.energyPerCompletedItemKwh, "kWh/件"),
    electricityCost: intervalKpi("electricity-cost", "电费", energy95.electricityCost, "元"),
    electricityCostPerCompletedItem: intervalKpi("electricity-cost-per-item", "单件电费", energy95.electricityCostPerCompletedItem, "元/件"),
    carbonEmissionKg: intervalKpi("carbon-emission", "碳排放", energy95.carbonEmissionKg, "kg"),
    carbonEmissionPerCompletedItemKg: intervalKpi("carbon-per-item", "单件碳排", energy95.carbonEmissionPerCompletedItemKg, "kg/件"),
    peakDemandKw: intervalKpi("peak-demand", "峰值功率", energy95.peakDemandKw, "kW"),
    consumerEnergyKwh: Object.keys(energy95.consumerEnergyKwh).sort().map((consumerId) => ({
      consumerId,
      energyKwh: intervalKpi(`energy-consumer-${consumerId}`, `能耗 · ${consumerId}`, energy95.consumerEnergyKwh[consumerId]!, "kWh"),
    })),
  };
}

function buildOrders(orders95: Record<string, StudyReportOrderIntervals>): StudyReportOrderRow[] {
  return Object.keys(orders95).sort().map((orderId) => {
    const metrics = orders95[orderId]!;
    return {
      orderId,
      completionRate: percentKpi("completion-rate", "完成率", metrics.completionRate),
      onTimeFulfillmentRate: percentKpi("on-time-rate", "准交率", metrics.onTimeFulfillmentRate),
      fullyCompletedRate: percentKpi("fully-completed-rate", "全部完成比例", metrics.fullyCompletedRate),
      observedTardinessMinutes: intervalKpi("observed-tardiness", "观测拖期", metrics.observedTardinessMinutes, "min"),
    };
  });
}

function intervalKpi(key: string, label: string, interval: StudyReportConfidenceInterval, unit: string): StudyReportKpi {
  return {
    key,
    label,
    value: interval.mean,
    unit,
    ci95: { lower95: interval.lower95, upper95: interval.upper95, samples: interval.samples },
    provenance: "measured",
  };
}

function percentKpi(key: string, label: string, interval: StudyReportConfidenceInterval): StudyReportKpi {
  return intervalKpi(key, label, { ...interval, mean: interval.mean * 100, lower95: interval.lower95 * 100, upper95: interval.upper95 * 100 }, "%");
}

/** limitations 固定四条:置信区间口径 / 预热窗口 / estimated 标注 / 非认证结论声明。 */
function buildLimitations(input: StudyReportInput, estimatedParts: readonly string[]): string[] {
  const measurement = input.experimentResult.measurementMinutes;
  return [
    "置信区间口径:95% 置信区间基于已完成重复的样本 t 区间(样本数见各 KPI 的 ci95.samples);重复数较少时区间偏宽,应结合区间宽度而非仅看均值解读。",
    measurement === undefined
      ? "预热窗口:吞吐与交付期只统计预热期之后完工的工件,WIP/利用率/能耗只在预热期后的正式统计窗口内积分;窗口长度以 replication.measurementMinutes 为准。"
      : `预热窗口:全部指标仅统计预热期之后的 ${formatNumber(measurement)} 分钟正式统计窗口;吞吐与交付期只采集该窗口内完工的工件。`,
    estimatedParts.length > 0
      ? `estimated 模式标注:${estimatedParts.join("、")}为无轨迹估算或含估算段,仅用于示意,不得当实测宣示。`
      : "estimated 模式标注:本报告全部数值与图表均为实测仿真统计(provenance = measured),不含估算模式数据。",
    "非认证结论声明:本报告为离散事件仿真的统计估计,仅供工程决策参考,不构成认证、合规或合同验收结论,不能替代实物实测与第三方认证。",
  ];
}

function defaultHeadline(summary: StudyReportExperimentSummary, replications: number): string {
  const throughput = summary.confidence95.throughputPerHour;
  const wip = summary.confidence95.averageWip;
  const leadTime = summary.confidence95.averageLeadTimeMinutes;
  return `吞吐 ${formatNumber(throughput.mean)} 件/h(95% CI ${formatNumber(throughput.lower95)}–${formatNumber(throughput.upper95)}),`
    + `平均在制品 ${formatNumber(wip.mean)} 件,平均交付周期 ${formatNumber(leadTime.mean)} min(基于 ${replications} 次已完成重复)`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return String(Math.round(value * 1000) / 1000);
}

function provenanceLabel(provenance: StudyReportKpi["provenance"]): string {
  return provenance === "measured" ? "实测" : "估算";
}

/** 纯函数渲染 Markdown;输出只依赖 report,同输入逐字一致,可直接落盘/下载。 */
export function renderStudyReportMarkdown(report: StudyReport): string {
  const lines: string[] = [`# 仿真实验报告:${report.title ?? report.meta.studyId}`, "", "## 概览", ""];
  lines.push(
    `- Study ID:${report.meta.studyId}`,
    `- 引擎:${report.meta.engineId} @ ${report.meta.engineVersion}`,
    `- 种子 / 重复:${report.meta.seed} / ${report.meta.replications} 次`,
    `- 生成时间:${report.meta.generatedAt}`,
    `- 模型规模:${report.model.nodeCount} 节点 / ${report.model.resourceCount} 资源`,
    `- 输入指纹:\`${report.meta.inputFingerprint ?? "缺失(旧记录无指纹)"}\``,
    `- 结果指纹:\`${report.meta.resultFingerprint ?? "缺失(旧记录无指纹)"}\``,
    `- 数据口径:${provenanceLabel(report.provenance)}(${report.provenance})`,
    "",
    "## 结论",
    "",
    report.headline,
    "",
    "## 关键指标(KPI)",
    "",
    "| 指标 | 数值 | 单位 | 95% 置信区间 | 样本数 | 口径 |",
    "|---|---:|---|---|---:|---|",
  );
  for (const kpi of report.kpis) lines.push(kpiRow(kpi));
  lines.push(
    "",
    "## 瓶颈 Top 3",
    "",
    "| 节点 | 频次 | 概率 | 口径 |",
    "|---|---:|---:|---|",
  );
  for (const bottleneck of report.bottlenecks) {
    lines.push(`| ${bottleneck.nodeId} | ${bottleneck.occurrences} | ${formatNumber(bottleneck.probability * 100)}% | ${provenanceLabel(bottleneck.provenance)} |`);
  }
  if (report.energy) {
    lines.push("", "## 能耗与碳排", "", "| 指标 | 数值 | 单位 | 95% 置信区间 | 样本数 | 口径 |", "|---|---:|---|---|---:|---|");
    for (const kpi of energyKpis(report.energy)) lines.push(kpiRow(kpi));
  }
  if (report.orders) {
    lines.push("", "## 生产订单", "", "| 订单 | 完成率 | 准交率 | 全部完成比例 | 观测拖期 |", "|---|---:|---:|---:|---:|");
    for (const order of report.orders) {
      lines.push(`| ${order.orderId} | ${rateCell(order.completionRate)} | ${rateCell(order.onTimeFulfillmentRate)} | ${rateCell(order.fullyCompletedRate)} | ${formatNumber(order.observedTardinessMinutes.value)} min |`);
    }
  }
  if (report.sankey) {
    lines.push(
      "",
      "## 物料流(Sankey)",
      "",
      `- 节点 ${report.sankey.nodes.length} / 链 ${report.sankey.links.length} / 统计窗口 ${formatNumber(report.sankey.windowMinutes)} min`,
      `- 口径:${report.sankey.estimated ? "估算(无代表性轨迹,按节点吞吐传播,仅示意)" : "实测(代表性重复轨迹逐件统计)"}`,
      "",
      "| 源节点 | 目标节点 | 流量 |",
      "|---|---|---:|",
    );
    for (const link of report.sankey.links) lines.push(`| ${link.source} | ${link.target} | ${formatNumber(link.value)} |`);
  }
  if (report.gantt) {
    const estimatedRows = report.gantt.rows.filter((row) => row.estimated).length;
    const takt = report.gantt.taktMinutes === undefined ? "" : ` / 观测节拍 ${formatNumber(report.gantt.taktMinutes)} min/件`;
    lines.push(
      "",
      "## 时序(Gantt)",
      "",
      `- 行 ${report.gantt.rows.length} / 统计窗口 ${formatNumber(report.gantt.windowMinutes)} min${takt}`,
      `- 口径:${estimatedRows === 0 ? "实测(逐事件对齐切分)" : `估算(${estimatedRows}/${report.gantt.rows.length} 行为指标占比铺段)`}`,
    );
  }
  if (report.lineage.baselineStudyId !== null || report.lineage.reproductionOf !== null) {
    lines.push("", "## 谱系", "");
    if (report.lineage.baselineStudyId !== null) lines.push(`- 基线 Study:${report.lineage.baselineStudyId}`);
    if (report.lineage.reproductionOf !== null) lines.push(`- 复现自:${report.lineage.reproductionOf}`);
  }
  lines.push("", "## 局限与免责声明", "");
  for (const [index, limitation] of report.limitations.entries()) lines.push(`${index + 1}. ${limitation}`);
  lines.push("");
  return lines.join("\n");
}

function energyKpis(energy: StudyReportEnergy): StudyReportKpi[] {
  return [
    energy.activeEnergyKwh,
    energy.idleEnergyKwh,
    energy.totalEnergyKwh,
    energy.energyPerCompletedItemKwh,
    energy.electricityCost,
    energy.electricityCostPerCompletedItem,
    energy.carbonEmissionKg,
    energy.carbonEmissionPerCompletedItemKg,
    energy.peakDemandKw,
    ...energy.consumerEnergyKwh.map((consumer) => consumer.energyKwh),
  ];
}

function kpiRow(kpi: StudyReportKpi): string {
  const ci = kpi.ci95 ? `${formatNumber(kpi.ci95.lower95)}–${formatNumber(kpi.ci95.upper95)}` : "—";
  return `| ${kpi.label} | ${formatNumber(kpi.value)} | ${kpi.unit ?? "—"} | ${ci} | ${kpi.ci95?.samples ?? "—"} | ${provenanceLabel(kpi.provenance)} |`;
}

function rateCell(kpi: StudyReportKpi): string {
  const ci = kpi.ci95 ? `(95% CI ${formatNumber(kpi.ci95.lower95)}–${formatNumber(kpi.ci95.upper95)}%)` : "";
  return `${formatNumber(kpi.value)}%${ci}`;
}
