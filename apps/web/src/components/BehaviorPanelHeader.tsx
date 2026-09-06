import {
  Braces, Bug, CircleStop, ExternalLink, Focus, Maximize2, PanelLeftClose, PanelLeftOpen,
  GitBranch, MoreHorizontal, PackagePlus, PanelRightOpen, Pause, Play, Settings2, Sparkles, StepForward, X,
} from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { BehaviorLayoutMode } from "../appDefaults";
import type { AuthorBehaviorScope } from "../behavior/authorBehaviorDocument";
import "./AuthorBehaviorPreview.css";

interface Props {
  locale: AppLocale;
  layoutMode: BehaviorLayoutMode;
  contextLabel: string;
  dirty: boolean;
  paused: boolean;
  running: boolean;
  hasSession?: boolean;
  canStep: boolean;
  runScope: AuthorBehaviorScope;
  onRunScopeChange: (scope: AuthorBehaviorScope) => void;
  onStep: () => void;
  hasDraft: boolean;
  hasTarget: boolean;
  agentOpen: boolean;
  dependenciesOpen: boolean;
  versionOpen: boolean;
  inspectorOpen: boolean;
  scriptListCollapsed: boolean;
  onLayoutModeChange: (mode: BehaviorLayoutMode) => void;
  onToggleScriptList: () => void;
  onToggleAgent: () => void;
  onToggleDependencies: () => void;
  onToggleVersion: () => void;
  onFocusTarget: () => void;
  onRun: () => void;
  onDebug?: (() => void) | undefined;
  onPauseResume: () => void;
  onStop: () => void;
  onToggleInspector: () => void;
  onClose: () => void;
}

export function BehaviorPanelHeader(props: Props) {
  const runLabel = props.runScope === "current" ? tr(props.locale, "试运行当前脚本", "Test current script") : tr(props.locale, "试运行已启用脚本", "Test enabled scripts");
  return <header className="behavior-panel-header" onKeyDown={event => {
    const menu = (event.target as HTMLElement).closest("details");
    if (event.key !== "Escape" || !menu?.open) return;
    event.preventDefault(); event.stopPropagation(); menu.open = false;
    menu.querySelector("summary")?.focus();
  }}>
    <div className="behavior-panel-heading">
      <span><Braces size={16} /></span>
      <div>
        <strong>{tr(props.locale, "行为脚本", "Behavior scripts")}</strong>
        <em className="behavior-context-badge" title={props.contextLabel}>{props.contextLabel}</em>
      </div>
    </div>
    <nav className="behavior-panel-actions" aria-label={tr(props.locale, "脚本运行操作", "Script runtime actions")}>
      <Action active={!props.scriptListCollapsed} label={props.scriptListCollapsed ? tr(props.locale, "展开脚本列表", "Expand script list") : tr(props.locale, "收起脚本列表", "Collapse script list")} onClick={props.onToggleScriptList} icon={props.scriptListCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />} />
      <details className="behavior-header-menu behavior-layout-menu">
        <summary aria-label={tr(props.locale, "切换窗口布局", "Change window layout")} title={tr(props.locale, "切换窗口布局", "Change window layout")}><PanelRightOpen size={13} /></summary>
        <div>
          <MenuAction active={props.layoutMode === "split"} label={tr(props.locale, "分屏", "Split")} onClick={() => props.onLayoutModeChange("split")} icon={<PanelRightOpen size={13} />} />
          <MenuAction active={props.layoutMode === "float"} label={tr(props.locale, "悬浮", "Float")} onClick={() => props.onLayoutModeChange("float")} icon={<Maximize2 size={13} />} />
          <MenuAction active={props.layoutMode === "window"} label={tr(props.locale, "独立窗口", "Window")} onClick={() => props.onLayoutModeChange("window")} icon={<ExternalLink size={13} />} />
        </div>
      </details>
      {props.hasTarget && <Action label={tr(props.locale, "定位目标", "Focus target")} onClick={props.onFocusTarget} icon={<Focus size={13} />} />}
      <select className="behavior-run-scope" aria-label={tr(props.locale, "试运行范围", "Test run scope")} title={tr(props.locale, "当前只运行所选草稿；全部按页面和对象自动加载已启用脚本。项目依赖始终可用。", "Current runs this draft; enabled scripts mount by page and target. Project dependencies remain available.")} value={props.runScope} onChange={event => props.onRunScopeChange(event.target.value as AuthorBehaviorScope)}><option value="current">{tr(props.locale, "当前", "Current")}</option><option value="enabled">{tr(props.locale, "全部启用", "Enabled")}</option></select>
      <button type="button" className="behavior-run-action" disabled={!props.hasDraft} aria-label={runLabel} title={`${runLabel} · Ctrl+Enter`} onClick={props.onRun}><Play size={13} /><span>{tr(props.locale, "试运行", "Test run")}</span></button>
      {props.running && <Action label={props.paused ? tr(props.locale, "继续运行", "Resume") : tr(props.locale, "暂停运行", "Pause")} onClick={props.onPauseResume} icon={props.paused ? <Play size={13} /> : <Pause size={13} />} />}
      {props.paused && <Action label={tr(props.locale, "推进一帧（1/60 秒，非源码单步）", "Advance one frame (1/60 s, not source stepping)")} disabled={!props.canStep} onClick={props.onStep} icon={<StepForward size={13} />} />}
      {(props.hasSession ?? props.running) && <Action label={tr(props.locale, "停止运行", "Stop")} onClick={props.onStop} icon={<CircleStop size={13} />} />}
      <details className="behavior-header-menu behavior-more-menu">
        <summary aria-label={tr(props.locale, "更多工具", "More tools")} title={tr(props.locale, "更多工具", "More tools")}><MoreHorizontal size={14} /></summary>
        <div>
          {props.onDebug && <button type="button" disabled={!props.hasDraft} title={tr(props.locale, "使用浏览器 DevTools 调试当前脚本的私有运行副本", "Debug a private run of the current script in browser DevTools")} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); props.onDebug?.(); }}><Bug size={13} /><span>{tr(props.locale, "DevTools 调试当前脚本", "Debug current script in DevTools")}</span></button>}
          <MenuAction active={props.agentOpen} label={tr(props.locale, "AI 脚本助手", "AI script assistant")} onClick={props.onToggleAgent} icon={<Sparkles size={13} />} />
          <MenuAction active={props.dependenciesOpen} label={tr(props.locale, "项目依赖", "Project dependencies")} onClick={props.onToggleDependencies} icon={<PackagePlus size={13} />} />
          <MenuAction active={props.versionOpen} label={tr(props.locale, "脚本版本", "Script versions")} onClick={props.onToggleVersion} icon={<GitBranch size={13} />} />
          <MenuAction active={props.inspectorOpen} label={tr(props.locale, "脚本设置", "Script settings")} onClick={props.onToggleInspector} icon={<Settings2 size={13} />} />
        </div>
      </details>
      <Action label={tr(props.locale, "隐藏脚本编辑器", "Hide script editor")} onClick={props.onClose} icon={<X size={14} />} />
    </nav>
  </header>;
}

function MenuAction(props: { label: string; icon: React.ReactNode; active?: boolean; onClick: () => void }) {
  return <button className={props.active ? "active" : ""} type="button" onClick={props.onClick}>{props.icon}<span>{props.label}</span></button>;
}

function Action(props: { label: string; icon: React.ReactNode; active?: boolean; expanded?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={`behavior-icon-action${props.active ? " active" : ""}`} type="button" aria-label={props.label} aria-pressed={props.active} {...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded })} title={props.label} disabled={props.disabled} onClick={props.onClick}>{props.icon}</button>;
}
