import { useRef, type ChangeEvent } from "react";
import { Braces, PanelLeftClose, Plus, Upload } from "lucide-react";
import type { ScriptModule } from "@bim-studio/contracts";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import type { SceneScriptTarget } from "../studio/sceneScriptContext";
import { runtimeStatus, scriptTargetLabel } from "./sceneBehaviorPanelModel";
import { translate as tr, type AppLocale } from "../i18n";
import "./BehaviorScriptList.css";

export function BehaviorScriptList(props: {
  locale: AppLocale;
  scripts: readonly ScriptModule[];
  entries: readonly SceneBehaviorManagerEntry[];
  targets: readonly SceneScriptTarget[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onCollapse: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <aside className="behavior-script-list" aria-label={tr(props.locale, "脚本文件", "Script files")}>
    <header className="behavior-file-header">
      <strong>{tr(props.locale, "文件", "Files")}</strong><small>{props.scripts.length}</small>
      <button type="button" aria-label={tr(props.locale, "收起文件列表", "Collapse files")} title={tr(props.locale, "收起文件列表", "Collapse files")} onClick={props.onCollapse}><PanelLeftClose size={13} /></button>
    </header>
    <div className="behavior-file-tools">
      <button type="button" onClick={props.onAdd}><Plus size={12} />{tr(props.locale, "新建", "New")}</button>
      <button type="button" onClick={() => input.current?.click()} title={tr(props.locale, "导入 JS，支持多选并保留独立文件", "Import JS; multiple separate files")}><Upload size={12} />{tr(props.locale, "导入", "Import")}</button>
    </div>
    <input ref={input} hidden type="file" accept=".js,.mjs,text/javascript,application/javascript" multiple onChange={props.onImport} />
    {props.scripts.map((script) => {
      const runtime = props.entries.find((entry) => entry.module.id === script.id);
      const status = runtime ? runtimeStatus(runtime.diagnostics.status, props.locale) : tr(props.locale, script.enabled ? "未运行" : "已禁用", script.enabled ? "Not running" : "Disabled");
      return <button type="button" key={script.id} aria-current={script.id === props.selectedId ? "true" : undefined} className={script.id === props.selectedId ? "selected" : ""} onClick={() => props.onSelect(script.id)} title={`${script.name} · ${scriptTargetLabel(script.target, props.targets, props.locale)} · ${status}`}>
        <i className={runtime?.diagnostics.status ?? (script.enabled ? "idle" : "disabled")} aria-hidden="true" /><span><strong>{script.name}</strong></span><small className="behavior-file-status">{status}</small>
      </button>;
    })}
    {!props.scripts.length && <div className="behavior-empty"><Braces size={20} /><strong>{tr(props.locale, "暂无脚本", "No scripts")}</strong><span>{tr(props.locale, "新建或导入 JS", "Create or import JS")}</span></div>}
  </aside>;
}
