import { BadgeCheck, CircleAlert, FlaskConical, LoaderCircle, Wrench } from "lucide-react";
import { useState } from "react";
import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import {
  createPlantLiteReliabilityStrategySweep,
  listPlantLiteReliabilityOptions,
} from "./plantLiteReliabilityStrategy";
import {
  derivePlantLiteReliabilityDecision,
  type PlantLiteReliabilityAssessment,
  type PlantLiteReliabilityDecision,
  type PlantLiteReliabilityDecisionRow,
} from "./plantLiteReliabilityDecision";
import "./PlantLiteReliabilityExperiment.css";

export function PlantLiteReliabilityExperiment({
  study,
  results,
  busy,
  onRunSweep,
}: {
  study: PlantLiteStudyRecord;
  results: PlantLiteStudyRecord[];
  busy: boolean;
  onRunSweep: (requests: PlantLiteStudyRequest[], baselineStudyId: string) => void;
}) {
  const decision = derivePlantLiteReliabilityDecision(results);
  const experimentBaseline = decision?.baselineStudy ?? study;
  const options = listPlantLiteReliabilityOptions(experimentBaseline);
  const [requestedResourceId, setRequestedResourceId] = useState(decision?.resource.resourceId ?? options[0]?.resourceId ?? "");
  const selected = options.find((option) => option.resourceId === requestedResourceId)
    ?? options.find((option) => option.resourceId === decision?.resource.resourceId)
    ?? options[0];
  if (!selected) return null;
  const sweep = createPlantLiteReliabilityStrategySweep(experimentBaseline, selected.resourceId);

  return <>
    <section className="plant-reliability-experiment" aria-label="可靠性维护策略实验">
      <header>
        <span><Wrench size={14} /><strong>可靠性策略实验</strong><small>敏感性分析 · 非预测性维护</small></span>
        <em>固定 seed · 时长 · 预热 · 重复次数</em>
      </header>
      <div className="plant-reliability-controls">
        <label>
          <span>设备 / 搬运资源</span>
          <select aria-label="选择可靠性实验设备" value={selected.resourceId} onChange={(event) => setRequestedResourceId(event.target.value)}>
            {options.map((option) => <option key={option.resourceId} value={option.resourceId}>
              {option.resourceName} · {option.boundNodeNames.join(" / ")}
            </option>)}
          </select>
        </label>
        <div className="plant-reliability-candidates">
          <strong>基线 MTBF {formatMinutes(selected.mtbfMinutes)} 分 · MTTR {formatMinutes(selected.mttrMinutes)} 分</strong>
          <span>{sweep?.candidates.map((candidate) => <em key={candidate.kind}>{candidate.label}</em>)}</span>
        </div>
        <button
          type="button"
          disabled={busy || !sweep}
          aria-busy={busy}
          title="两个候选各只修改一个已配置的故障参数；25% 是显式敏感性目标，不是预测结果"
          onClick={() => sweep && onRunSweep(sweep.requests, experimentBaseline.id)}
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <FlaskConical size={13} />}
          {busy ? "运行中" : sweep ? "运行 2 个策略" : "基线证据不完整"}
        </button>
      </div>
      <p>仅使用模型中已配置的 MTBF / MTTR；不补设备参数，也不把敏感性目标冒充维护预测。</p>
    </section>
    {decision ? <ReliabilityDecisionTable decision={decision} /> : null}
  </>;
}

function ReliabilityDecisionTable({ decision }: { decision: PlantLiteReliabilityDecision }) {
  return <section className="plant-reliability-decision" aria-label="可靠性策略比较结果">
    <header>
      <span><strong>可靠性策略比较</strong><small>{decision.resource.resourceName} · 故障产能损失按台·分钟统计</small></span>
      <em><BadgeCheck size={12} />共同随机条件</em>
    </header>
    <div className="plant-reliability-table" role="table" aria-label="维护策略统计比较">
      <div className="plant-reliability-table-head" role="row">
        <span role="columnheader">方案</span><span role="columnheader">MTBF / MTTR</span><span role="columnheader">故障损失</span><span role="columnheader">吞吐</span><span role="columnheader">交付期 / WIP</span><span role="columnheader">单位能耗 / 电费</span><span role="columnheader">证据</span>
      </div>
      {decision.rows.map((row) => <DecisionRow key={row.study.id} row={row} recommendation={decision.recommendation} />)}
    </div>
    <p className={`plant-reliability-recommendation is-${decision.recommendation.status}`}>
      {decision.recommendation.status === "unavailable" ? <CircleAlert size={13} /> : <BadgeCheck size={13} />}
      <span><b>推荐依据</b>{decision.recommendation.rationale} 均值筛选不等于 95% 区间显著改善。</span>
    </p>
  </section>;
}

function DecisionRow({ row, recommendation }: {
  row: PlantLiteReliabilityDecisionRow;
  recommendation: PlantLiteReliabilityDecision["recommendation"];
}) {
  return <div className={row.recommended ? "is-recommended" : ""} role="row">
    <span role="cell" data-label="方案"><b>{row.label}</b><small>{decisionRowStatus(row, recommendation)}</small></span>
    <span role="cell" data-label="MTBF / MTTR">{formatMinutes(row.mtbfMinutes)} / {formatMinutes(row.mttrMinutes)} <small>分钟</small></span>
    <span role="cell" data-label="故障损失">{row.failedMinutes ? `${row.failedMinutes.mean.toFixed(1)} 台·分` : "—"}<small>{intervalCopy(row.failedMinutes)}</small></span>
    <span role="cell" data-label="吞吐">{row.study.outcome.throughputPerHour.mean.toFixed(1)} 件/时<small>{assessmentCopy(row.throughputAssessment)}</small></span>
    <span role="cell" data-label="交付期 / WIP">{row.study.outcome.averageLeadTimeMinutes.mean.toFixed(1)} 分 <small>/ {row.study.outcome.averageWip.mean.toFixed(1)} 件</small></span>
    <span role="cell" data-label="单位能耗 / 电费">{energyCopy(row)}</span>
    <span role="cell" data-label="证据" className={`is-${row.evidenceStatus}`}>{evidenceCopy(row)}</span>
  </div>;
}

function decisionRowStatus(
  row: PlantLiteReliabilityDecisionRow,
  recommendation: PlantLiteReliabilityDecision["recommendation"],
): string {
  if (!row.comparable) return "不可归因";
  if (!row.recommended) return "可比方案";
  if (recommendation.studyIds.length > 1) return row.kind === "baseline" ? "基线仍具竞争力" : "非支配候选";
  return row.kind === "baseline" ? "维持基线" : "优先验证候选";
}

function intervalCopy(value: PlantLiteDecisionInterval | undefined): string {
  return value ? `95% CI ${value.lower95.toFixed(1)}–${value.upper95.toFixed(1)}` : "无完整停机区间";
}

type PlantLiteDecisionInterval = NonNullable<PlantLiteReliabilityDecisionRow["failedMinutes"]>;

function assessmentCopy(value: PlantLiteReliabilityAssessment): string {
  if (value === "baseline") return "基线";
  if (value === "improved") return "95% 区间改善";
  if (value === "worsened") return "95% 区间下降";
  if (value === "overlap") return "95% 区间重叠";
  return "条件不一致";
}

function evidenceCopy(row: PlantLiteReliabilityDecisionRow): string {
  if (row.evidenceStatus === "complete") return assessmentCopy(row.failedMinutesAssessment);
  if (row.evidenceStatus === "missing-downtime") return "缺少故障损失样本";
  return row.comparabilityReason;
}

function energyCopy(row: PlantLiteReliabilityDecisionRow): string {
  if (row.energyPerItemKwh === undefined || row.costPerItem === undefined) return "—";
  return `${row.energyPerItemKwh.toFixed(3)} kWh/件 · ${row.costPerItem.toFixed(3)} 元/件`;
}

function formatMinutes(value: number): string {
  return Number(value.toFixed(2)).toString();
}
