import { ArrowLeft, Plus, Replace } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./model-asset-workflow.css";

export function ModelAssetWorkflowActions({ locale, savedModelId, busy, onReturn, onSaveAndReturn, canSave = false, blockReason, returnMode = "insert" }: {
  locale: AppLocale; savedModelId?: string | undefined; busy: boolean; onReturn?: ((modelId?: string) => void) | undefined;
  onSaveAndReturn?: (() => void) | undefined; canSave?: boolean; blockReason?: string | undefined; returnMode?: "insert" | "replace";
}) {
  if (!onReturn) return null;
  return <section className="model-asset-workflow" aria-label={tr(locale, "原场景操作", "Original scene actions")}>
    <div className="model-asset-workflow-copy">
      <strong>{tr(locale, "原场景续接", "Continue in scene")}</strong>
      <small>{blockReason ?? (returnMode === "replace"
        ? tr(locale, "自动保存优化结果并替换当前实例；名称、位姿与绑定保留。", "Save the optimized result and replace the current instance while preserving identity, pose and bindings.")
        : tr(locale, "自动保存优化结果并作为新实例插入。", "Save the optimized result and insert it as a new instance."))}</small>
    </div>
    <button disabled={busy} onClick={() => onReturn()}><ArrowLeft size={14} />{tr(locale, "返回原场景", "Return to scene")}</button>
    <button className="primary" disabled={busy || (!savedModelId && !canSave)} onClick={() => savedModelId ? onReturn(savedModelId) : onSaveAndReturn?.()} title={blockReason ?? (returnMode === "replace" ? tr(locale, "保存结果并原位替换当前场景实例", "Save and replace the current scene instance in place") : tr(locale, "保存结果并作为独立模型插入原场景", "Save and insert the result as an independent model"))}>
      {returnMode === "replace" ? <Replace size={14} /> : <Plus size={14} />}
      {returnMode === "replace" ? tr(locale, "应用优化并返回场景", "Apply optimization and return") : tr(locale, "插入并返回场景", "Insert and return to scene")}
    </button>
  </section>;
}
