import type { ApplicationScriptTarget, ScriptModule } from "@bim-studio/contracts";
import { Download, MoreHorizontal, Power, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import type { SceneScriptTarget } from "../studio/sceneScriptContext";
import { translate as tr, type AppLocale } from "../i18n";
import { SceneBehaviorTargetPicker } from "./SceneBehaviorTargetPicker";
import "./BehaviorEditorToolbar.css";
import { useDismissableDetails } from "../hooks/useDismissableDetails";

/** 文件元数据和文件操作；运行/窗口布局归工作台标题栏，不在此重复。 */
export function BehaviorEditorToolbar(props: {
  locale: AppLocale;
  draft: ScriptModule;
  targets: readonly SceneScriptTarget[];
  preferredTarget?: SceneScriptTarget;
  dirty: boolean;
  saving: boolean;
  canGenerate: boolean;
  showAutoSave: boolean;
  autoSaveEnabled: boolean;
  onAutoSaveChange: (enabled: boolean) => void;
  onChange: (draft: ScriptModule) => void;
  onTargetChange: (target: ApplicationScriptTarget) => void;
  onSave: () => void;
  onGenerate: () => void;
  onDownload: () => void;
  onRevert: () => void;
  onDelete: () => void;
}) {
  const fileMenuRef = useDismissableDetails<HTMLDetailsElement>();
  const { draft, locale } = props;
  const enabledLabel = tr(locale, draft.enabled ? "停用脚本" : "启用脚本", draft.enabled ? "Disable script" : "Enable script");
  return <div className="behavior-editor-toolbar">
    <label>
      <span className="behavior-field-label">{tr(locale, "名称", "Name")}</span>
      <input aria-label={tr(locale, "脚本名称", "Script name")} title={tr(locale, "脚本名称", "Script name")} value={draft.name} onChange={(event) => props.onChange({ ...draft, name: event.target.value })} />
    </label>
    <SceneBehaviorTargetPicker locale={locale} value={draft.target} targets={props.targets} {...(props.preferredTarget ? { preferredTarget: props.preferredTarget } : {})} onChange={props.onTargetChange} />
    <label className="behavior-enabled" title={enabledLabel}>
      <input aria-label={enabledLabel} type="checkbox" checked={draft.enabled} onChange={(event) => props.onChange({ ...draft, enabled: event.target.checked })} /><Power size={13} aria-hidden="true" />
    </label>
    <button type="button" className="behavior-save-action" aria-label={tr(locale, "保存脚本", "Save script")} title={tr(locale, "保存脚本（Ctrl/Cmd+S）", "Save script (Ctrl/Cmd+S)")} disabled={props.saving || !draft.name.trim()} onClick={props.onSave}>
      <Save size={13} />{tr(locale, props.saving ? "保存中" : "保存", props.saving ? "Saving" : "Save")}
    </button>
    <details ref={fileMenuRef} className="behavior-file-menu">
      <summary aria-label={tr(locale, "文件操作", "File actions")} title={tr(locale, "文件操作", "File actions")}><MoreHorizontal size={14} /></summary>
      <div onClick={(event) => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.parentElement?.removeAttribute("open"); }}>
        {props.showAutoSave && <label><input type="checkbox" checked={props.autoSaveEnabled} onChange={(event) => props.onAutoSaveChange(event.target.checked)} />{tr(locale, "自动保存", "Auto save")}</label>}
        <button type="button" disabled={!props.canGenerate} aria-label={tr(locale, "生成动作脚本草稿", "Generate action script draft")} title={tr(locale, "使用本地动作模板生成，先审查再应用", "Generate from local action templates; review before applying")} onClick={props.onGenerate}><Sparkles size={13} />{tr(locale, "动作草稿", "Action draft")}</button>
        <button type="button" onClick={props.onDownload}><Download size={13} />{tr(locale, "下载当前 JS", "Download current JS")}</button>
        <button type="button" disabled={!props.dirty} onClick={props.onRevert}><RotateCcw size={13} />{tr(locale, "还原修改", "Revert changes")}</button>
        <button type="button" className="danger" aria-label={tr(locale, `删除脚本“${draft.name}”`, `Delete script “${draft.name}”`)} onClick={props.onDelete}><Trash2 size={13} />{tr(locale, "删除脚本", "Delete script")}</button>
      </div>
    </details>
  </div>;
}
