import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { Box, Check, Database, Download, Gauge, Upload } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { SecondaryPageBack } from "./SecondaryPageBack";

export function ModelOptimizerHeader({ locale, onBack, onImport, onDownload, onSave, canExport, canSave, busy }: {
  locale: AppLocale; onBack: () => void; onImport: () => void; onDownload: () => void; onSave: () => void;
  canExport: boolean; canSave: boolean; busy: boolean;
}) {
  return <header className="optimizer-header">
    <SecondaryPageBack locale={locale} onBack={onBack} />
    <div><span className="eyebrow">MODEL ASSET PIPELINE</span><h1>{tr(locale, "模型导入与优化", "Model import & optimization")}</h1></div>
    <div className="optimizer-header-actions">
      <button disabled={busy} onClick={onImport}><Upload size={15} />{tr(locale, "导入 / 转换", "Import / convert")}</button>
      <button disabled={!canExport} onClick={onDownload}><Download size={15} />{tr(locale, "下载 GLB", "Download GLB")}</button>
      <button className="primary" disabled={!canSave} onClick={onSave}><Database size={15} />{tr(locale, "保存到项目素材", "Save to project assets")}</button>
    </div>
  </header>;
}

export function ModelOptimizerPipeline({ locale, project, models, selectedModelId, onSelectModel, onImport, hasSource, hasOutput, saved, busy }: {
  locale: AppLocale; project: ProjectRecord | undefined; models: ModelRecord[]; selectedModelId: string; onSelectModel: (id: string) => void;
  onImport: () => void; hasSource: boolean; hasOutput: boolean; saved: boolean; busy: boolean;
}) {
  const steps = [
    [tr(locale, "导入", "Import"), hasSource], [tr(locale, "转换", "Convert"), hasSource],
    [tr(locale, "压缩与优化", "Compress & optimize"), hasOutput], [tr(locale, "项目素材", "Project assets"), saved],
  ] as const;
  return <section className="optimizer-pipeline" aria-label={tr(locale, "模型素材处理链路", "Model asset pipeline")}>
    <div className="optimizer-pipeline-steps">{steps.map(([label, done], index) => <span className={done ? "done" : hasSource || index === 0 ? "active" : ""} key={label}>{done ? <Check size={11} /> : index + 1}<b>{label}</b></span>)}</div>
    {!hasSource && <div className="optimizer-source-actions">
      <button className="primary" disabled={busy} onClick={onImport}><Upload size={14} />{tr(locale, "从文件导入", "Import file")}</button>
      {project && <label><Box size={14} /><select aria-label={tr(locale, "从项目素材选择模型", "Choose model from project assets")} value={selectedModelId} disabled={busy} onChange={(event) => onSelectModel(event.target.value)}>
        <option value="">{tr(locale, "从项目素材继续优化…", "Optimize a project asset…")}</option>
        {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.format.toUpperCase()}</option>)}
      </select></label>}
    </div>}
    {!hasSource && <div className="optimizer-start-guide"><strong>{tr(locale, "导入、转换、压缩和优化现在是一条素材链路", "Import, conversion, compression and optimization now form one asset pipeline")}</strong><ol><li>{tr(locale, "支持平台全部模型格式，先统一转换为 GLB 工作格式", "Supports all platform model formats and converts them to a GLB working format")}</li><li>{tr(locale, "按交付目标减面、压缩贴图、烘焙和清理", "Simplify, compress textures, bake lighting and clean data")}</li><li>{tr(locale, "对比结果后直接保存到当前项目素材库", "Compare the result and save it directly to project assets")}</li></ol><small>{tr(locale, "GLB/glTF 可直接本地处理；其他格式通过项目转换服务处理。", "GLB/glTF can be processed locally; other formats use the project conversion service.")}</small></div>}
  </section>;
}
