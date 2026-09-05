import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUpRight, Box, ChevronDown, ChevronUp, Database, GripHorizontal, LoaderCircle, Maximize2, X } from "lucide-react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { OperationsSnapshot } from "../api";
import { ScenePlantQuickRun, type ScenePlantQuickRunProps } from "./ScenePlantQuickRun";
import { translate as tr, type AppLocale } from "../i18n";
import {
  SCENE_SIMULATION_PANELS,
  sceneSimulationPanel,
  type SceneSimulationPanelId,
} from "../simulation/sceneSimulationRegistry";

const OperationsCenter = lazy(() => import("./OperationsCenter").then((module) => ({ default: module.OperationsCenter })));
const PANEL_LAYOUT_KEY = "bim-studio.scene-simulation-panel-layout.v1";
const PANEL_MARGIN = 10;
const PANEL_MIN_WIDTH = 420;
const PANEL_MIN_HEIGHT = 360;

interface PanelLayout { left: number; top: number; width: number; height: number }
interface PointerOperation { kind: "move" | "resize"; pointerId: number; x: number; y: number; layout: PanelLayout }

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
}

/**
 * 3D 编辑器中的仿真插件宿主。业务引擎与 Study 仍由 OperationsCenter 统一提供。
 */
export function SceneSimulationPanel(props: Props) {
  const panel = sceneSimulationPanel(props.panelId);
  const panelRef = useRef<HTMLElement>(null);
  const pointerOperationRef = useRef<PointerOperation | undefined>(undefined);
  const [layout, setLayout] = useState<PanelLayout>();
  const [collapsed, setCollapsed] = useState(false);
  const [advancedFlow, setAdvancedFlow] = useState(false);
  const hasSceneFlow = Boolean(props.sceneFlow && props.activeScene);
  const showSceneFlow = hasSceneFlow && props.panelId === "logistics" && !advancedFlow;
  const orderedScenes = useMemo(() => {
    if (!props.activeScene) return props.scenes;
    return [props.activeScene, ...props.scenes.filter((scene) => scene.id !== props.activeScene?.id)];
  }, [props.activeScene, props.scenes]);

  useEffect(() => {
    const element = panelRef.current;
    const container = element?.offsetParent as HTMLElement | null;
    if (!element || !container) return;
    const bounds = container.getBoundingClientRect();
    setLayout((current) => constrainPanelLayout(current ?? readPanelLayout() ?? defaultPanelLayout(bounds.width, bounds.height), bounds.width, bounds.height, collapsed));
    const observer = new ResizeObserver(() => {
      const nextBounds = container.getBoundingClientRect();
      setLayout((current) => current && constrainPanelLayout(current, nextBounds.width, nextBounds.height, collapsed));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [collapsed]);

  function beginPointerOperation(kind: PointerOperation["kind"], event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !layout || (kind === "move" && (event.target as Element).closest("button"))) return;
    pointerOperationRef.current = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, layout };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function updatePointerOperation(event: ReactPointerEvent<HTMLElement>) {
    const operation = pointerOperationRef.current;
    const element = panelRef.current;
    const container = element?.offsetParent as HTMLElement | null;
    if (!operation || operation.pointerId !== event.pointerId || !container) return;
    const dx = event.clientX - operation.x;
    const dy = event.clientY - operation.y;
    const bounds = container.getBoundingClientRect();
    const next = operation.kind === "move"
      ? { ...operation.layout, left: operation.layout.left + dx, top: operation.layout.top + dy }
      : { ...operation.layout, width: operation.layout.width + dx, height: operation.layout.height + dy };
    setLayout(constrainPanelLayout(next, bounds.width, bounds.height, collapsed));
  }

  function finishPointerOperation(event: ReactPointerEvent<HTMLElement>) {
    if (pointerOperationRef.current?.pointerId !== event.pointerId) return;
    pointerOperationRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (layout) savePanelLayout(layout);
  }

  const panelStyle = layout ? ({ left: layout.left, top: layout.top, width: collapsed ? Math.min(320, layout.width) : layout.width, height: collapsed ? Math.min(48, layout.height) : layout.height } satisfies CSSProperties) : undefined;

  return (
    <aside ref={panelRef} style={panelStyle} className={`scene-simulation-panel${collapsed ? " is-collapsed" : ""}`} aria-label={tr(props.locale, "场景仿真插件", "Scene simulation plugin")}>
      <header
        className="scene-simulation-header"
        title={tr(props.locale, "拖动窗口；右下角可调整大小", "Drag the window; resize from the bottom-right corner")}
        onPointerDown={(event) => beginPointerOperation("move", event)}
        onPointerMove={updatePointerOperation}
        onPointerUp={finishPointerOperation}
        onPointerCancel={finishPointerOperation}
      >
        <div className="scene-simulation-title">
          <span>{panel.eyebrow}</span>
          <div>
            <strong>{tr(props.locale, panel.label, panel.englishLabel)}</strong>
            <small>{tr(props.locale, panel.description, panel.englishDescription)}</small>
          </div>
        </div>
        <GripHorizontal className="scene-simulation-drag-indicator" size={16} aria-hidden="true" />
        <button type="button" aria-expanded={!collapsed} aria-label={collapsed ? tr(props.locale, "展开仿真面板", "Expand simulation panel") : tr(props.locale, "收起仿真面板", "Collapse simulation panel")} title={tr(props.locale, "收起时保留运行状态与场景路径", "Collapsing preserves running state and scene paths")} onClick={() => setCollapsed((value) => !value)}>
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
        <strong>{props.activeScene?.name ?? tr(props.locale, "未保存场景", "Unsaved scene")}</strong>
        <i />
        <span>{tr(props.locale, "已选对象", "Selection")}</span>
        <strong>{props.selectedObjectName ?? tr(props.locale, "未选择对象", "No object selected")}</strong>
      </div>

      <div className="scene-simulation-body">
        {props.sceneFlow && props.activeScene && <div hidden={!showSceneFlow}><ScenePlantQuickRun key={`${props.project.id}:${props.activeScene.id}`} {...props.sceneFlow} projectId={props.project.id} scene={props.activeScene} {...(props.selectedObjectId ? { selectedObjectId: props.selectedObjectId } : {})} onStudy={study => { setCollapsed(true); props.sceneFlow?.onStudy(study); }} /></div>}
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
        title={tr(props.locale, "拖动调整面板大小", "Drag to resize")}
        onPointerDown={(event) => beginPointerOperation("resize", event)}
        onPointerMove={updatePointerOperation}
        onPointerUp={finishPointerOperation}
        onPointerCancel={finishPointerOperation}
      ><Maximize2 size={12} /></button>
    </aside>
  );
}

export function constrainPanelLayout(layout: PanelLayout, boundsWidth: number, boundsHeight: number, collapsed = false): PanelLayout {
  const marginX = Math.min(PANEL_MARGIN, Math.max(0, boundsWidth / 2));
  const marginY = Math.min(PANEL_MARGIN, Math.max(0, boundsHeight / 2));
  const availableWidth = Math.max(0, boundsWidth - marginX * 2);
  const availableHeight = Math.max(0, boundsHeight - marginY * 2);
  const width = Math.min(Math.max(Math.min(PANEL_MIN_WIDTH, availableWidth), layout.width), availableWidth);
  const height = Math.min(Math.max(Math.min(PANEL_MIN_HEIGHT, availableHeight), layout.height), availableHeight);
  return {
    left: Math.min(Math.max(marginX, layout.left), Math.max(marginX, boundsWidth - (collapsed ? Math.min(320, width) : width) - marginX)),
    top: Math.min(Math.max(marginY, layout.top), Math.max(marginY, boundsHeight - (collapsed ? Math.min(48, height) : height) - marginY)),
    width,
    height,
  };
}

function defaultPanelLayout(boundsWidth: number, boundsHeight: number): PanelLayout {
  const width = Math.min(520, Math.max(280, boundsWidth - PANEL_MARGIN * 2));
  const height = Math.min(610, Math.max(280, boundsHeight - 116));
  return { left: Math.max(PANEL_MARGIN, boundsWidth - width - 18), top: Math.min(84, Math.max(PANEL_MARGIN, boundsHeight - height - PANEL_MARGIN)), width, height };
}

function readPanelLayout(): PanelLayout | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) ?? "null") as Partial<PanelLayout> | null;
    return value && [value.left, value.top, value.width, value.height].every(Number.isFinite) ? value as PanelLayout : undefined;
  } catch { return undefined; }
}

function savePanelLayout(layout: PanelLayout): void {
  try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 私密或受限浏览器中仅保留本次布局。 */ }
}
