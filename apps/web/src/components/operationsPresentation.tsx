import { ArrowRight, BatteryCharging, BatteryMedium, CheckCircle2, Cpu, Database, FileUp, Gauge, RefreshCw, Route, Wrench } from "lucide-react";
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
import { createDefaultPlantLiteRequest } from "./plantLiteModelEditing";

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

export const defaultPlantLite: PlantLiteStudyRequest = createDefaultPlantLiteRequest();

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
      <div className="secondary-page-heading-row">
        <SecondaryPageBack locale="zh-CN" onBack={onBack} />
        <div>
          <span className="eyebrow">生产优化与验证</span>
          <h1>智能运营</h1>
          <p>{project.name} · 从现场数据到规划、验证和改进，按任务一步步完成</p>
        </div>
        <div className="operations-summary">
          <span><Wrench size={15} />{snapshot?.deployments.length ?? 0} 维护部署</span>
          <span><Cpu size={15} />虚拟验收</span>
          <span><Route size={15} />{(snapshot?.logisticsExperiments.length ?? 0) + (snapshot?.plantLiteStudies.length ?? 0)} 规划结果</span>
          <span><BatteryCharging size={15} />{snapshot?.energyInsights.length ?? 0} 能耗洞察</span>
        </div>
      </div>
    </header>
  );
}

export function OperationsTabs({ tab, onChange }: { tab: OperationsTab; onChange: (tab: OperationsTab) => void }) {
  const items: Array<{ id: OperationsTab; label: string; icon: typeof Wrench }> = [
    { id: "maintenance", label: "预测维护", icon: Wrench },
    { id: "commissioning", label: "机器人与控制验证", icon: Cpu },
    { id: "battery", label: "电池分析", icon: BatteryMedium },
    { id: "logistics", label: "工厂规划", icon: Route },
    { id: "energy", label: "能耗分析", icon: BatteryCharging },
    { id: "whatif", label: "工况推演", icon: Gauge },
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
  const scorePercent = assessment.score === undefined ? undefined : Math.max(0, Math.min(100, assessment.score * 100));
  const qualityPercent = Math.max(0, Math.min(100, assessment.dataQuality * 100));
  const contributors = assessment.topContributors.slice(0, 3);
  const contributorPeak = Math.max(1, ...contributors.map((item) => Math.abs(item.value)));
  return (
    <article className={`operations-result ${assessment.riskLevel}`}>
      <div className="maintenance-risk-overview">
        <div
          className="maintenance-risk-ring"
          role="img"
          aria-label={`风险评分 ${scorePercent === undefined ? "无结果" : `${scorePercent.toFixed(1)}%`}`}
          style={{ background: `conic-gradient(currentColor ${scorePercent ?? 0}%, #253238 0)` }}
        >
          <i><strong>{scorePercent === undefined ? "—" : scorePercent.toFixed(1)}</strong><small>%</small></i>
        </div>
        <div className="maintenance-risk-kpis">
          <span>{assessment.decisionStatus === "shadow" ? "影子评估" : assessment.decisionStatus}</span>
          <strong>{assessment.riskLevel}</strong>
          <small>当前风险等级</small>
        </div>
        <div className="maintenance-risk-kpis">
          <span>数据完整率</span>
          <strong>{qualityPercent.toFixed(0)}%</strong>
          <i><b style={{ width: `${qualityPercent}%` }} /></i>
        </div>
        <div className="maintenance-risk-kpis">
          <span>数据漂移</span>
          <strong>{assessment.driftScore.toFixed(2)}σ</strong>
          <small>{assessment.driftScore >= 2 ? "需要复核" : "处于可用范围"}</small>
        </div>
      </div>
      <p>{assessment.message}</p>
      {contributors.length > 0 && (
        <div className="maintenance-contributor-chart" role="img" aria-label="风险贡献因子对比">
          {contributors.map((item) => (
            <div key={item.feature}>
              <span title={item.feature}>{item.feature}</span>
              <i><b style={{ width: `${Math.max(4, Math.abs(item.value) / contributorPeak * 100)}%` }} /></i>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="operations-result-actions">
        <button className="primary" disabled={busy} onClick={onDiagnose}>
          <Cpu size={14} />
          AI 诊断与下一步
        </button>
        {(["warning", "critical"] as const).includes(assessment.riskLevel as "warning" | "critical") && (
          <button disabled={busy} onClick={onCase}>
            <CheckCircle2 size={14} />
            创建维护处置
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

export function MaintenanceModelOnboarding({
  busy,
  onImport,
  onOpenDataCenter,
}: {
  busy: boolean;
  onImport: () => void;
  onOpenDataCenter: () => void;
}) {
  return (
    <section className="operations-onboarding" aria-label="维护模型接入">
      <div className="operations-onboarding-heading">
        <span><Wrench size={18} /></span>
        <div>
          <strong>先接入可执行维护模型</strong>
          <small>接入模型后选择生产数据，运行风险评估并生成可追溯维护处置。</small>
        </div>
      </div>
      <div className="operations-onboarding-actions">
        <button disabled={busy} onClick={onImport}>
          <FileUp size={15} />
          <span><b>导入模型 JSON</b><small>接入已有训练模型定义</small></span>
          <ArrowRight size={14} />
        </button>
      </div>
      <button className="operations-data-link" onClick={onOpenDataCenter}>
        <Database size={14} />
        还没有生产数据？前往数据中心连接数据库
        <ArrowRight size={13} />
      </button>
    </section>
  );
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
