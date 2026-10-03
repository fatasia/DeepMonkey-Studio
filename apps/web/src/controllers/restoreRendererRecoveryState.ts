import type { ProjectRecord } from "@bim-studio/contracts";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";
import type { ScenePersistenceController } from "./scenePersistenceController";

/** Restore the captured live camera and playhead only after every model is ready. */
export function restoreRendererRecoveryState(state: RendererRecoveryState, project: ProjectRecord,
  applyScene: ScenePersistenceController["applyScene"]): Promise<void> {
  return applyScene(state.scene, false, project, state.readOnly, state.fastRuntime,
    false, true, false, state.animationPlayheadSec, true);
}
