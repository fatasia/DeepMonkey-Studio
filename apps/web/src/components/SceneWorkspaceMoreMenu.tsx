import { Boxes, Cpu, Eye, FileCog, GitCompareArrows, Import, Link2, MoreHorizontal, WandSparkles } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { RendererCapabilityProbe, RendererReadiness } from "../rendererCapabilities";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { RendererBackend } from "../viewer/ViewerEngine";
import type { StudioFrameCaptureSnapshot, StudioFrameReadbackEntry } from "../viewer/studioFrameCaptureDiagnostics";
import { RendererDiagnosticsDialog } from "./RendererDiagnosticsDialog";
import { SceneExportMenu } from "./SceneExportMenu";
import { useDismissableDetails } from "../hooks/useDismissableDetails";

interface Props {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  rendererDesiredBackend: RendererBackend;
  rendererSwitchPhase: "idle" | "preparing" | "recovering" | "failed";
  rendererSwitchMessage: string | undefined;
  rendererSwitching: boolean;
  rendererDiagnosticsOpen: boolean;
  setRendererDiagnosticsOpen: (open: boolean) => void;
  rendererDiagnostics: {
    checking: boolean;
    probe: RendererCapabilityProbe | undefined;
    readiness: RendererReadiness[];
    performance: FramePerformanceSnapshot | undefined;
    frameCapture: StudioFrameCaptureSnapshot;
    frameReadbacks: readonly StudioFrameReadbackEntry[];
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
  onDrillGuide?: () => void;
  onImportModel?: (() => void) | undefined;
  onDeviceLayout?: (() => void) | undefined;
  onSmartBinding?: (() => void) | undefined;
  onModelDiff?: (() => void) | undefined;
  onRvtImportSettings?: (() => void) | undefined;
}

/** 将低频导入、导出和渲染诊断收进同一处，保证主导航只保留交付动作。 */
export function SceneWorkspaceMoreMenu(props: Props) {
  const detailsRef = useDismissableDetails<HTMLDetailsElement>();
  return (
    <>
      <details ref={detailsRef} className="scene-workspace-more">
      <summary className="button ghost" aria-label={tr(props.locale, "更多场景工具", "More scene tools")} title={tr(props.locale, "更多场景工具", "More scene tools")}>
        <MoreHorizontal size={16} />
        <span className="action-label">{tr(props.locale, "更多", "More")}</span>
      </summary>
      <div className="scene-workspace-more-popover">
        <div className="scene-workspace-more-section">
          <span className="scene-workspace-more-heading">{tr(props.locale, "场景文件", "Scene files")}</span>
          {props.onImportModel && (
            <button type="button" title={tr(props.locale, "支持 IFC、GLB、GLTF、FBX、OBJ、STL、STEP、IGES、RVT", "Supports IFC, GLB, GLTF, FBX, OBJ, STL, STEP, IGES, RVT")} onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; props.onImportModel?.(); }}>
              <Import size={15} /> {tr(props.locale, "导入模型", "Import model")}
            </button>
          )}
          {props.onDeviceLayout && (
            <button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; props.onDeviceLayout?.(); }}>
              <Boxes size={15} /> {tr(props.locale, "批量设备布局", "Batch device layout")}
            </button>
          )}
          {props.onSmartBinding && (
            <button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; props.onSmartBinding?.(); }}>
              <Link2 size={15} /> {tr(props.locale, "设备与测点智能绑定", "Smart asset binding")}
            </button>
          )}
          {props.onModelDiff && (
            <button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; props.onModelDiff?.(); }}>
              <GitCompareArrows size={15} /> {tr(props.locale, "模型版本对比评审", "Model version diff review")}
            </button>
          )}
          {props.onRvtImportSettings && (
            <button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; props.onRvtImportSettings?.(); }}>
              <FileCog size={15} /> {tr(props.locale, "RVT 导入设置", "RVT import settings")}
            </button>
          )}
          <button type="button" onClick={props.onImport}>
            <Import size={15} /> {tr(props.locale, "导入场景", "Import scene")}
          </button>
          <SceneExportMenu
            locale={props.locale}
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
          {props.onDrillGuide && <button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; props.onDrillGuide?.(); }}><WandSparkles size={15} />{tr(props.locale, "钻取向导", "Drill-down guide")}</button>}
        </div>
        <div className="scene-workspace-more-section">
          <span className="scene-workspace-more-heading">{tr(props.locale, "渲染引擎", "Rendering engine")}</span>
          <button
            type="button"
            className={props.rendererDiagnosticsOpen ? "active" : ""}
            onClick={event => {
              const menu = event.currentTarget.closest("details");
              if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
              props.setRendererDiagnosticsOpen(true);
            }}
          >
            <Cpu size={15} />
            {props.rendererSwitching ? tr(props.locale, "正在切换引擎…", "Switching engine…") : tr(props.locale, "渲染引擎设置", "Rendering engine settings")}
          </button>
        </div>
      </div>
      </details>
      {props.rendererDiagnosticsOpen && (
        <RendererDiagnosticsDialog
          locale={props.locale}
          current={props.rendererBackend}
          desired={props.rendererDesiredBackend}
          switchPhase={props.rendererSwitchPhase}
          switchMessage={props.rendererSwitchMessage}
          switching={props.rendererSwitching}
          checking={props.rendererDiagnostics.checking}
          probe={props.rendererDiagnostics.probe}
          readiness={props.rendererDiagnostics.readiness}
          performance={props.rendererDiagnostics.performance}
          frameCapture={props.rendererDiagnostics.frameCapture}
          frameReadbacks={props.rendererDiagnostics.frameReadbacks}
          onClose={() => props.setRendererDiagnosticsOpen(false)}
          onRefresh={props.rendererDiagnostics.refresh}
          onSwitch={props.changeRendererBackend}
        />
      )}
    </>
  );
}
