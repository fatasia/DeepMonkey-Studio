import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Box, ChevronDown, ChevronUp, Database, GripHorizontal, LoaderCircle, Maximize2, PanelLeftClose, PanelRightClose, X } from "lucide-react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { OperationsSnapshot } from "../api";
import { ScenePlantQuickRun, type ScenePlantQuickRunProps } from "./ScenePlantQuickRun";
import { translate as tr, type AppLocale } from "../i18n";
import { useSceneSimulationLayout } from "../simulation/useSceneSimulationLayout";
import type { SimulationDockReservation } from "../simulation/sceneSimulationLayout";
export { constrainPanelLayout } from "../simulation/sceneSimulationLayout";
import {
  SCENE_SIMULATION_PANELS,
  sceneSimulationPanel,
  type SceneSimulationPanelId,
} from "../simulation/sceneSimulationRegistry";

const OperationsCenter = lazy(() => import("./OperationsCenter").then((module) => ({ default: module.OperationsCenter })));
interface Props {
  locale: AppLocale;
  panelId: SceneSimulationPanelId;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  activeScene?: SceneSnapshot;
  selectedObjectId?: string;
  selectedObjectName?: string;
  previewSnapshot?: OperationsSnapshot;
  sceneFlow?: Omit<ScenePlantQuickRunProps, "projectId" | "scene" | "selectedObjectId">;
  onPanelChange: (panel: SceneSimulationPanelId) => void;
  onOpenEvidence: () => void;
  onOpenDataCenter: () => void;
  onOpenSceneTarget: (sceneId: string, objectId: string) => void;
  onClose: () => void;
  onDockChange?: (reservation: SimulationDockReservation) => void;
}

/**
 * 3D 编辑器中的仿真插件宿主。业务引擎与 Study 仍由 OperationsCenter 统一提供。
 */
export function SceneSimulationPanel(props: Props) {
  const panel = sceneSimulationPanel(props.panelId);
  const layout = useSceneSimulationLayout(props.onDockChange);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const collapsed = layout.collapsed;
  const [advancedFlow, setAdvancedFlow] = useState(false);
  const hasSceneFlow = Boolean(props.sceneFlow && props.activeScene);
  const showSceneFlow = hasSceneFlow && props.panelId === "logistics" && !advancedFlow;
  const orderedScenes = useMemo(() => {
    if (!props.activeScene) return props.scenes;
    return [props.activeScene, ...props.scenes.filter((scene) => scene.id !== props.activeScene?.id)];
  }, [props.activeScene, props.scenes]);

  function collapse() { collapseButton.current?.focus(); layout.collapse(true); }

  return (
    <aside ref={layout.panelRef} style={layout.style} data-placement={layout.placement} className={`scene-simulation-panel${collapsed ? " is-collapsed" : ""}${layout.docked ? " is-docked" : ""}`} aria-label={tr(props.locale, "场景仿真插件", "Scene simulation plugin")}
      onKeyDown={event => { if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return; event.preventDefault(); event.stopPropagation(); collapse(); }}>
      <header
        className="scene-simulation-header"
        title={layout.docked ? tr(props.locale, "停靠为视口留出空间；Esc 收起并保留表单", "Docking reserves viewport space; Escape collapses without clearing inputs") : tr(props.locale, "拖动窗口；右下角可调整大小", "Drag the window; resize from the bottom-right corner")}
        onPointerDown={(event) => layout.begin("move", event)}
        onPointerMove={layout.move}
        onPointerUp={layout.finish}
        onPointerCancel={layout.finish}
      >
        <div className="scene-simulation-title">
          <span>{panel.eyebrow}</span>
          <div>
            <strong title={tr(props.locale, panel.label, panel.englishLabel)}>{tr(props.locale, panel.label, panel.englishLabel)}</strong>
            <small title={tr(props.locale, panel.description, panel.englishDescription)}>{tr(props.locale, panel.description, panel.englishDescription)}</small>
          </div>
        </div>
        <GripHorizontal className="scene-simulation-drag-indicator" size={16} aria-hidden="true" />
        <div className="scene-simulation-placement" role="group" aria-label={tr(props.locale, "仿真面板位置", "Simulation panel placement")}>
          <button type="button" data-placement="left" aria-pressed={layout.placement === "left"} aria-label={tr(props.locale, "仿真面板停靠左侧", "Dock simulation panel left")} title={tr(props.locale, "停靠左侧；窄窗临时收起场景树和检查器", "Dock left; narrow windows temporarily fold the outliner and inspector")} onClick={() => layout.place("left")}><PanelLeftClose size={15} /></button>
          <button type="button" data-placement="float" aria-pressed={!layout.docked} aria-label={tr(props.locale, "恢复仿真面板浮动", "Float simulation panel")} title={tr(props.locale, "恢复上次浮动位置和大小", "Restore the previous floating position and size")} onClick={() => layout.place("float")}><Maximize2 size={14} /></button>
          <button type="button" data-placement="right" aria-pressed={layout.placement === "right"} aria-label={tr(props.locale, "仿真面板停靠右侧", "Dock simulation panel right")} title={tr(props.locale, "停靠右侧；窄窗临时收起场景树和检查器", "Dock right; narrow windows temporarily fold the outliner and inspector")} onClick={() => layout.place("right")}><PanelRightClose size={15} /></button>
        </div>
        <button ref={collapseButton} type="button" disabled={layout.narrow} aria-expanded={!collapsed} aria-label={collapsed ? tr(props.locale, "展开仿真面板", "Expand simulation panel") : tr(props.locale, "收起仿真面板", "Collapse simulation panel")} title={layout.narrow ? tr(props.locale, "当前区域过窄，请恢复浮动或加宽窗口", "Float the panel or widen the window to expand") : tr(props.locale, "收起时保留运行状态与场景路径", "Collapsing preserves running state and scene paths")} onClick={() => layout.collapse(!collapsed)}>
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <button type="button" aria-label={tr(props.locale, "关闭仿真面板", "Close simulation panel")} onClick={props.onClose}>
          <X size={16} />
        </button>
      </header>

      <nav className="scene-simulation-tabs" aria-label={tr(props.locale, "仿真插件", "Simulation plugins")}>
        {SCENE_SIMULATION_PANELS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === props.panelId ? "active" : ""}
            aria-pressed={item.id === props.panelId}
            onClick={() => props.onPanelChange(item.id)}
          >
            <span>{item.eyebrow}</span>
            {tr(props.locale, item.label, item.englishLabel)}
          </button>
        ))}
      </nav>

      <div className="scene-simulation-context" aria-label={tr(props.locale, "编辑器上下文", "Editor context")}>
        <span><Box size={13} />{tr(props.locale, "当前场景", "Scene")}</span>
        <strong title={props.activeScene?.name}>{props.activeScene?.name ?? tr(props.locale, "未保存场景", "Unsaved scene")}</strong>
        <i />
        <span>{tr(props.locale, "已选对象", "Selection")}</span>
        <strong title={props.selectedObjectName}>{props.selectedObjectName ?? tr(props.locale, "未选择对象", "No object selected")}</strong>
      </div>

      <div className="scene-simulation-body">
        {props.sceneFlow && props.activeScene && <div hidden={!showSceneFlow}><ScenePlantQuickRun key={`${props.project.id}:${props.activeScene.id}`} {...props.sceneFlow} projectId={props.project.id} scene={props.activeScene} {...(props.selectedObjectId ? { selectedObjectId: props.selectedObjectId } : {})} onStudy={study => { collapse(); props.sceneFlow?.onStudy(study); }} /></div>}
        {hasSceneFlow && props.panelId === "logistics" && <button type="button" className="scene-simulation-advanced" onClick={() => setAdvancedFlow(value => !value)}>{advancedFlow ? "返回场景物流建模" : "高级分析 · 资源池、班次与历史 Study"}</button>}
        <div hidden={showSceneFlow}>
        <Suspense fallback={<div className="scene-simulation-loading"><LoaderCircle className="spin" size={18} />{tr(props.locale, "正在加载仿真引擎", "Loading simulation engine")}</div>}>
          <OperationsCenter
            key={props.project.id}
            embedded
            project={props.project}
            scenes={orderedScenes}
            initialTab={panel.operationsTab}
            {...(props.activeScene?.id ? { initialSceneId: props.activeScene.id } : {})}
            {...(props.selectedObjectId ? { initialObjectId: props.selectedObjectId } : {})}
            {...(panel.commissioningStage ? { initialCommissioningStage: panel.commissioningStage } : {})}
            {...(props.previewSnapshot ? { previewSnapshot: props.previewSnapshot } : {})}
            onBack={props.onClose}
            onOpenDataCenter={props.onOpenDataCenter}
            onOpenSceneTarget={props.onOpenSceneTarget}
          />
        </Suspense>
        </div>
      </div>

      <footer className="scene-simulation-footer">
        <span><Database size={13} />{tr(props.locale, "正式运行自动写入统一 Study", "Formal runs are saved as Studies")}</span>
        <button type="button" onClick={props.onOpenEvidence}>
          {tr(props.locale, "查看运营证据", "Open evidence workbench")}<ArrowUpRight size={14} />
        </button>
      </footer>
      <button
        type="button"
        className="scene-simulation-resize-handle"
        aria-label={tr(props.locale, "调整仿真面板大小", "Resize simulation panel")}
        title={tr(props.locale, "拖动或使用方向键调整面板大小", "Drag or use arrow keys to resize")}
        onPointerDown={(event) => layout.begin("resize", event)}
        onPointerMove={layout.move}
        onPointerUp={layout.finish}
        onPointerCancel={layout.finish}
        onKeyDown={layout.resizeByKey}
      ><Maximize2 size={12} /></button>
    </aside>
  );
}
