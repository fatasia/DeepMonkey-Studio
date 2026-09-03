import { BadgeCheck, ChevronDown, CircleAlert, GitCompareArrows, Target } from "lucide-react";
import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import {
  derivePlantLiteScenarioDecision,
  type PlantLiteDecisionAcceptanceStatus,
  type PlantLiteDecisionMetric,
  type PlantLiteDecisionRow,
  type PlantLiteIntervalAssessment,
} from "./plantLiteScenarioDecisionModel";

export function PlantLiteScenarioDecision({ results }: { results: PlantLiteStudyRecord[] }) {
  const decision = derivePlantLiteScenarioDecision(results);
  if (!decision) return null;
  return (
    <section className="plant-scenario-decision" aria-label="方案决策矩阵">
      <header>
        <span><GitCompareArrows size={14} /><strong>方案决策矩阵</strong><small>{decision.parameterLabel} · 基线：{decision.baselineStudy.name}</small></span>
        <em><BadgeCheck size={12} />共同随机条件已核验</em>
      </header>
      <div className="plant-scenario-scope">
        <span><b>前沿目标</b>{decision.objectiveLabels.map((label) => <em key={label}>{label}</em>)}</span>
        <small>{decision.evidenceWindow}</small>
      </div>
      <div className="plant-scenario-cards plant-scenario-table" role="table" aria-label="已保存方案比较">
        {decision.rows.map((row) => <DecisionCard key={row.study.id} row={row} />)}
      </div>
      <footer>
        <p>Pareto 推荐候选按可比运行的均值筛选，只暴露取舍；最终选择仍需业务权重确认。吞吐 95% 区间重叠也不等于改善成立。</p>
        {decision.notes.length ? <details><summary><CircleAlert size={12} />查看缺失或未纳入的证据（{decision.notes.length}）</summary>{decision.notes.map((note) => <span key={note}>{note}</span>)}</details> : null}
      </footer>
    </section>
  );
}

function DecisionCard({ row }: { row: PlantLiteDecisionRow }) {
  const highlighted = !row.baseline && (row.paretoFrontier || row.highestThroughput || row.shortestLeadTime || row.lowestCost);
  return <div className={`${row.paretoFrontier ? "is-frontier" : ""} ${row.comparable ? "" : "is-incomparable"} ${highlighted ? "is-best" : ""}`} role="row">
    <header role="rowheader">
      <span><strong>{row.label}</strong><small>{row.baseline ? "保存基线" : formatTime(row.study.createdAt)}</small><span className="plant-scenario-badges">{badges(row).map((badge) => <em key={badge}>{badge}</em>)}</span></span>
    </header>
    <div className="plant-scenario-primary-metrics" role="cell">
      <Metric label="吞吐" value={row.study.outcome.throughputPerHour.mean} unit="件/时" interval={row.study.outcome.throughputPerHour} detail={throughputDetail(row)} />
      <Metric label="交付周期" value={row.study.outcome.averageLeadTimeMinutes.mean} unit="分钟" interval={row.study.outcome.averageLeadTimeMinutes} />
      <Metric label="平均 WIP" value={row.study.outcome.averageWip.mean} unit="件" interval={row.study.outcome.averageWip} />
    </div>
    <details className="plant-scenario-evidence" role="cell">
      <summary><ChevronDown size={13} />利用率、可靠性、能源与验收</summary>
      <div>
        <EvidenceMetric label="峰值资源利用率" metric={row.peakUtilization} unit="%" percentage {...(row.peakUtilization ? { detail: row.peakUtilization.resourceName } : {})} />
        <EvidenceMetric label="故障容量损失" metric={row.failureLoss} unit="台·分钟" />
        <EvidenceMetric label="单位能耗" metric={row.energyPerItemKwh} unit="kWh/件" />
        <EvidenceMetric label="单位成本（电费）" metric={row.costPerItem} unit="元/件" />
        <EvidenceMetric label="单位碳排" metric={row.carbonPerItemKg} unit="kgCO₂e/件" />
        <span className={`plant-scenario-acceptance is-${row.acceptanceStatus}`}><Target size={12} /><small>验收</small><strong>{acceptanceLabel(row.acceptanceStatus)}</strong></span>
      </div>
      <p className={row.comparable ? "verified" : "warning"}>{row.comparabilityReason}</p>
    </details>
  </div>;
}

function Metric({ label, value, unit, interval, detail }: {
  label: string;
  value: number;
  unit: string;
  interval: PlantLiteConfidenceInterval;
  detail?: string;
}) {
  return <span><small>{label}</small><strong>{formatNumber(value)} <i>{unit}</i></strong><em>{detail ?? `95% CI ${formatNumber(interval.lower95)}–${formatNumber(interval.upper95)}`}</em></span>;
}

function EvidenceMetric({ label, metric, unit, percentage = false, detail }: {
  label: string;
  metric: PlantLiteDecisionMetric | undefined;
  unit: string;
  percentage?: boolean;
  detail?: string;
}) {
  const value = metric ? metric.value * (percentage ? 100 : 1) : undefined;
  return <span className={!metric ? "is-missing" : metric.evidence === "partial" ? "is-partial" : ""}>
    <small>{label}</small><strong>{value === undefined ? "—" : `${formatNumber(value)} ${unit}`}</strong>
    <em>{detail ?? (!metric ? "当前记录未生成" : metric.evidence === "complete" ? "证据完整" : "样本不完整")}</em>
  </span>;
}

function badges(row: PlantLiteDecisionRow): string[] {
  const result: string[] = [];
  if (row.paretoFrontier && !row.baseline) result.push("Pareto 推荐候选 · 非支配前沿");
  if (row.highestThroughput) result.push("最高吞吐");
  if (row.shortestLeadTime) result.push("最短周期");
  if (row.lowestCost) result.push("单位成本最低");
  if (row.acceptanceStatus === "met") result.push("验收达标");
  if (!row.comparable) result.push("不可比");
  return result.length ? result : [row.baseline ? "基线" : "可比方案"];
}

function throughputDetail(row: PlantLiteDecisionRow): string {
  if (row.intervalAssessment === "baseline") return "基线 · 95% 统计区间";
  if (row.intervalAssessment === "unavailable") return "未计算差值";
  const delta = row.throughputDeltaPercent === undefined ? "" : `${row.throughputDeltaPercent >= 0 ? "+" : ""}${row.throughputDeltaPercent.toFixed(1)}%`;
  return `${delta} · ${intervalLabel(row.intervalAssessment)}`;
}

function intervalLabel(value: PlantLiteIntervalAssessment): string {
  return ({ improved: "区间改善", worsened: "区间下降", overlap: "区间重叠", baseline: "基线", unavailable: "不可比" })[value];
}

function acceptanceLabel(status: PlantLiteDecisionAcceptanceStatus): string {
  return ({
    met: "稳定达标", "at-risk": "区间有风险", "not-met": "未达标", "insufficient-data": "证据不足",
    "not-set": "未设置门槛", "inconsistent-targets": "门槛不一致",
  })[status];
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "已保存方案" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
