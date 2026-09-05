import { ArrowLeft, Plus } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./model-asset-workflow.css";

export function ModelAssetWorkflowActions({ locale, savedModelId, busy, onReturn }: {
  locale: AppLocale; savedModelId?: string | undefined; busy: boolean; onReturn?: ((modelId?: string) => void) | undefined;
}) {
  if (!onReturn) return null;
  return <section className="model-asset-workflow" aria-label={tr(locale, "原场景操作", "Original scene actions")}>
    <div><strong>{tr(locale, "来自场景编辑器", "From scene editor")}</strong><small>{tr(locale, "原稿已保存；优化仅创建新素材。", "Draft saved; optimization creates a new asset only.")}</small></div>
    <button disabled={busy} onClick={() => onReturn()}><ArrowLeft size={14} />{tr(locale, "返回原场景", "Return to scene")}</button>
    <button className="primary" disabled={busy || !savedModelId} onClick={() => onReturn(savedModelId)}><Plus size={14} />{tr(locale, "添加到原场景", "Add to original scene")}</button>
    <span className="model-asset-replace-note" title={tr(locale, "当前模型资源与场景对象共用 ID；暂不能保证替换的引用保留与完整撤销。请先添加新素材核对。", "Assets and scene objects share one ID; replacement cannot yet preserve all references and undo. Add the new asset for review.")}>{tr(locale, "保留原模型，不替换实例", "Keeps original; no instance replacement")}</span>
  </section>;
}
