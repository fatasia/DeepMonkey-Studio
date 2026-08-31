import { Box, Braces, LayoutDashboard } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

/** 设计工作区共享的三种编辑上下文。 */
export type WorkspaceMode = "2d" | "3d" | "script";

export interface WorkspaceModeSwitchProps {
  locale: AppLocale;
  active: WorkspaceMode;
  /** 当前页面或场景名称，帮助用户确认自己仍在同一交付上下文。 */
  contextLabel: string;
  sceneAvailable?: boolean;
  onSelect2D?: () => void;
  onSelect3D?: () => void;
  onSelectScripts?: () => void;
}

/**
 * 2D、3D、脚本共用同一套导航结构，避免工作台之间出现不同的入口命名和状态反馈。
 * 这里只负责导航，不持有路由或编辑状态；状态仍由上层工作区控制。
 */
export function WorkspaceModeSwitch({
  locale,
  active,
  contextLabel,
  sceneAvailable = true,
  onSelect2D,
  onSelect3D,
  onSelectScripts
}: WorkspaceModeSwitchProps) {
  return (
    <nav className="workspace-mode-switch" aria-label={tr(locale, "编辑模式", "Editor mode")}>
      <span className="workspace-context" title={contextLabel}>
        {active === "2d" ? <LayoutDashboard size={14} /> : active === "3d" ? <Box size={14} /> : <Braces size={14} />}
        {contextLabel}
      </span>
      <button type="button" className={active === "2d" ? "active" : ""} aria-current={active === "2d" ? "page" : undefined} disabled={active === "2d"} onClick={onSelect2D}>
        <LayoutDashboard size={14} />{tr(locale, "二维", "2D")}
      </button>
      <button type="button" className={active === "3d" ? "active" : ""} aria-current={active === "3d" ? "page" : undefined} disabled={!sceneAvailable || active === "3d"} onClick={onSelect3D}>
        <Box size={14} />{tr(locale, "三维", "3D")}
      </button>
      <button type="button" className={active === "script" ? "active" : ""} aria-current={active === "script" ? "page" : undefined} disabled={active === "script"} onClick={onSelectScripts}>
        <Braces size={14} />{tr(locale, "脚本", "Scripts")}
      </button>
    </nav>
  );
}
