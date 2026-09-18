import { ChevronDown } from "lucide-react";

export function BatteryAnalysisReport({ result }: { result: Record<string, unknown> }) {
  const observation = record(result.rulObservation);
  const routing = record(result.expertRouting);
  const comparison = record(routing?.candidateComparison);
  const standardCandidate = record(comparison?.standard);
  const pinnCandidate = record(comparison?.pinn);
  const physics = record(result.identifiedPhysicsParameters) ?? record(pinnCandidate?.identifiedPhysicsParameters);
  const domain = record(result.domainAssessment);
  const runtime = record(result.runtimeExecution);
  const profile = record(result.dataProfile);
  const ranges = record(profile?.ranges);
  const pack = record(profile?.packAssessment);
  const rationale = strings(result.rationale);
  const routeReasons = strings(routing?.reasons);
  const routePath = strings(routing?.routePath);
  const domainReasons = strings(domain?.reasons);
  const threshold = number(observation?.targetThresholdPct);
  const lowerBound = number(observation?.lifetimeLowerBoundCycles);
  const predictedLife = number(result.predictedCycleLife);
  const hasReport = observation || routing || physics || profile || rationale.length > 0 || result.modelVersion;
  if (!hasReport) return null;

  return (
    <section className="battery-analysis-report" aria-label="电池分析报告">
      <header><strong>分析报告</strong><small>边界、路由与物理证据</small></header>
      {(observation || predictedLife !== undefined) && <div className="battery-report-boundary">
        <ReportValue label="观测边界" value={lowerBound === undefined ? "—" : `${lowerBound.toFixed(0)} 圈`} />
        <ReportValue label="预测阈值" value={threshold === undefined ? "—" : `${format(threshold, 1)}% SOH`} />
        <ReportValue label="阈值寿命" value={predictedLife === undefined ? "—" : `${predictedLife.toFixed(0)} 圈`} />
        <ReportValue label="终点语义" value={observationLabel(observation)} />
      </div>}

      {pack && <div className="battery-report-boundary battery-report-pack">
        <ReportValue label="Pack 平均 SOH" value={unit(pack.meanSohPct, "%", 1)} />
        <ReportValue label="最弱电芯 SOH" value={unit(pack.weakestSohPct, "%", 1)} />
        <ReportValue label="SOH 极差" value={unit(pack.sohSpreadPct, "%", 1)} />
        <ReportValue label="最弱电芯" value={`${String(pack.weakestCellId ?? "—")}${pack.weakestModuleId ? ` · ${String(pack.weakestModuleId)}` : ""}`} />
      </div>}

      {pack && hasPackDiagnostics(pack) && <ReportDetails title="Pack 一致性诊断">
        <div className="battery-report-physics battery-report-packdetail">
          <ReportValue label="风险等级" value={packRiskLabel(pack.riskLevel)} />
          <ReportValue label="拓扑" value={String(pack.topologyLabel ?? "—")} />
          <ReportValue label="内阻极差" value={unit(pack.resistanceSpreadPct, "%", 1)} />
          <ReportValue label="末端压差" value={unit(pack.voltageSpreadMv, " mV", 0)} />
          <ReportValue label="温差" value={unit(pack.temperatureSpreadC, " °C", 1)} />
          <ReportValue label="容量离散 CV" value={unit(pack.capacityCvPct, "%", 2)} />
          <ReportValue label="Pack 可用容量" value={unit(pack.packCapacityAh, " Ah", 1)} />
          <ReportValue label="能量损耗" value={unit(pack.energyLossPct, "%", 1)} />
        </div>
        {weakestCells(pack).length > 0 && <div className="battery-report-weakest">
          <span><b>最弱电芯排序</b>{String(pack.finding ?? "")}</span>
          <ul>
            {weakestCells(pack).map(cell => (
              <li key={cell.cellId}>
                {cell.cellId}{cell.moduleId ? ` · ${cell.moduleId}` : ""} · SOH {format(cell.sohPct, 1)}%
                {cell.capacityDeviationPct === undefined ? "" : ` · 容量偏差 ${format(cell.capacityDeviationPct, 1)}%`}
              </li>
            ))}
          </ul>
        </div>}
        {strings(pack.riskReasons).length > 0 && <p>风险来源：{strings(pack.riskReasons).join("、")}</p>}
        {typeof pack.conclusion === "string" && <p>{pack.conclusion}</p>}
        {strings(pack.recommendations).length > 0 && <ol>{strings(pack.recommendations).map(item => <li key={item}>{item}</li>)}</ol>}
      </ReportDetails>}

      {profile && <ReportDetails title="数据覆盖">
        <div className="battery-report-model">
          <span><b>样本规模</b>{integer(profile.rowCount)} 行 · {integer(profile.cycleCount)} 圈 · {integer(profile.cellCount)} 电芯</span>
          <span><b>电流范围</b>{rangeUnit(ranges?.currentA, " A", 2)}</span>
          <span><b>电压范围</b>{rangeUnit(ranges?.voltageV, " V", 3)}</span>
          <span><b>温度范围</b>{rangeUnit(ranges?.temperatureC, " °C", 1)}</span>
          <span><b>SOH 范围</b>{rangeUnit(ranges?.sohPct, "%", 1)}</span>
          <span><b>容量范围</b>{rangeUnit(ranges?.capacityAh, " Ah", 2)}</span>
        </div>
      </ReportDetails>}

      {routing && <ReportDetails title="风险路由">
        <div className="battery-report-route">
          <span><b>路径</b>{routePath.length ? routePath.join(" → ") : expertLabel(routing.selectedExpert)}</span>
          <span><b>执行专家</b>{strings(routing.executedExperts).map(expertLabel).join("、") || "—"}</span>
          {number(routing.disagreementRatio) !== undefined && <span><b>专家分歧</b>{format(number(routing.disagreementRatio)! * 100, 1)}%{routing.reviewRequired === true ? " · 需复核" : ""}</span>}
          {(standardCandidate || pinnCandidate) && <div className="battery-report-comparison">
            <ReportValue label="标准专家" value={expertLife(standardCandidate)} />
            <ReportValue label="PINN 专家" value={expertLife(pinnCandidate)} />
          </div>}
          {routeReasons.length > 0 && <ul>{routeReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        </div>
      </ReportDetails>}

      {physics && <ReportDetails title="PINN 物理辨识">
        <div className="battery-report-physics">
          <ReportValue label="可辨识度" value={percent(physics.identifiabilityScore)} />
          <ReportValue label="物理融合门" value={percent(physics.physicsBlendGate)} />
          <ReportValue label="物理拟合分" value={percent(physics.physicalFitScore)} />
          <ReportValue label="观测拟合 RMSE" value={formatUnknown(physics.physicalObservationRmse, 4)} />
          <ReportValue label="等效内阻" value={unit(physics.equivalentResistanceOhm, " Ω", 6)} />
          <ReportValue label="有效扩散时间" value={arrayUnit(physics.effectiveDiffusionTimeHours, " h", 2)} />
          <ReportValue label="归一化衰减率" value={unit(physics.normalizedFadeRatePerCycle, "/圈", 7)} />
          <ReportValue label="物理轨迹寿命" value={unit(physics.physicalTrajectoryCycleLife, " 圈", 0)} />
          <ReportValue label="OCV 范围" value={ocvRange(physics)} />
          <ReportValue label="交换倍率" value={unit(physics.exchangeCRate, " C", 3)} />
        </div>
        {typeof physics.interpretation === "string" && <p>{physics.interpretation}</p>}
      </ReportDetails>}

      {(result.modelVersion || rationale.length > 0 || domain) && <ReportDetails title="模型与依据">
        <div className="battery-report-model">
          <span><b>模型版本</b>{String(result.modelVersion ?? "—")}</span>
          <span><b>物理架构</b>{architectureLabel(result.physicsArchitecture)}</span>
          <span><b>运行时</b>{runtimeName(runtime)}</span>
          <span><b>适用域</b>{domainLabel(domain)}</span>
        </div>
        {domainReasons.length > 0 && <ul>{domainReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        {rationale.length > 0 && <ol>{rationale.map(reason => <li key={reason}>{reason}</li>)}</ol>}
      </ReportDetails>}
    </section>
  );
}

function ReportDetails({ title, children }: { title: string; children: React.ReactNode }) {
  return <details><summary><span>{title}</span><ChevronDown size={14} /></summary><div>{children}</div></details>;
}

function ReportValue({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function hasPackDiagnostics(pack: Record<string, unknown>): boolean {
  return pack.riskLevel !== undefined
    || pack.resistanceSpreadPct !== undefined
    || pack.voltageSpreadMv !== undefined
    || weakestCells(pack).length > 0
    || pack.packEnergyKwh !== undefined;
}

function packRiskLabel(value: unknown): string {
  if (value === "high") return "高风险";
  if (value === "review" || value === "medium") return "需关注";
  if (value === "stable" || value === "low") return "一致性稳定";
  return "—";
}

function weakestCells(pack: Record<string, unknown>): Array<{ cellId: string; moduleId: string | undefined; sohPct: number; capacityDeviationPct: number | undefined }> {
  if (!Array.isArray(pack.weakestCells)) return [];
  return pack.weakestCells.flatMap(item => {
    const cell = record(item);
    const sohPct = number(cell?.sohPct);
    return typeof cell?.cellId === "string" && sohPct !== undefined
      ? [{
        cellId: cell.cellId,
        moduleId: typeof cell.moduleId === "string" && cell.moduleId ? cell.moduleId : undefined,
        sohPct,
        capacityDeviationPct: number(cell.capacityDeviationPct),
      }]
      : [];
  });
}

function observationLabel(observation: Record<string, unknown> | undefined): string {
  if (!observation) return "—";
  if (observation.targetSemantics === "right-censored-lower-bound") return "右删失 · 下限";
  if (observation.eventObserved === true) return "EOL 已观测";
  return "观测锚定 + 外推";
}

function expertLife(candidate: Record<string, unknown> | undefined): string {
  const life = number(candidate?.predictedCycleLife);
  if (life === undefined) return "未执行";
  return `${life.toFixed(0)} 圈 · ${confidenceLabel(candidate?.confidence)}`;
}

function rangeUnit(value: unknown, suffix: string, digits: number): string {
  if (!Array.isArray(value) || value.length < 2) return "—";
  const minimum = number(value[0]);
  const maximum = number(value[1]);
  return minimum === undefined || maximum === undefined ? "—" : `${format(minimum, digits)}–${format(maximum, digits)}${suffix}`;
}

function integer(value: unknown): string {
  const parsed = number(value);
  return parsed === undefined ? "—" : parsed.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function confidenceLabel(value: unknown): string {
  if (value === "high") return "高置信";
  if (value === "medium") return "中等置信";
  if (value === "low") return "低置信";
  return "置信待定";
}

function expertLabel(value: unknown): string {
  if (value === "pinn") return "PINN 物理专家";
  if (value === "standard") return "标准寿命专家";
  return String(value ?? "—");
}

function architectureLabel(value: unknown): string {
  if (value === "learnable-spm-pinn") return "可学习 SPM-PINN";
  if (value === "data-expert") return "数据专家";
  return String(value ?? "—");
}

function runtimeName(runtime: Record<string, unknown> | undefined): string {
  if (runtime?.runtime === "rust-ort") return "Rust · ONNX Runtime";
  if (runtime?.actual === "onnx") return "ONNX Runtime";
  return String(runtime?.actual ?? "—");
}

function domainLabel(domain: Record<string, unknown> | undefined): string {
  if (domain?.status === "supported") return "已覆盖";
  if (domain?.status === "out-of-domain") return "域外";
  if (domain?.status === "indeterminate") return "待确认";
  return "—";
}

function ocvRange(physics: Record<string, unknown>): string {
  const minimum = number(physics.ocvMinimumV);
  const span = number(physics.ocvSpanV);
  return minimum === undefined || span === undefined ? "—" : `${format(minimum, 3)}–${format(minimum + span, 3)} V`;
}

function percent(value: unknown): string { const parsed = number(value); return parsed === undefined ? "—" : `${format(parsed * 100, 1)}%`; }
function unit(value: unknown, suffix: string, digits: number): string { const parsed = number(value); return parsed === undefined ? "—" : `${format(parsed, digits)}${suffix}`; }
function arrayUnit(value: unknown, suffix: string, digits: number): string {
  const values = Array.isArray(value) ? value.map(number).filter((item): item is number => item !== undefined) : [];
  return values.length ? `${values.map(item => format(item, digits)).join(" / ")}${suffix}` : "—";
}
function formatUnknown(value: unknown, digits: number): string { const parsed = number(value); return parsed === undefined ? "—" : format(parsed, digits); }
function format(value: number, digits: number): string { return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
