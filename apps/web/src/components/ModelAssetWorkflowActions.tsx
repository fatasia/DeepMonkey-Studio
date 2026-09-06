import { ArrowLeft, Plus } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./model-asset-workflow.css";

export function ModelAssetWorkflowActions({ locale, savedModelId, busy, onReturn }: {
  locale: AppLocale; savedModelId?: string | undefined; busy: boolean; onReturn?: ((modelId?: string) => void) | undefined;
}) {
  if (!onReturn) return null;
  return <section className="model-asset-workflow" aria-label={tr(locale, "原场景操作", "Original scene actions")}>
    <button disabled={busy} onClick={() => onReturn()}><ArrowLeft size={14} />{tr(locale, "返回原场景", "Return to scene")}</button>
    <button className="primary" disabled={busy || !savedModelId} onClick={() => onReturn(savedModelId)} title={tr(locale, "添加独立实例；可在场景的模型实例菜单中替换已有素材", "Add an independent instance; replace existing assets from the scene instance menu")}><Plus size={14} />{tr(locale, "添加到原场景", "Add to original scene")}</button>
  </section>;
}
