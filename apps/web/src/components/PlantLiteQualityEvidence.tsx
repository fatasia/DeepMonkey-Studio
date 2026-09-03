import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { BadgeCheck, ShieldQuestion } from "lucide-react";
import "./PlantLiteQualityEvidence.css";

export function PlantLiteQualityEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const stations = (result.model?.nodes ?? []).filter((node) => node.kind === "station" && node.yieldRate !== undefined);
  if (!stations.length && !result.outcome.quality) return null;
  const quality = result.outcome.quality;
  if (!quality) return <section className="plant-quality-evidence is-missing">
    <header><span><ShieldQuestion size={15} />质量证据缺失</span><small>模型配置了工位良率</small></header>
    <p className="plant-quality-evidence-note">这条旧记录没有质量统计；重新运行即可生成报废量、合格产出和一次通过率区间。</p>
  </section>;
  return <section className="plant-quality-evidence" aria-label="工位良率与报废证据">
    <header><span><BadgeCheck size={15} />质量与报废</span><small>正式统计窗口 · 95% CI</small></header>
    <div className="plant-quality-evidence-metrics">
      <QualityMetric label="合格产出" interval={quality.goodOutputItems} unit="件" />
      <QualityMetric label="报废" interval={quality.scrapItems} unit="件" />
      <QualityMetric label="系统一次通过率" interval={quality.firstPassYield} percent />
    </div>
    <div className="plant-quality-stations">
      {stations.map((station) => {
        if (station.kind !== "station") return null;
        const metric = quality.stationMetrics95[station.id];
        return <div key={station.id}>
          <span title={station.name}>{station.name}</span>
          <strong>{metric ? `${(metric.firstPassYield.mean * 100).toFixed(1)}%` : "无样本"}</strong>
          <small>配置 {((station.yieldRate ?? 1) * 100).toFixed(1)}% · 检验 {metric?.inspectedItems.mean.toFixed(1) ?? "0"} · 报废 {metric?.scrapItems.mean.toFixed(1) ?? "0"}</small>
        </div>;
      })}
    </div>
    <p className="plant-quality-evidence-note">系统口径：合格产出 ÷（合格产出 + 工位报废）；未处置在制品不入分母。报废立即退出系统，当前不含返工循环。</p>
  </section>;
}

function QualityMetric({ label, interval, unit, percent = false }: {
  label: string;
  interval: PlantLiteConfidenceInterval;
  unit?: string;
  percent?: boolean;
}) {
  const scale = percent ? 100 : 1;
  const suffix = percent ? "%" : ` ${unit ?? ""}`;
  return <div><span>{label}</span><strong>{(interval.mean * scale).toFixed(1)}{suffix}</strong><small>95% CI {(interval.lower95 * scale).toFixed(1)}–{(interval.upper95 * scale).toFixed(1)} · n={interval.samples}</small></div>;
}
