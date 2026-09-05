import { useEffect } from "react";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createSimulationOverlayAdapter } from "../viewer/simulationOverlayAdapter";
import { simulationOverlayPaths } from "../simulation/sceneSimulationOverlay";

/** 仅仿真面板开启时展示建模路径；切场景、切引擎、关闭面板均释放覆盖层。 */
export function useSceneSimulationOverlay(engine: ViewerEngine | undefined, scene: SceneSnapshot | undefined, enabled: boolean, revision: number) {
  useEffect(() => {
    if (!engine || !scene || !enabled) return;
    const overlay = createSimulationOverlayAdapter(engine.scene);
    overlay.replacePaths(simulationOverlayPaths(scene.simulationEntities ?? [], (id) => engine.getModelTransform(id)?.position));
    return () => overlay.clear();
  }, [engine, scene?.id, scene?.simulationEntities, enabled, revision]);
}
