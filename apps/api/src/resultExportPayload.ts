/**
 * 仿真结果导出 payload 组装:从既有 Study 权威记录(StudyReport / PlantLiteStudyRecord /
 * 统一 IndustrialStudyRecord)只读投影出可发布载荷,不复制求解器状态、不取时钟、不做 IO。
 * 同输入两次构建逐位一致(payload 不含导出时间),因此 payloadSha256 稳定,可作对账凭证。
 * 诚实边界:plant-lite 路径导出主 KPI + 能耗(含分消费者)+ 生产订单指标;
 * 节点级明细、资源利用率与质量分节不在本导出器范围(需要时经 StudyReport 分析层扩展)。
 */
import { createHash } from "node:crypto";
import type { IndustrialStudyRecord, PlantLiteStudyRecord, StudyReport } from "@bim-studio/contracts";
import { assertSqlTableName } from "@bim-studio/contracts";

/** study_results 表列(与 SQL DDL/UPSERT 顺序一致;values 数组按此列位取值)。 */
export const STUDY_RESULT_COLUMNS = [
  "study_id",
  "metric_key",
  "metric_value",
  "unit",
  "ci_low",
  "ci_high",
  "samples",
  "provenance",
  "fingerprint",
] as const;

export const STUDY_RESULTS_DEFAULT_TABLE = "study_results";

export interface ResultExportKpi {
  key: string;
  label: string;
  /** 非数值语义值(如风险标签)不入数值列,置 null 并保留 label/payloadJson 原文。 */
  value: number | null;
  unit?: string;
  ci95?: { lower95: number; upper95: number; samples: number };
  sampleStandardDeviation?: number;
  provenance: "measured" | "estimated";
}

export interface ResultExportPayloadJson {
  schemaVersion: 1;
  studyId: string;
  title?: string;
  headline?: string;
  engine: { engineId: string; engineVersion: string } | null;
  seed: string | number | null;
  replications: number | null;
  provenance: "measured" | "estimated";
  lineage: { baselineStudyId: string | null; reproductionOf: string | null };
  /** includeFingerprints=false 时整字段省略;指纹为旧记录 null 时原样保留 null,读取端不得推测补齐。 */
  fingerprints?: { input: string | null; result: string | null };
  kpis: ResultExportKpi[];
}

export type ResultExportRowValues = [
  studyId: string,
  metricKey: string,
  metricValue: number | null,
  unit: string | null,
  ciLow: number | null,
  ciHigh: number | null,
  samples: number | null,
  provenance: string,
  fingerprint: string | null,
];

export interface ResultExportPayload {
  payloadJson: ResultExportPayloadJson;
  rows: Array<{ table: string; values: ResultExportRowValues }>;
}

export interface BuildResultExportPayloadOptions {
  /** SQL 目标表名(严格标识符);MQTT 目标无需传。 */
  table?: string;
  /** 缺省 true;透传自 ResultExportTarget.includeFingerprints。 */
  includeFingerprints?: boolean;
}

/** payload 级 sha256:对 JSON.stringify(payloadJson) 求摘要,键序由构造顺序固定,同输入稳定。 */
export function resultExportPayloadSha256(payloadJson: ResultExportPayloadJson): string {
  return createHash("sha256").update(JSON.stringify(payloadJson)).digest("hex");
}

export function buildResultExportPayload(
  input: StudyReport | IndustrialStudyRecord | PlantLiteStudyRecord,
  options: BuildResultExportPayloadOptions = {},
): ResultExportPayload {
  const table = options.table ?? STUDY_RESULTS_DEFAULT_TABLE;
  assertSqlTableName(table, "options.table");
  const includeFingerprints = options.includeFingerprints ?? true;
  const { payloadJson, metrics } = isStudyReport(input)
    ? fromStudyReport(input)
    : isPlantLiteStudyRecord(input)
      ? fromPlantLiteStudyRecord(input)
      : fromIndustrialStudyRecord(input);
  const fingerprints = includeFingerprints ? payloadJson.fingerprints : undefined;
  const json: ResultExportPayloadJson = includeFingerprints ? payloadJson : omitFingerprints(payloadJson);
  const rowFingerprint = fingerprints ? (fingerprints.result ?? fingerprints.input) : null;
  const rows = metrics.map((kpi) => ({
    table,
    values: [
      json.studyId,
      kpi.key,
      kpi.value,
      kpi.unit ?? null,
      kpi.ci95?.lower95 ?? null,
      kpi.ci95?.upper95 ?? null,
      kpi.ci95?.samples ?? null,
      kpi.provenance,
      rowFingerprint,
    ] as ResultExportRowValues,
  }));
  return { payloadJson: json, rows };
}

function isStudyReport(value: StudyReport | IndustrialStudyRecord | PlantLiteStudyRecord): value is StudyReport {
  return "meta" in value;
}

function omitFingerprints(json: ResultExportPayloadJson): ResultExportPayloadJson {
  const { fingerprints: _omitted, ...rest } = json;
  return rest;
}

function isPlantLiteStudyRecord(
  value: StudyReport | IndustrialStudyRecord | PlantLiteStudyRecord,
): value is PlantLiteStudyRecord {
  return "outcome" in value;
}

type PayloadMetrics = { payloadJson: ResultExportPayloadJson; metrics: ResultExportKpi[] };

function fromStudyReport(report: StudyReport): PayloadMetrics {
  const metrics: ResultExportKpi[] = report.kpis.map((kpi) => ({
    key: kpi.key,
    label: kpi.label,
    value: finiteOrNull(kpi.value),
    ...(kpi.unit ? { unit: kpi.unit } : {}),
    ...(kpi.ci95 ? { ci95: { ...kpi.ci95 } } : {}),
    provenance: kpi.provenance,
  }));
  // 能耗/订单分节只补主 KPI 表未收录的语义,避免同一指标两个键重复入 SQL:
  // 主表(见 packages/plant-lite-simulation/src/studyReport.ts buildKpis/buildEnergy)已含
  // energy-total、energy-per-item、carbon-emission、peak-demand 与 order-<id>-on-time。
  const energy = report.energy;
  if (energy) {
    const energyEntries: Array<[string, string, typeof energy.activeEnergyKwh]> = [
      ["energy.active-energy-kwh", "激活能耗", energy.activeEnergyKwh],
      ["energy.idle-energy-kwh", "空转能耗", energy.idleEnergyKwh],
      ["energy.electricity-cost", "电费", energy.electricityCost],
      ["energy.electricity-cost-per-completed-item", "单位产品电费", energy.electricityCostPerCompletedItem],
      ["energy.carbon-emission-per-completed-item-kg", "单位产品碳排放", energy.carbonEmissionPerCompletedItemKg],
    ];
    for (const [key, label, value] of energyEntries) metrics.push(energyKpi(key, label, value));
    for (const consumer of energy.consumerEnergyKwh) {
      metrics.push(energyKpi(`energy.consumer.${consumer.consumerId}`, `能耗(${consumer.consumerId})`, consumer.energyKwh));
    }
  }
  for (const order of report.orders ?? []) {
    const entries: Array<[string, string, typeof order.completionRate]> = [
      ["completion-rate", "完成率(%)", order.completionRate],
      ["fully-completed-rate", "整单完成率(%)", order.fullyCompletedRate],
      ["observed-tardiness-minutes", "观测拖期(分钟)", order.observedTardinessMinutes],
    ];
    for (const [field, label, value] of entries) {
      metrics.push({ key: `order.${order.orderId}.${field}`, label, value: finiteOrNull(value.value), ...(value.unit ? { unit: value.unit } : {}), ...(value.ci95 ? { ci95: { ...value.ci95 } } : {}), provenance: value.provenance });
    }
  }
  return {
    payloadJson: {
      schemaVersion: 1,
      studyId: report.meta.studyId,
      ...(report.title ? { title: report.title } : {}),
      headline: report.headline,
      engine: { engineId: report.meta.engineId, engineVersion: report.meta.engineVersion },
      seed: report.meta.seed,
      replications: report.meta.replications,
      provenance: report.provenance,
      lineage: {
        baselineStudyId: report.lineage.baselineStudyId ?? null,
        reproductionOf: report.lineage.reproductionOf ?? null,
      },
      fingerprints: { input: report.meta.inputFingerprint, result: report.meta.resultFingerprint },
      kpis: metrics,
    },
    metrics,
  };
}

function fromPlantLiteStudyRecord(record: PlantLiteStudyRecord): PayloadMetrics {
  const outcome = record.outcome;
  const ciKpi = (key: string, label: string, ci: PlantLiteStudyRecord["outcome"]["throughputPerHour"], unit?: string): ResultExportKpi => ({
    key,
    label,
    value: finiteOrNull(ci.mean),
    ...(unit ? { unit } : {}),
    ci95: { lower95: ci.lower95, upper95: ci.upper95, samples: ci.samples },
    sampleStandardDeviation: ci.sampleStandardDeviation,
    // DES 完成统计是仿真实测;limited/insufficient-data 状态由路由层拦截,不在此静默降级口径。
    provenance: "measured",
  });
  const metrics: ResultExportKpi[] = [
    ciKpi("throughput-per-hour", "平均产出", outcome.throughputPerHour, "/h"),
    ciKpi("average-wip", "平均在制品", outcome.averageWip),
    ciKpi("average-lead-time-minutes", "平均交付周期", outcome.averageLeadTimeMinutes, "min"),
  ];
  const energy = outcome.energy;
  if (energy) {
    metrics.push(
      ciKpi("energy.active-energy-kwh", "激活能耗", energy.activeEnergyKwh, "kWh"),
      ciKpi("energy.idle-energy-kwh", "空转能耗", energy.idleEnergyKwh, "kWh"),
      ciKpi("energy.total-energy-kwh", "总能耗", energy.totalEnergyKwh, "kWh"),
      ciKpi("energy.energy-per-completed-item-kwh", "单位产品能耗", energy.energyPerCompletedItemKwh, "kWh/件"),
      ciKpi("energy.electricity-cost", "电费", energy.electricityCost, "元"),
      ciKpi("energy.electricity-cost-per-completed-item", "单位产品电费", energy.electricityCostPerCompletedItem, "元/件"),
      ciKpi("energy.carbon-emission-kg", "碳排放", energy.carbonEmissionKg, "kgCO₂e"),
      ciKpi("energy.carbon-emission-per-completed-item-kg", "单位产品碳排放", energy.carbonEmissionPerCompletedItemKg, "kgCO₂e/件"),
      ciKpi("energy.peak-demand-kw", "峰值功率", energy.peakDemandKw, "kW"),
    );
    for (const [consumerId, interval] of Object.entries(energy.consumerEnergyKwh)) {
      metrics.push(ciKpi(`energy.consumer.${consumerId}`, `能耗(${consumerId})`, interval, "kWh"));
    }
  }
  for (const [orderId, order] of Object.entries(outcome.productionOrderMetrics95 ?? {})) {
    metrics.push(
      ciKpi(`order.${orderId}.completed-items`, `订单 ${orderId} 完成件数`, order.completedItems),
      ciKpi(`order.${orderId}.completion-rate`, `订单 ${orderId} 完成率`, order.completionRate, "%"),
      ciKpi(`order.${orderId}.on-time-fulfillment-rate`, `订单 ${orderId} 准交率`, order.onTimeFulfillmentRate, "%"),
      ciKpi(`order.${orderId}.fully-completed-rate`, `订单 ${orderId} 整单完成率`, order.fullyCompletedRate, "%"),
      ciKpi(`order.${orderId}.observed-tardiness-minutes`, `订单 ${orderId} 观测拖期`, order.observedTardinessMinutes, "min"),
    );
  }
  // 结果指纹与统一索引(operationsStudyIndex)同口径:sha256(JSON.stringify({ input, outcome, trace }))。
  const evidence = hashEvidence({ input: record.inputFingerprint, outcome, trace: record.trace ?? null });
  return {
    payloadJson: {
      schemaVersion: 1,
      studyId: record.id,
      title: record.name,
      ...(outcome.message ? { headline: outcome.message } : {}),
      engine: { engineId: record.execution.engineId, engineVersion: record.execution.engineVersion },
      seed: record.seed,
      replications: record.replications,
      provenance: "measured",
      lineage: { baselineStudyId: record.comparison?.baselineStudyId ?? null, reproductionOf: record.reproductionOf ?? null },
      fingerprints: { input: record.inputFingerprint, result: evidence },
      kpis: metrics,
    },
    metrics,
  };
}

function fromIndustrialStudyRecord(record: IndustrialStudyRecord): PayloadMetrics {
  if (!record.result) throw new Error(`Study ${record.id} 未包含结果(result 为 null),禁止导出`);
  // 统一索引 metrics 无 provenance 字段;按来源类型显式映射:what-if 是预测(estimated),
  // plant-lite 与验收判据是实测(measured)。不在映射内的类型按 estimated 保守处理。
  const provenance = record.type === "plant-lite" || record.type === "workcell-audit" || record.type === "virtual-commissioning"
    ? "measured"
    : "estimated";
  const metrics: ResultExportKpi[] = record.result.metrics.map((metric) => ({
    key: metric.key,
    label: metric.label,
    value: typeof metric.value === "number" ? finiteOrNull(metric.value) : null,
    ...(metric.unit ? { unit: metric.unit } : {}),
    provenance,
  }));
  return {
    payloadJson: {
      schemaVersion: 1,
      studyId: record.id,
      title: record.title,
      headline: record.result.headline,
      engine: record.execution ? { engineId: record.execution.engineId, engineVersion: record.execution.engineVersion } : null,
      seed: null,
      replications: null,
      provenance,
      lineage: { ...record.lineage },
      fingerprints: { input: record.fingerprints.input, result: record.fingerprints.evidence },
      kpis: metrics,
    },
    metrics,
  };
}

function energyKpi(key: string, label: string, value: NonNullable<StudyReport["energy"]>["activeEnergyKwh"]): ResultExportKpi {
  return {
    key,
    label,
    value: finiteOrNull(value.value),
    ...(value.unit ? { unit: value.unit } : {}),
    ...(value.ci95 ? { ci95: { ...value.ci95 } } : {}),
    provenance: value.provenance,
  };
}
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
function hashEvidence(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
