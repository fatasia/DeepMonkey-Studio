import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ModelFileStatistics } from "../optimizer/modelOptimizer";
import { assessModelQuality, OPTIMIZATION_PRESETS, type OptimizationPresetId } from "../optimizer/modelEngineering";
import "./ModelEngineering.css";

export function OptimizerEngineeringPanel({ locale, preset, onPreset, statistics, acknowledged, onAcknowledge, busy, source, onReplay }: {
  locale: AppLocale; preset: OptimizationPresetId; onPreset: (id: OptimizationPresetId) => void;
  statistics: ModelFileStatistics | undefined; acknowledged: boolean; onAcknowledge: (value: boolean) => void;
  busy: boolean; source: ModelRecord | undefined; onReplay: () => void;
}) {
  const quality = assessModelQuality(statistics, preset);
  const budget = OPTIMIZATION_PRESETS[preset];
  return <section className="optimizer-engineering" aria-label={tr(locale, "工程质量", "Engineering quality")}>
    <label><strong>{tr(locale, "优化预设", "Optimization preset")}</strong><select aria-label={tr(locale, "优化预设", "Optimization preset")} value={preset} disabled={busy} onChange={event => onPreset(event.target.value as OptimizationPresetId)}>
      {Object.entries(OPTIMIZATION_PRESETS).map(([id, value]) => <option key={id} value={id}>{tr(locale, value.zh, value.en)}</option>)}
    </select></label>
    <small>{tr(locale, "单模型预算", "Per-model budget")} · {budget.triangles.toLocaleString(locale)} {tr(locale, "面", "triangles")} · {budget.bytes / 1024 / 1024} MB · {budget.materials} {tr(locale, "材质", "materials")}</small>
    {statistics && <div className={`model-quality-status is-${quality.status}`} role="status">{quality.status === "ready" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span>{quality.status === "ready" ? tr(locale, "预算检查通过", "Within budget") : quality.issues.join("；")}</span></div>}
    {quality.status === "warning" && <label className="model-quality-ack"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => onAcknowledge(event.target.checked)} />{tr(locale, "确认超出预算并保存", "Allow saving above budget")}</label>}
    {source?.processing && <button className="button" disabled={busy} onClick={onReplay}><RotateCcw size={14} />{tr(locale, "从源文件重放配方", "Rebuild from source recipe")}</button>}
  </section>;
}
