import {
  Braces, CircleStop, ExternalLink, Focus, Maximize2, PanelLeftClose, PanelLeftOpen,
  GitBranch, PackagePlus, PanelRightOpen, Pause, Play, Settings2, Sparkles, X,
} from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { BehaviorLayoutMode } from "../appDefaults";

interface Props {
  locale: AppLocale;
  layoutMode: BehaviorLayoutMode;
  contextLabel: string;
  dirty: boolean;
  paused: boolean;
  running: boolean;
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
  onPauseResume: () => void;
  onStop: () => void;
  onToggleInspector: () => void;
  onClose: () => void;
}

export function BehaviorPanelHeader(props: Props) {
  const runLabel = props.dirty
    ? tr(props.locale, "应用并运行", "Apply & run")
    : props.running
      ? tr(props.locale, "重新运行", "Restart")
      : tr(props.locale, "运行已启用", "Run enabled");
  return <header className="behavior-panel-header">
    <div className="behavior-panel-heading">
      <span><Braces size={16} /></span>
      <div>
        <strong>{tr(props.locale, "行为脚本", "Behavior scripts")}</strong>
        <small>{tr(props.locale, "对象行为组件 · Scene SDK · Worker 沙箱", "Object behaviors · Scene SDK · Worker sandbox")}</small>
        <em className="behavior-context-badge">{tr(props.locale, "当前挂载", "Attached")}：{props.contextLabel}</em>
      </div>
    </div>
    <nav className="behavior-panel-actions" aria-label={tr(props.locale, "脚本运行操作", "Script runtime actions")}>
      <Action active={!props.scriptListCollapsed} label={props.scriptListCollapsed ? tr(props.locale, "展开脚本列表", "Expand script list") : tr(props.locale, "收起脚本列表", "Collapse script list")} onClick={props.onToggleScriptList} icon={props.scriptListCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />} />
      <Action active={props.layoutMode === "split"} label={props.layoutMode === "window" ? tr(props.locale, "收回主窗口", "Return to main window") : tr(props.locale, "分屏", "Split")} onClick={() => props.onLayoutModeChange("split")} icon={<PanelRightOpen size={13} />} />
      <Action active={props.layoutMode === "float"} label={tr(props.locale, "悬浮", "Float")} onClick={() => props.onLayoutModeChange("float")} icon={<Maximize2 size={13} />} />
      <Action active={props.layoutMode === "window"} label={tr(props.locale, "独立窗口", "Open in window")} onClick={() => props.onLayoutModeChange("window")} icon={<ExternalLink size={13} />} />
      <Action active={props.agentOpen} label={tr(props.locale, "AI 脚本助手", "AI script assistant")} onClick={props.onToggleAgent} icon={<Sparkles size={13} />} />
      <Action active={props.dependenciesOpen} label={tr(props.locale, "项目依赖", "Project dependencies")} onClick={props.onToggleDependencies} icon={<PackagePlus size={13} />} />
      <Action active={props.versionOpen} label={tr(props.locale, "脚本版本", "Script versions")} onClick={props.onToggleVersion} icon={<GitBranch size={13} />} />
      <Action disabled={!props.hasTarget} label={tr(props.locale, "定位目标", "Focus target")} onClick={props.onFocusTarget} icon={<Focus size={13} />} />
      <Action disabled={!props.hasDraft} label={runLabel} onClick={props.onRun} icon={<Play size={13} />} />
      <Action disabled={!props.running} label={props.paused ? tr(props.locale, "继续运行", "Resume") : tr(props.locale, "暂停运行", "Pause")} onClick={props.onPauseResume} icon={props.paused ? <Play size={13} /> : <Pause size={13} />} />
      <Action disabled={!props.running} label={tr(props.locale, "停止运行", "Stop")} onClick={props.onStop} icon={<CircleStop size={13} />} />
      <Action active={props.inspectorOpen} expanded={props.inspectorOpen} label={tr(props.locale, "脚本设置", "Script settings")} onClick={props.onToggleInspector} icon={<Settings2 size={13} />} />
      <Action label={tr(props.locale, "隐藏脚本编辑器", "Hide script editor")} onClick={props.onClose} icon={<X size={14} />} />
    </nav>
  </header>;
}

function Action(props: { label: string; icon: React.ReactNode; active?: boolean; expanded?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={props.active ? "active" : ""} type="button" aria-label={props.label} aria-pressed={props.active} {...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded })} title={props.label} disabled={props.disabled} onClick={props.onClick}>{props.icon}</button>;
}
