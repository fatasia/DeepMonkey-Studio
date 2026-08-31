import { BatteryCharging, BatteryMedium, CheckCircle2, Cpu, Gauge, Route, Wrench } from "lucide-react";
import type {
  EnergyObservation,
  LogisticsExperimentRequest,
  PlantLiteStudyRequest,
  MaintenanceAssessmentRecord,
  MaintenanceModelPackage,
  ProjectRecord,
} from "@bim-studio/contracts";
import type { OperationsSnapshot } from "../api";
import { SecondaryPageBack } from "./SecondaryPageBack";

export type OperationsTab = "maintenance" | "commissioning" | "battery" | "logistics" | "energy" | "whatif";

export const defaultLogistics: LogisticsExperimentRequest = {
  name: "默认产线物流方案",
  agvCount: 6,
  cycleTimeSec: 260,
  chargingMinutesPerHour: 6,
  congestionFactor: 0.18,
  demandPerHour: 72,
  bufferCapacity: 14,
  durationHours: 8,
};

export const defaultPlantLite: PlantLiteStudyRequest = {
  name: "AGV 两工位产线基线",
  templateId: "agv-line-v1",
  agvCount: 4,
  bufferCapacity: 10,
  seed: "plant-lite-baseline",
  replications: 12,
};

export function OperationsHeader({
  project,
  snapshot,
  onBack,
}: {
  project: ProjectRecord;
  snapshot: OperationsSnapshot | undefined;
  onBack: () => void;
}) {
  return (
    <header className="operations-header secondary-page-header">
      <SecondaryPageBack locale="zh-CN" onBack={onBack} />
      <div className="secondary-page-heading-row">
        <div>
          <span className="eyebrow">AI OPERATIONS LOOP</span>
          <h1>智能运营</h1>
          <p>{project.name} · 默认自动留证、门禁与建案，现场只需运行和确认</p>
        </div>
        <div className="operations-summary">
          <span><Wrench size={15} />{snapshot?.deployments.length ?? 0} 维护部署</span>
          <span><Cpu size={15} />虚拟验收</span>
          <span><Route size={15} />{(snapshot?.logisticsExperiments.length ?? 0) + (snapshot?.plantLiteStudies.length ?? 0)} 物流 Study</span>
          <span><BatteryCharging size={15} />{snapshot?.energyInsights.length ?? 0} 能耗洞察</span>
        </div>
      </div>
    </header>
  );
}

export function OperationsTabs({ tab, onChange }: { tab: OperationsTab; onChange: (tab: OperationsTab) => void }) {
  const items: Array<{ id: OperationsTab; label: string; icon: typeof Wrench }> = [
    { id: "maintenance", label: "设备异常与预测维护", icon: Wrench },
    { id: "commissioning", label: "虚拟调试", icon: Cpu },
    { id: "battery", label: "电池健康与寿命", icon: BatteryMedium },
    { id: "logistics", label: "物流仿真", icon: Route },
    { id: "energy", label: "能耗分析", icon: BatteryCharging },
    { id: "whatif", label: "What-if 工况", icon: Gauge },
  ];
  return (
    <nav className="vision-tabs operations-tabs">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => onChange(item.id)}>
            <Icon size={15} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

export function AssessmentCard({
  assessment,
  onDiagnose,
  onCase,
  busy,
}: {
  assessment: MaintenanceAssessmentRecord;
  onDiagnose: () => void;
  onCase: () => void;
  busy: boolean;
}) {
  return (
    <article className={`operations-result ${assessment.riskLevel}`}>
      <div>
        <span>{assessment.decisionStatus === "shadow" ? "影子评估" : assessment.decisionStatus}</span>
        <strong>{assessment.score === undefined ? "—" : `${(assessment.score * 100).toFixed(1)}%`}</strong>
        <small>
          风险：{assessment.riskLevel} · 数据完整率 {(assessment.dataQuality * 100).toFixed(0)}% · 漂移{" "}
          {assessment.driftScore.toFixed(2)}σ
        </small>
      </div>
      <p>{assessment.message}</p>
      <ol>
        {assessment.topContributors.slice(0, 3).map((item) => (
          <li key={item.feature}>
            {item.feature} <b>{item.value}</b>
          </li>
        ))}
      </ol>
      <div className="operations-result-actions">
        <button className="primary" disabled={busy} onClick={onDiagnose}>
          <Cpu size={14} />
          AI 诊断与下一步
        </button>
        {(["warning", "critical"] as const).includes(assessment.riskLevel as "warning" | "critical") && (
          <button disabled={busy} onClick={onCase}>
            <CheckCircle2 size={14} />
            创建维护 Case
          </button>
        )}
      </div>
    </article>
  );
}

export function LogisticsCard({
  result,
}: {
  result: NonNullable<OperationsSnapshot["logisticsExperiments"]>[number];
}) {
  return (
    <article className="operations-result">
      <div>
        <span>最近一次仿真</span>
        <strong>{result.throughputPerHour.toFixed(0)} 件/时</strong>
        <small>
          交付率 {(result.fulfilledRate * 100).toFixed(1)}% · 利用率 {(result.utilization * 100).toFixed(1)}%
        </small>
      </div>
      <p>
        瓶颈：{result.bottleneck} · {result.recommendation}
      </p>
      <ol>
        <li>
          平均 WIP <b>{result.averageWip.toFixed(1)}</b>
        </li>
        <li>
          平均交付时长 <b>{result.leadTimeMinutes.toFixed(1)} 分</b>
        </li>
      </ol>
    </article>
  );
}

export function EnergyCard({ insight }: { insight: NonNullable<OperationsSnapshot["energyInsights"]>[number] }) {
  return (
    <article className={`operations-result ${insight.severity}`}>
      <div>
        <span>单位产量能耗</span>
        <strong>{insight.currentKwhPerUnit.toFixed(3)} kWh/件</strong>
        <small>
          基线 {insight.baselineKwhPerUnit.toFixed(3)} · 偏离 {insight.deviationPercent.toFixed(1)}%
        </small>
      </div>
      <p>可避免能耗约 {insight.avoidableKwh.toFixed(1)} kWh</p>
      <ol>
        {insight.recommendations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    </article>
  );
}

export function OperationsEmpty({ text }: { text: string }) {
  return <div className="operations-empty">{text}</div>;
}

export function ModelEvidence({ model }: { model: MaintenanceModelPackage }) {
  const metrics = Object.entries(model.metrics).slice(0, 3);
  return (
    <div className="operations-model-evidence">
      <div>
        <span>执行引擎</span>
        <strong>{model.artifact.engine === "onnx" ? "ONNX Runtime" : "原生 JSON 权重"}</strong>
      </div>
      <div>
        <span>算法 / 版本</span>
        <strong>{model.algorithm} · {model.version}</strong>
      </div>
      <div>
        <span>训练 / 验证</span>
        <strong>{model.trainRows} / {model.validationRows} 行</strong>
      </div>
      <div>
        <span>门禁状态</span>
        <strong>{model.productionEligible ? "现场决策可用" : "仅影子验证"}</strong>
      </div>
      {metrics.length > 0 && (
        <small>{metrics.map(([key, value]) => `${key} ${Number(value).toFixed(3)}`).join(" · ")}</small>
      )}
    </div>
  );
}

export function defaultEnergyText() {
  return [
    "2026-08-26T08:00:00,120,72,4",
    "2026-08-26T09:00:00,128,75,5",
    "2026-08-26T10:00:00,125,74,4",
    "2026-08-26T11:00:00,122,73,6",
    "2026-08-26T12:00:00,118,84,18",
  ].join("\n");
}

export function parseEnergy(value: string): EnergyObservation[] {
  const rows = value
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const [timestamp, output, energyKwh, idleMinutes] = line.split(",").map((item) => item.trim());
      return {
        timestamp: timestamp || `row-${index + 1}`,
        output: Number(output),
        energyKwh: Number(energyKwh),
        ...(idleMinutes ? { idleMinutes: Number(idleMinutes) } : {}),
      };
    });
  const invalid = rows.some((row) => !Number.isFinite(row.output) || !Number.isFinite(row.energyKwh));
  if (rows.length < 4 || invalid) throw new Error("请至少提供 4 行有效数据：时间,产量,能耗kWh,空转分钟");
  return rows;
}
