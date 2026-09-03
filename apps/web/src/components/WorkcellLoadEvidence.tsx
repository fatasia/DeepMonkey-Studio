import type { WorkcellRobotLoadCheck } from "@bim-studio/contracts";
import { AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react";
import "./WorkcellLoadEvidence.css";

export function WorkcellLoadEvidence({ checks }: { checks: WorkcellRobotLoadCheck[] }) {
  if (!checks.length) return null;
  return <section className="workcell-load-evidence" aria-label="机器人负载与 TCP 规划筛查">
    <header>
      <div><strong>负载与 TCP 规划筛查</strong><small>额定质量 · 工具与工件 · TCP · 组合重心</small></div>
      <em>{checks.filter((item) => item.status === "within-planning-envelope").length}/{checks.length} 参数完整且包络内</em>
    </header>
    <div className="workcell-load-checks">{checks.map((check) => <LoadCheck key={check.robotId} check={check} />)}</div>
  </section>;
}

function LoadCheck({ check }: { check: WorkcellRobotLoadCheck }) {
  const icon = check.status === "within-planning-envelope"
    ? <CheckCircle2 size={14} />
    : check.status === "exceeds-planning-envelope" ? <AlertTriangle size={14} /> : <CircleHelp size={14} />;
  return <article className={check.status}>
    <div className="workcell-load-check-title">
      {icon}<span><strong>{check.robotId}</strong><small>{statusLabel(check.status)}</small></span>
      <em>证据 {(check.evidenceCoverage * 100).toFixed(0)}%</em>
    </div>
    <dl>
      <Metric label="总负载" value={measurement(check.totalLoadKg, "kg")} />
      <Metric label="额定负载" value={measurement(check.ratedPayloadKg, "kg")} />
      <Metric label="负载率" value={percentage(check.payloadUtilization)} danger={(check.payloadUtilization ?? 0) > 1} />
      <Metric label="TCP 偏移" value={measurement(check.tcpOffsetDistanceMeters, "m")} />
      <Metric label="组合重心" value={measurement(check.loadCenterDistanceMeters, "m")} />
      <Metric label="重心上限" value={measurement(check.maximumLoadCenterDistanceMeters, "m")} />
    </dl>
    {check.missingFields.length > 0 && <p className="workcell-load-missing"><b>待补充</b>{check.missingFields.map(missingLabel).join("、")}</p>}
    {check.violations.length > 0 && <p className="workcell-load-violations"><b>越界</b>{check.violations.map((item) => item === "payload" ? "总负载" : "组合重心距离").join("、")}</p>}
    {(check.capabilitySource || check.toolLoadSource) && <p className="workcell-load-sources">
      <b>来源</b>{sourceLabel(check.capabilitySource)}{check.capabilityReference ? ` · ${check.capabilityReference}` : ""} / {sourceLabel(check.toolLoadSource)}{check.toolLoadReference ? ` · ${check.toolLoadReference}` : ""}
    </p>}
    <p className="workcell-load-declaration">{check.declaration}</p>
  </article>;
}

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return <div className={danger ? "danger" : ""}><dt>{label}</dt><dd>{value}</dd></div>;
}

function statusLabel(value: WorkcellRobotLoadCheck["status"]): string {
  return ({
    "within-planning-envelope": "规划包络内",
    "exceeds-planning-envelope": "超出规划包络",
    "needs-data": "需要补充数据",
  })[value];
}

function missingLabel(value: WorkcellRobotLoadCheck["missingFields"][number]): string {
  return ({
    "tool-binding": "末端工具绑定",
    "rated-payload": "额定负载",
    "rated-load-center": "重心距离上限",
    "capability-source": "能力来源",
    "tool-mass": "工具质量",
    "carried-payload": "工件质量",
    "tcp-position": "TCP 位置",
    "tcp-orientation": "TCP 姿态",
    "combined-center-of-mass": "组合重心",
    "tool-load-source": "工具负载来源",
  })[value];
}

function measurement(value: number | undefined, unit: string): string {
  return value === undefined ? "待补充" : `${Number(value.toFixed(3))} ${unit}`;
}

function percentage(value: number | undefined): string {
  return value === undefined ? "待补充" : `${(value * 100).toFixed(1)}%`;
}

function sourceLabel(value: WorkcellRobotLoadCheck["capabilitySource"]): string {
  if (!value) return "待补充";
  return ({ "configured-prefab": "资源配置", "author-confirmed": "用户确认", imported: "导入数据" })[value];
}
