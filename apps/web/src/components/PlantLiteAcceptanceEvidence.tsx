import { AlertTriangle, BadgeCheck, CircleX, ShieldQuestion, Target } from "lucide-react";
import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import {
  assessPlantLiteAcceptance,
  type PlantLiteAcceptanceCheck,
  type PlantLiteAcceptanceStatus,
} from "./plantLiteAcceptanceAssessment";
import "./PlantLiteAcceptanceEvidence.css";

export function PlantLiteAcceptanceEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const assessment = assessPlantLiteAcceptance(result);
  if (!assessment) return null;
  const priority = assessment.checks.find((check) => check.status === "not-met")
    ?? assessment.checks.find((check) => check.status === "insufficient-data")
    ?? assessment.checks.find((check) => check.status === "at-risk");
  return <section className={`plant-acceptance-evidence is-${assessment.status}`} aria-label="方案验收判定">
    <header>
      <span><Target size={14} /><strong>方案验收</strong><small>{assessment.basis ?? "本次 Study 保存的目标阈值"}</small></span>
      <em>{statusIcon(assessment.status)}{statusLabel(assessment.status)}</em>
    </header>
    <div role="table" className="plant-acceptance-checks">
      {assessment.checks.map((check) => <div role="row" key={check.key} className={`is-${check.status}`}>
        <span role="cell">{check.label}</span>
        <strong role="cell">{formatTarget(check)}</strong>
        <small role="cell">{formatInterval(check.interval, check.unit)}</small>
        <em role="cell">{statusLabel(check.status)}</em>
      </div>)}
    </div>
    {priority ? <p><b>{priority.status === "insufficient-data" ? "先补证据" : "下一步"}</b>{priority.action}</p> : null}
  </section>;
}

function statusIcon(status: PlantLiteAcceptanceStatus) {
  if (status === "met") return <BadgeCheck size={13} />;
  if (status === "not-met") return <CircleX size={13} />;
  if (status === "at-risk") return <AlertTriangle size={13} />;
  return <ShieldQuestion size={13} />;
}

function statusLabel(status: PlantLiteAcceptanceStatus): string {
  return ({ met: "稳定达标", "at-risk": "区间有风险", "not-met": "未达标", "insufficient-data": "证据不足" })[status];
}

function formatTarget(check: PlantLiteAcceptanceCheck): string {
  return `${check.direction === "minimum" ? "≥" : "≤"} ${formatNumber(check.target)} ${check.unit}`;
}

function formatInterval(interval: PlantLiteConfidenceInterval | undefined, unit: string): string {
  if (!interval?.samples) return "没有可用统计区间";
  return `95% CI ${formatNumber(interval.lower95)}–${formatNumber(interval.upper95)} ${unit} · n=${interval.samples}`;
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
