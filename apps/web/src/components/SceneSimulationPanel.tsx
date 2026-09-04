import { lazy, Suspense, useMemo } from "react";
import { ArrowUpRight, Box, Database, LoaderCircle, X } from "lucide-react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { OperationsSnapshot } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
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
  const orderedScenes = useMemo(() => {
    if (!props.activeScene) return props.scenes;
    return [props.activeScene, ...props.scenes.filter((scene) => scene.id !== props.activeScene?.id)];
  }, [props.activeScene, props.scenes]);

  return (
    <aside className="scene-simulation-panel" aria-label={tr(props.locale, "场景仿真插件", "Scene simulation plugin")}>
      <header className="scene-simulation-header">
        <div className="scene-simulation-title">
          <span>{panel.eyebrow}</span>
          <div>
            <strong>{tr(props.locale, panel.label, panel.englishLabel)}</strong>
            <small>{tr(props.locale, panel.description, panel.englishDescription)}</small>
          </div>
        </div>
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
        <strong>{props.selectedObjectName ?? tr(props.locale, "未选择，将使用场景默认对象", "None; using scene default")}</strong>
      </div>

      <div className="scene-simulation-body">
        <Suspense fallback={<div className="scene-simulation-loading"><LoaderCircle className="spin" size={18} />{tr(props.locale, "正在加载仿真引擎", "Loading simulation engine")}</div>}>
          <OperationsCenter
            key={panel.id}
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

      <footer className="scene-simulation-footer">
        <span><Database size={13} />{tr(props.locale, "正式运行自动写入统一 Study", "Formal runs are saved as Studies")}</span>
        <button type="button" onClick={props.onOpenEvidence}>
          {tr(props.locale, "查看运营证据", "Open evidence workbench")}<ArrowUpRight size={14} />
        </button>
      </footer>
    </aside>
  );
}
