import type { WorkcellErgonomicsCheck, WorkcellErgonomicsRuleResult } from "@bim-studio/contracts";
import { AlertTriangle, CheckCircle2, CircleHelp, Crosshair, ShieldAlert } from "lucide-react";
import "./WorkcellErgonomicsEvidence.css";

export function WorkcellErgonomicsEvidence({ checks, onOpenObject }: {
  checks: WorkcellErgonomicsCheck[];
  onOpenObject?: (objectId: string) => void;
}) {
  if (!checks.length) return null;
  return <section className="workcell-ergonomics-evidence" aria-label="人工作业规划筛查结果">
    <header>
      <div><strong>人工作业规划筛查</strong><small>人体数据 · 作业点 · 可达与工作高度 · 搬运暴露</small></div>
      <em>{checks.filter((item) => item.status === "pass").length}/{checks.length} 无预警</em>
    </header>
    <div>{checks.map((check) => <ErgonomicsCheckCard key={check.profileId} check={check} {...(onOpenObject ? { onOpenObject } : {})} />)}</div>
  </section>;
}

function ErgonomicsCheckCard({ check, onOpenObject }: { check: WorkcellErgonomicsCheck; onOpenObject?: (objectId: string) => void }) {
  const icon = check.status === "pass" ? <CheckCircle2 size={15} />
    : check.status === "needs-data" ? <CircleHelp size={15} />
      : check.status === "warn" ? <AlertTriangle size={15} /> : <ShieldAlert size={15} />;
  return <article className={check.status}>
    <header>
      {icon}<span><strong>{check.profileName}</strong><small>{statusLabel(check.status)} · 证据 {(check.evidenceCoverage * 100).toFixed(0)}%</small></span>
      {onOpenObject && (check.operatorObjectId || check.workPointObjectId) && <div className="workcell-ergonomics-locate">
        {check.operatorObjectId && <button type="button" onClick={() => onOpenObject(check.operatorObjectId!)}><Crosshair size={12} />人员</button>}
        {check.workPointObjectId && <button type="button" onClick={() => onOpenObject(check.workPointObjectId!)}><Crosshair size={12} />作业点</button>}
      </div>}
    </header>
    <div className="workcell-ergonomics-rules">{check.rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)}</div>
    {check.missingFields.length > 0 && <p className="workcell-ergonomics-missing"><b>待补充</b>{check.missingFields.map(missingLabel).join("、")}</p>}
    {check.recommendations.length > 0 && <ul>{check.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>}
    <p className="workcell-ergonomics-sources"><b>证据来源</b>{sourceSummary(check)}</p>
    <p className="workcell-ergonomics-declaration">{check.declaration}</p>
  </article>;
}

function RuleRow({ rule }: { rule: WorkcellErgonomicsRuleResult }) {
  const evidence = rule.id === "anthropometry-consistency" ? rule.detail
    : rule.measuredValue === undefined || rule.limitValue === undefined
      ? "待补充"
      : `${format(rule.measuredValue)} ${rule.unit ?? ""} / 限值 ${format(rule.limitValue)} ${rule.unit ?? ""}`;
  return <div className={rule.status} title={rule.detail}>
    <span><strong>{rule.label}</strong><small>{evidence}</small></span>
    <em>{rule.utilization === undefined ? "—" : `${(rule.utilization * 100).toFixed(0)}%`}</em>
    <b>{ruleStatusLabel(rule.status)}</b>
  </div>;
}

function statusLabel(value: WorkcellErgonomicsCheck["status"]): string {
  return ({ pass: "规划阈值内", warn: "接近规划阈值", fail: "超出规划阈值", "needs-data": "需要补充数据" })[value];
}
function ruleStatusLabel(value: WorkcellErgonomicsRuleResult["status"]): string {
  return ({ pass: "通过", warn: "预警", fail: "越界", "needs-data": "待补" })[value];
}
function sourceSummary(check: WorkcellErgonomicsCheck): string {
  const sources = [
    sourceLabel(check.anthropometrySource, "人体", check.anthropometryReference),
    sourceLabel(check.taskSource, "任务", check.taskReference),
    sourceLabel(check.policySource, "策略", check.policyReference),
  ];
  return sources.join(" · ");
}
function sourceLabel(value: string | undefined, label: string, reference: string | undefined): string {
  if (!value) return `${label}待补充`;
  const source = ({ "author-confirmed": "用户确认", imported: "导入", "reference-table": "引用表", "scene-geometry": "场景几何" } as Record<string, string>)[value] ?? value;
  return `${label}：${source}${reference ? `（${reference}）` : ""}`;
}
function missingLabel(value: WorkcellErgonomicsCheck["missingFields"][number]): string {
  return ({
    "operator-binding": "人员对象", "anthropometry-method": "人体录入方式", "anthropometry-percentile": "身高百分位",
    stature: "身高", "shoulder-height": "肩高", "elbow-height": "肘高", "functional-reach": "功能可达距离",
    "anthropometry-source": "人体来源", "anthropometry-reference": "人体引用", "work-point": "作业点",
    "load-mass": "单次负荷", repetitions: "搬运频次", duration: "连续时长", "task-source": "任务来源",
    "task-reference": "任务引用", "maximum-load": "负荷上限", "maximum-repetitions": "频次上限",
    "maximum-duration": "时长上限", "height-tolerance": "肘高容差", "warning-utilization": "预警比例",
    "policy-source": "策略来源", "policy-reference": "策略引用",
  })[value];
}
function format(value: number): string { return Number(value.toFixed(3)).toLocaleString("zh-CN"); }
