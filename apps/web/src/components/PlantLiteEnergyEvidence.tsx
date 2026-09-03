import { CircleDollarSign, Gauge, Leaf, Zap } from "lucide-react";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { assessPlantLiteComparability } from "./plantLiteScenarioDecisionModel";

export function PlantLiteEnergyEvidence({ latest, baseline }: {
  latest: PlantLiteStudyRecord;
  baseline: PlantLiteStudyRecord | undefined;
}) {
  const energy = latest.outcome.energy;
  if (!energy) return <section className="plant-energy-evidence is-empty">
    <header><span><Zap size={14} /><strong>能耗与经济证据</strong></span><small>当前记录未配置功率、电价或排放因子</small></header>
  </section>;
  const consumers = Object.entries(energy.consumerEnergyKwh)
    .sort(([, left], [, right]) => right.mean - left.mean)
    .slice(0, 4);
  const baselineEnergy = baseline?.outcome.energy;
  const comparable = baseline && baselineEnergy ? assessPlantLiteComparability(latest, baseline).comparable : false;
  const unitSamples = energy.energyPerCompletedItemKwh.samples;
  const unitEvidenceAvailable = unitSamples > 0;
  const completeUnitEvidence = unitSamples === latest.outcome.completedReplications && latest.outcome.status === "completed";
  const unitDelta = comparable && baselineEnergy && completeUnitEvidence
    && baselineEnergy.energyPerCompletedItemKwh.samples === baseline.outcome.completedReplications
    ? percentDelta(energy.energyPerCompletedItemKwh.mean, baselineEnergy.energyPerCompletedItemKwh.mean)
    : undefined;
  const idleShare = energy.totalEnergyKwh.mean > 0 ? energy.idleEnergyKwh.mean / energy.totalEnergyKwh.mean : 0;
  return <section className="plant-energy-evidence" aria-label="Plant 能耗成本与碳排证据">
    <header>
      <span><Zap size={14} /><strong>能耗与经济证据</strong></span>
      <small>{Object.keys(energy.consumerEnergyKwh).length} 个用能对象 · {energyEvidenceBasis(latest)} · 逐时间片积分 · 95% CI</small>
    </header>
    <div className="plant-energy-metrics">
      <EvidenceMetric icon={Zap} label="建模电量" value={`${energy.totalEnergyKwh.mean.toFixed(1)} kWh`} detail={`待机占比 ${(idleShare * 100).toFixed(0)}%`} />
      <EvidenceMetric icon={Gauge} label="单位能耗" value={unitEvidenceAvailable ? `${energy.energyPerCompletedItemKwh.mean.toFixed(3)} kWh/件` : "—"} detail={unitEvidenceDetail(unitDelta, unitSamples, latest.outcome.completedReplications)} tone={unitDelta === undefined ? undefined : unitDelta <= 0 ? "good" : "bad"} />
      <EvidenceMetric icon={CircleDollarSign} label="单位电费" value={unitEvidenceAvailable ? `¥${energy.electricityCostPerCompletedItem.mean.toFixed(3)}/件` : "—"} detail={unitEvidenceAvailable ? `合计 ¥${energy.electricityCost.mean.toFixed(1)}` : "没有完成件，不能归一化"} />
      <EvidenceMetric icon={Leaf} label="单位碳排" value={unitEvidenceAvailable ? `${energy.carbonEmissionPerCompletedItemKg.mean.toFixed(3)} kgCO₂e/件` : "—"} detail={unitEvidenceAvailable ? `合计 ${energy.carbonEmissionKg.mean.toFixed(1)} kgCO₂e` : "没有完成件，不能归一化"} />
      <EvidenceMetric icon={Gauge} label="峰值需量" value={`${energy.peakDemandKw.mean.toFixed(1)} kW`} detail={`CI ${energy.peakDemandKw.lower95.toFixed(1)}–${energy.peakDemandKw.upper95.toFixed(1)}`} />
    </div>
    {consumers.length ? <div className="plant-energy-consumers">
      <span>主要用能对象</span>
      {consumers.map(([id, interval]) => <div key={id}><b>{consumerName(latest, id)}</b><span>{interval.mean.toFixed(1)} kWh</span><small>{energy.totalEnergyKwh.mean > 0 ? `${(interval.mean / energy.totalEnergyKwh.mean * 100).toFixed(0)}%` : "0%"}</small></div>)}
    </div> : null}
  </section>;
}

function EvidenceMetric({ icon: Icon, label, value, detail, tone }: {
  icon: typeof Zap;
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "bad" | undefined;
}) {
  return <div className={tone ? `is-${tone}` : ""}><span><Icon size={12} />{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function consumerName(study: PlantLiteStudyRecord, id: string): string {
  return study.model?.nodes.find((node) => node.id === id)?.name
    ?? study.model?.resources?.find((resource) => resource.id === id)?.name
    ?? id;
}

function percentDelta(current: number, baseline: number): number | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return undefined;
  return (current - baseline) / Math.abs(baseline) * 100;
}

function unitEvidenceDetail(delta: number | undefined, samples: number, completedReplications: number): string {
  if (!samples) return "没有完成件，不能归一化";
  if (samples < completedReplications) return `${samples}/${completedReplications} 次运行有完成件，不参与方案推荐`;
  if (delta === undefined) return "暂无同条件基线";
  return `${delta <= 0 ? "降低" : "增加"} ${Math.abs(delta).toFixed(1)}%`;
}

function energyEvidenceBasis(study: PlantLiteStudyRecord): string {
  const model = study.model;
  if (!model) return "参数依据未知";
  const sources = [
    model.energyEconomics?.source ?? "estimate",
    ...model.nodes.flatMap((node) => node.kind === "station" && node.power ? [node.power.source ?? "estimate"] : []),
    ...(model.resources ?? []).flatMap((resource) => resource.power ? [resource.power.source ?? "estimate"] : []),
  ];
  if (sources.every((source) => source === "measured")) return "实测口径";
  if (sources.some((source) => source === "estimate")) return "含工程估值";
  return "项目 / 铭牌口径";
}
