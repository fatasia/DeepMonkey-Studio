import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { Box, Check, Database, Download, Upload } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import { SecondaryPageBack } from "./SecondaryPageBack";

export function ModelOptimizerHeader({ locale, onBack, onViewAssets, onImport, onDownload, onSave, canExport, canSave, busy, saved = false, resultOutdated = false, saveBlockReason }: {
  locale: AppLocale; onBack: () => void; onImport: () => void; onDownload: () => void; onSave: () => void;
  onViewAssets?: () => void;
  canExport: boolean; canSave: boolean; busy: boolean; saved?: boolean; resultOutdated?: boolean;
  saveBlockReason?: string | undefined;
}) {
  // 禁用原因必须区分：无结果、参数过期、处理中三种引导完全不同，不能共用一句提示。
  const saveHint = saveBlockReason ?? (busy
    ? tr(locale, "正在处理中，等待完成后即可保存", "Processing; saving will be available once it finishes")
    : canSave || saved
      ? undefined
      : resultOutdated
        ? tr(locale, "参数已修改，请重新优化后再保存", "Options changed; run optimization again to save")
        : tr(locale, "导入模型并完成处理后可保存到项目素材", "Import and process a model before saving to project assets"));
  return <header className="optimizer-header">
    <SecondaryPageBack locale={locale} onBack={onBack} />
    <div><h1>{tr(locale, "模型导入与优化", "Model import & optimization")}</h1></div>
    <div className="optimizer-header-actions">
      <button disabled={busy} onClick={onImport}><Upload size={15} />{tr(locale, "导入模型", "Import model")}</button>
      <button disabled={!canExport} onClick={onDownload}><Download size={15} />{tr(locale, "下载 GLB", "Download GLB")}</button>
      <button className="primary" disabled={!canSave && !saved} title={saveHint} onClick={saved ? onViewAssets ?? onBack : onSave}><Database size={15} />{saved ? tr(locale, "查看项目素材", "View project assets") : tr(locale, "保存到项目素材", "Save to project assets")}</button>
    </div>
  </header>;
}

/** 流水线步骤三态：done=已完成、active=当前可做、skip=该输入无需此步、pending=未开始。 */
type PipelineStepState = "done" | "active" | "skip" | "pending";

export function ModelOptimizerPipeline({ locale, project, models, selectedModelId, onSelectModel, onImport, hasSource, converted, hasOutput, saved, busy }: {
  locale: AppLocale; project: ProjectRecord | undefined; models: ModelRecord[]; selectedModelId: string; onSelectModel: (id: string) => void;
  onImport: () => void; hasSource: boolean; converted: boolean; hasOutput: boolean; saved: boolean; busy: boolean;
}) {
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetPickerPosition, setAssetPickerPosition] = useState<{ left: number; top: number; width: number }>();
  const assetPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const filteredModels = useMemo(() => {
    const query = assetQuery.trim().toLocaleLowerCase();
    return query ? models.filter(model => `${model.name} ${model.format}`.toLocaleLowerCase().includes(query)) : models;
  }, [assetQuery, models]);
  const selectedModel = models.find(model => model.id === selectedModelId);
  useEffect(() => {
    if (!assetPickerOpen) {
      setAssetPickerPosition(undefined);
      return;
    }
    const updatePosition = () => {
      const trigger = assetPickerTriggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(360, Math.max(260, window.innerWidth - margin * 2));
      const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
      const estimatedHeight = Math.min(320, Math.max(160, window.innerHeight - margin * 2));
      const below = window.innerHeight - rect.bottom - margin;
      const top = below >= 220 || rect.top <= estimatedHeight + margin
        ? rect.bottom + 6
        : Math.max(margin, rect.top - estimatedHeight - 6);
      setAssetPickerPosition({ left, top, width });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [assetPickerOpen]);
  useEffect(() => {
    if (!assetPickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAssetPickerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [assetPickerOpen]);
  const steps: Array<{ label: string; state: PipelineStepState }> = [
    { label: tr(locale, "导入", "Import"), state: hasSource ? "done" : "active" },
    // GLB 直读没有转换环节，明确标出“无需转换”，不冒充已完成。
    { label: tr(locale, "转换", "Convert"), state: !hasSource ? "pending" : converted ? "done" : "skip" },
    { label: tr(locale, "编辑与优化", "Edit & optimize"), state: hasOutput ? "done" : hasSource ? "active" : "pending" },
    { label: tr(locale, "项目素材", "Project assets"), state: saved ? "done" : "pending" },
  ];
  return <section className="optimizer-pipeline" aria-label={tr(locale, "模型素材处理链路", "Model asset pipeline")}>
    <div className="optimizer-pipeline-steps">{steps.map(({ label, state }, index) => (
      <span className={state} key={label} title={state === "skip" ? tr(locale, "该模型无需转换", "No conversion required for this model") : undefined}>
        {state === "done" ? <Check size={11} /> : state === "skip" ? tr(locale, "免", "N/A") : index + 1}
        <b>{label}</b>
      </span>
    ))}</div>
    <div className="optimizer-source-actions">
      {!hasSource && <button className="button primary" disabled={busy} onClick={onImport}><Upload size={14} />{tr(locale, "从文件导入", "Import file")}</button>}
      {project && <div className="optimizer-asset-picker">
        <button ref={assetPickerTriggerRef} type="button" className="optimizer-asset-picker-trigger" disabled={busy} onClick={() => setAssetPickerOpen(open => !open)} aria-expanded={assetPickerOpen} aria-haspopup="dialog">
          <Box size={14} />
          <span>{selectedModel ? selectedModel.name : tr(locale, "从项目素材选择模型", "Choose a project asset")}</span>
          <small>{selectedModel ? selectedModel.format.toUpperCase() : tr(locale, "浏览全部", "Browse all")}</small>
        </button>
        {assetPickerOpen && assetPickerPosition && createPortal(
          <div className="optimizer-asset-picker-panel" role="dialog" aria-label={tr(locale, "项目素材选择器", "Project asset picker")} style={{ left: assetPickerPosition.left, top: assetPickerPosition.top, width: assetPickerPosition.width }}>
            <input autoFocus value={assetQuery} onChange={event => setAssetQuery(event.target.value)} placeholder={tr(locale, "搜索项目模型", "Search project models")} aria-label={tr(locale, "搜索项目模型", "Search project models")} />
            <div className="optimizer-asset-picker-list">
              {filteredModels.length ? filteredModels.map(model => <button type="button" key={model.id} className={model.id === selectedModelId ? "selected" : ""} onClick={() => { onSelectModel(model.id); setAssetPickerOpen(false); }}>
                <span className="optimizer-asset-picker-icon"><Box size={16} /></span>
                <span><b>{model.name}</b><small>{model.format.toUpperCase()} · {(model.size / 1024 / 1024).toFixed(1)} MB</small></span>
                <em>{model.status === "ready" ? tr(locale, "可用", "Ready") : model.status}</em>
              </button>) : <p>{tr(locale, "没有匹配的项目模型", "No matching project models")}</p>}
            </div>
          </div>,
          document.body,
        )}
      </div>}
    </div>
  </section>;
}
