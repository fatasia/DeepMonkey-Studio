import { Cpu, Eye, Import, MoreHorizontal } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { RendererCapabilityProbe, RendererReadiness } from "../rendererCapabilities";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { RendererDiagnosticsPanel } from "./RendererDiagnosticsPanel";
import { SceneExportMenu } from "./SceneExportMenu";

interface Props {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  rendererSwitching: boolean;
  rendererDiagnosticsOpen: boolean;
  setRendererDiagnosticsOpen: (open: boolean) => void;
  rendererDiagnostics: {
    checking: boolean;
    probe: RendererCapabilityProbe | undefined;
    readiness: RendererReadiness[];
    performance: FramePerformanceSnapshot | undefined;
    refresh: () => void;
  };
  changeRendererBackend: (backend: RendererBackend) => void;
  onImport: () => void;
  onExportLoose: () => void;
  onExportSingle: () => void;
  onExportGlb: () => void;
  onExportFbx: () => void;
  onBrowse: () => void;
  browseDisabled: boolean;
}

/** 将低频导入、导出和渲染诊断收进同一处，保证主导航只保留交付动作。 */
export function SceneWorkspaceMoreMenu(props: Props) {
  return (
    <details className="scene-workspace-more">
      <summary className="button ghost" title={tr(props.locale, "更多场景工具", "More scene tools")}>
        <MoreHorizontal size={16} />
        <span className="action-label">{tr(props.locale, "更多", "More")}</span>
      </summary>
      <div className="scene-workspace-more-popover">
        <div className="scene-workspace-more-section">
          <span className="scene-workspace-more-heading">{tr(props.locale, "场景文件", "Scene files")}</span>
          <button type="button" onClick={props.onImport}>
            <Import size={15} /> {tr(props.locale, "导入场景", "Import scene")}
          </button>
          <SceneExportMenu
            locale={props.locale}
            compact
            onExportLoose={props.onExportLoose}
            onExportSingle={props.onExportSingle}
            onExportGlb={props.onExportGlb}
            onExportFbx={props.onExportFbx}
          />
          {!props.browseDisabled && (
            <button type="button" onClick={props.onBrowse}>
              <Eye size={15} /> {tr(props.locale, "浏览场景", "View scene")}
            </button>
          )}
        </div>
        <div className="scene-workspace-more-section">
          <span className="scene-workspace-more-heading">{tr(props.locale, "渲染与诊断", "Rendering & diagnostics")}</span>
          <button
            type="button"
            className={props.rendererDiagnosticsOpen ? "active" : ""}
            onClick={() => props.setRendererDiagnosticsOpen(!props.rendererDiagnosticsOpen)}
          >
            <Cpu size={15} />
            {props.rendererSwitching ? tr(props.locale, "正在切换…", "Switching…") : tr(props.locale, "渲染能力诊断", "Renderer diagnostics")}
          </button>
          {props.rendererDiagnosticsOpen && (
            <RendererDiagnosticsPanel
              locale={props.locale}
              current={props.rendererBackend}
              switching={props.rendererSwitching}
              checking={props.rendererDiagnostics.checking}
              probe={props.rendererDiagnostics.probe}
              readiness={props.rendererDiagnostics.readiness}
              performance={props.rendererDiagnostics.performance}
              onClose={() => props.setRendererDiagnosticsOpen(false)}
              onRefresh={props.rendererDiagnostics.refresh}
              onSwitch={props.changeRendererBackend}
            />
          )}
        </div>
      </div>
    </details>
  );
}
