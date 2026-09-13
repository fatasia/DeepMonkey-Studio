import { useEffect, useRef, useState } from "react";
import { Download, Gauge, X } from "lucide-react";
import type { ModelRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { downloadBlob } from "../browserDownload";
import { assessModelQuality, modelParentId, modelVersionChain, OPTIMIZATION_PRESETS, type OptimizationPresetId } from "../optimizer/modelEngineering";
import { ResourceLinkButton } from "./ResourceLinkButton";
import { formatBytes } from "./ModelOptimizerFields";
import "./ProjectResourceDialogs.css";
import "./ModelEngineering.css";

export function ModelEngineeringDialog({ model, models, locale, onClose, onOptimize }: {
  model: ModelRecord; models: readonly ModelRecord[]; locale: AppLocale; onClose: () => void; onOptimize: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preset, setPreset] = useState<OptimizationPresetId>(model.processing?.preset === "custom" ? "balanced" : model.processing?.preset ?? "balanced");
  const chain = modelVersionChain(model, models);
  const statistics = model.processing?.after ?? (model.generation ? { bytes: model.size, triangles: model.generation.build.triangleCount } : { bytes: model.size });
  const quality = assessModelQuality(statistics, preset);
  const missingParent = chain[0] && modelParentId(chain[0]);
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  function exportManifest() {
    const output = { schemaVersion: 1, id: model.id, name: model.name, format: model.format, size: model.size, status: model.status,
      sourceUrl: model.sourceUrl, manifest: model.manifest, processing: model.processing, generation: model.generation,
      versions: chain.map(item => ({ id: item.id, name: item.name, sourceUrl: item.sourceUrl, parentId: modelParentId(item), createdAt: item.createdAt })),
      quality: { target: preset, ...quality, measured: statistics } };
    downloadBlob(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }), `${model.name}.engineering.json`);
  }
  return <dialog ref={dialog} className="project-resource-dialog model-engineering-dialog" aria-label={tr(locale, "模型工程资产", "Model engineering asset")} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{model.name}</h2><button aria-label={tr(locale, "关闭工程资产", "Close engineering asset")} onClick={onClose}><X size={18} /></button></header>
    <div className="model-engineering-body">
      <section><h3>{tr(locale, "工程摘要", "Engineering summary")}</h3><div className="model-engineering-metrics">
        <span>{tr(locale, "文件", "File")}<strong>{formatBytes(model.size)}</strong></span>
        <span>{tr(locale, "三角面", "Triangles")}<strong>{statistics.triangles?.toLocaleString(locale) ?? "—"}</strong></span>
        <span>{tr(locale, "材质", "Materials")}<strong>{("materials" in statistics ? statistics.materials : undefined) ?? "—"}</strong></span>
        <span>LOD<strong>{model.manifest?.lods?.length ?? 0}</strong></span>
      </div></section>
      <section><h3>{tr(locale, "质量检查", "Quality check")}</h3><select aria-label={tr(locale, "目标设备预算", "Target device budget")} value={preset} onChange={event => setPreset(event.target.value as OptimizationPresetId)}>{Object.entries(OPTIMIZATION_PRESETS).map(([id, item]) => <option key={id} value={id}>{tr(locale, item.zh, item.en)}</option>)}</select>
        <p className={`model-quality-status is-${quality.status}`} role="status">{quality.status === "ready" ? tr(locale, "三角面、文件大小与材质数量在预算内", "Triangles, file size and material count are within budget") : quality.status === "unknown" && !quality.issues.length ? tr(locale, "几何统计尚不完整，可进入优化器分析", "Geometry statistics are incomplete. Analyze in the optimizer") : quality.issues.join("；")}</p>
      </section>
      <section><h3>{tr(locale, "版本与来源", "Versions and source")}</h3>{missingParent && <p className="project-resource-error" role="alert">{tr(locale, "来源版本已不可用，无法从原文件重建", "The source version is unavailable; rebuilding is disabled")}</p>}
        <ol className="model-engineering-versions">{chain.map((item, index) => <li key={item.id} className={item.id === model.id ? "is-current" : ""}><div><strong>{`v${item.generation?.revision ?? index + 1}`} · {item.name}</strong><small>{new Date(item.createdAt).toLocaleString(locale)} · {item.id === model.id ? tr(locale, "当前产物", "Current artifact") : tr(locale, "原版本保留", "Previous version retained")}</small></div><button className="button" disabled={item.status !== "ready"} onClick={() => onOptimize(item.id)}><Gauge size={14} />{item.id === model.id ? tr(locale, "继续优化", "Optimize") : tr(locale, "打开此版本", "Open this version")}</button></li>)}</ol>
      </section>
      {model.processing && <details><summary>{tr(locale, "处理配方与文件指纹", "Processing recipe and fingerprints")}</summary><pre>{JSON.stringify({ operation: model.processing.operation, preset: model.processing.preset, inputSha256: model.processing.inputSha256, outputSha256: model.processing.outputSha256 }, null, 2)}{"\n"}{model.processing.optionsJson}{"\n"}{model.processing.layerEditsJson}</pre></details>}
      <div className="model-engineering-actions"><button className="button" onClick={exportManifest}><Download size={14} />{tr(locale, "导出工程清单", "Export engineering manifest")}</button><ResourceLinkButton locale={locale} name={model.name} resource={model} /></div>
    </div><footer><button className="button" onClick={onClose}>{tr(locale, "关闭", "Close")}</button></footer>
  </dialog>;
}
