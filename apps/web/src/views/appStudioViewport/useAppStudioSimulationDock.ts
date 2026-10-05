import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import type { AppStudioController } from "../AppStudioShell";
import type { PlantLitePlaybackFrame } from "../../components/plantLitePlaybackModel";
import type { SceneSimulationPanelId } from "../../simulation/sceneSimulationRegistry";
import type { SimulationDockReservation } from "../../simulation/sceneSimulationLayout";
import type { SceneDirectorWorkspace } from "../../components/SceneTimelinePanel";
import { useSceneSimulationOverlay } from "../../hooks/useSceneSimulationOverlay";
import { useScenePlantPlayback } from "../../hooks/useScenePlantPlayback";
import { translate as tr } from "../../i18n";

/**
 * AppStudioViewport 仿真停靠域状态(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出自定义 hook,代码逐行同源;语义零变化)。
 *
 * 职责:仿真插件面板 id 与停靠位、DES 研究轨迹(研究/帧/轨道跟随)、时间线工作区、
 * 场景切换重置、仿真对象定位跳转与时间线工作区切换动作。
 */
export interface AppStudioSimulationDockState {
  readonly simulationPanelId: SceneSimulationPanelId | undefined;
  readonly setSimulationPanelId: Dispatch<SetStateAction<SceneSimulationPanelId | undefined>>;
  readonly simulationDock: SimulationDockReservation;
  readonly setSimulationDock: Dispatch<SetStateAction<SimulationDockReservation>>;
  readonly simulationStudy: PlantLiteStudyRecord | undefined;
  readonly setSimulationStudy: Dispatch<SetStateAction<PlantLiteStudyRecord | undefined>>;
  readonly simulationFrame: PlantLitePlaybackFrame | null;
  readonly setSimulationFrame: Dispatch<SetStateAction<PlantLitePlaybackFrame | null>>;
  readonly simulationTrack: boolean;
  readonly setSimulationTrack: Dispatch<SetStateAction<boolean>>;
  readonly directorWorkspace: SceneDirectorWorkspace;
  readonly setDirectorWorkspace: Dispatch<SetStateAction<SceneDirectorWorkspace>>;
  readonly activeSimulationStudy: PlantLiteStudyRecord | undefined;
  readonly resolveSimulationPosition: (id: string) => { x: number; y: number; z: number } | undefined;
  readonly showSimulationStudy: (study: PlantLiteStudyRecord) => void;
  readonly toggleSimulationPanel: (panel: SceneSimulationPanelId) => void;
  readonly openDirector: (workspace: SceneDirectorWorkspace) => void;
  readonly openSimulationTarget: (sceneId: string, objectId: string) => void;
}

export function useAppStudioSimulationDock(controller: AppStudioController): AppStudioSimulationDockState {
  const {
    activeScene,
    animationOpen,
    animationPlaying,
    engine,
    navigate,
    pendingSceneFocusRef,
    project,
    route,
    scenes,
    setActiveScene,
    setAnimationOpen,
    setEnvironmentOpen,
    setPhysicsOpen,
    setSceneBehaviorOpen,
    setXrPanelOpen,
    toggleSceneAnimation,
    locale,
    setMessage,
  } = controller;
  const [simulationPanelId, setSimulationPanelId] = useState<SceneSimulationPanelId>();
  const [simulationDock, setSimulationDock] = useState<SimulationDockReservation>({ placement: "float", collapsed: false, width: 0 });
  const [simulationStudy, setSimulationStudy] = useState<PlantLiteStudyRecord>();
  const [simulationFrame, setSimulationFrame] = useState<PlantLitePlaybackFrame | null>(null);
  const [simulationTrack, setSimulationTrack] = useState(false);
  const [directorWorkspace, setDirectorWorkspace] = useState<SceneDirectorWorkspace>("timeline");
  const resolveSimulationPosition = useCallback((id: string) => engine?.getModelTransform(id)?.position, [engine, controller.bindings.state.revision]);
  const activeSimulationStudy = route.view === "studio" && simulationPanelId && simulationStudy?.model?.sceneBinding?.sceneId === activeScene?.id ? simulationStudy : undefined;
  useEffect(() => { setSimulationStudy(undefined); setSimulationFrame(null); setSimulationTrack(false); setDirectorWorkspace("timeline"); }, [project?.id, activeScene?.id]);
  useScenePlantPlayback(engine, animationOpen && simulationTrack ? activeSimulationStudy?.model : undefined, simulationFrame);
  const showSimulationStudy = (study: PlantLiteStudyRecord) => {
    if (study.model?.sceneBinding?.sceneId !== activeScene?.id || study.projectId !== project?.id) return;
    setSimulationStudy(study); setSimulationTrack(true); setDirectorWorkspace("timeline"); setAnimationOpen(true);
    if (animationPlaying) toggleSceneAnimation();
  };
  useSceneSimulationOverlay(engine, activeScene, route.view === "studio" && Boolean(simulationPanelId), controller.bindings.state.revision);
  function toggleSimulationPanel(panel: SceneSimulationPanelId) {
    setSimulationPanelId((current) => current === panel ? undefined : panel);
    setAnimationOpen(false);
    setEnvironmentOpen(false);
    setPhysicsOpen(false);
    setSceneBehaviorOpen(false);
    setXrPanelOpen(false);
  }
  function openDirector(workspace: SceneDirectorWorkspace) {
    if (workspace !== "timeline") setSimulationTrack(false);
    setDirectorWorkspace(workspace);
    setAnimationOpen(true);
  }
  function openSimulationTarget(sceneId: string, objectId: string) {
    const targetScene = scenes.find((scene) => scene.id === sceneId);
    if (!targetScene) {
      setMessage(tr(locale, "关联的三维场景已不存在", "The linked 3D scene no longer exists"));
      return;
    }
    if (activeScene?.id === sceneId) {
      engine?.select(objectId);
      engine?.focusModel(objectId);
      setMessage(tr(locale, "已在当前视口定位仿真对象", "Simulation target focused in the viewport"));
      return;
    }
    const targetLabel = targetScene.models.find((item) => item.modelId === objectId)?.name
      ?? targetScene.primitives.find((item) => item.modelId === objectId)?.name;
    pendingSceneFocusRef.current = { sceneId, objectId, ...(targetLabel ? { label: targetLabel } : {}) };
    setActiveScene(undefined);
    setSimulationPanelId(undefined);
    navigate({ view: "studio", sceneId });
  }
  return {
    simulationPanelId, setSimulationPanelId,
    simulationDock, setSimulationDock,
    simulationStudy, setSimulationStudy,
    simulationFrame, setSimulationFrame,
    simulationTrack, setSimulationTrack,
    directorWorkspace, setDirectorWorkspace,
    activeSimulationStudy,
    resolveSimulationPosition,
    showSimulationStudy,
    toggleSimulationPanel,
    openDirector,
    openSimulationTarget,
  };
}
