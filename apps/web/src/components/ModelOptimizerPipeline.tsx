import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { Box, Check, Database, Download, Upload } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { SecondaryPageBack } from "./SecondaryPageBack";

export function ModelOptimizerHeader({ locale, onBack, onViewAssets, onImport, onDownload, onSave, canExport, canSave, busy, saved = false, resultOutdated = false }: {
  locale: AppLocale; onBack: () => void; onImport: () => void; onDownload: () => void; onSave: () => void;
  onViewAssets?: () => void;
  canExport: boolean; canSave: boolean; busy: boolean; saved?: boolean; resultOutdated?: boolean;
}) {
  // 禁用原因必须区分：无结果、参数过期、处理中三种引导完全不同，不能共用一句提示。
  const saveHint = busy
    ? tr(locale, "正在处理中，等待完成后即可保存", "Processing; saving will be available once it finishes")
    : canSave || saved
      ? undefined
      : resultOutdated
        ? tr(locale, "参数已修改，请重新优化后再保存", "Options changed; run optimization again to save")
        : tr(locale, "导入模型并完成处理后可保存到项目素材", "Import and process a model before saving to project assets");
  return <header className="optimizer-header">
    <SecondaryPageBack locale={locale} onBack={onBack} />
    <div><h1>{tr(locale, "模型导入与优化", "Model import & optimization")}</h1></div>
    <div className="optimizer-header-actions">
      <button disabled={busy} onClick={onImport}><Upload size={15} />{tr(locale, "导入 / 转换", "Import / convert")}</button>
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
  const steps: Array<{ label: string; state: PipelineStepState }> = [
    { label: tr(locale, "导入", "Import"), state: hasSource ? "done" : "active" },
    // GLB 直读没有转换环节，明确标出“无需转换”，不冒充已完成。
    { label: tr(locale, "转换", "Convert"), state: !hasSource ? "pending" : converted ? "done" : "skip" },
    { label: tr(locale, "压缩与优化", "Compress & optimize"), state: hasOutput ? "done" : hasSource ? "active" : "pending" },
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
      {!hasSource && <button className="button primary" disabled={busy} title={tr(locale, "支持 GLB、内嵌 glTF、URDF 与机器人 ZIP；其他格式需可用转换器", "GLB, embedded glTF, URDF and robot ZIP; other formats require a converter")} onClick={onImport}><Upload size={14} />{tr(locale, "从文件导入", "Import file")}</button>}
      {project && <label><Box size={14} /><select aria-label={tr(locale, "从项目素材选择模型", "Choose model from project assets")} value={selectedModelId} disabled={busy} onChange={(event) => onSelectModel(event.target.value)}>
        <option value="">{tr(locale, "从项目素材继续优化…", "Optimize a project asset…")}</option>
        {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.format.toUpperCase()}</option>)}
      </select></label>}
    </div>
  </section>;
}
