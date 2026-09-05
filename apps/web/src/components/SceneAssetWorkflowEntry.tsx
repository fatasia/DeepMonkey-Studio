import { Boxes, Gauge } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./model-asset-workflow.css";

export function SceneAssetWorkflowEntry({ locale, busy, onOptimize, onBrowse }: { locale: AppLocale; busy: boolean; onOptimize: () => void; onBrowse: () => void }) {
  return <div className="scene-asset-workflow-entry">
    <button disabled={busy} onClick={onOptimize}><Gauge size={15} />{tr(locale, "保存并导入优化", "Save, import & optimize")}</button>
    <button disabled={busy} onClick={onBrowse}><Boxes size={15} />{tr(locale, "保存并浏览素材库", "Save & browse library")}</button>
    <small>{tr(locale, "先保存当前草稿；失败留在此页。处理完成可返回添加，原模型保留。", "Saves this draft first; stays here if saving fails. Return to add the result; originals stay intact.")}</small>
  </div>;
}
