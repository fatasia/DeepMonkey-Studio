import type { ViewerEngine } from "../viewer/ViewerEngine";

export interface EditorSceneRuntimeOwner {
  readonly sceneId: string | undefined;
  readonly engine: ViewerEngine | undefined;
  readonly busy: boolean;
  readonly rendererSwitching: boolean;
}

/** Editor writes belong to the current author viewport, never an embedded preview. */
export function readEditorSceneRuntime(owner: EditorSceneRuntimeOwner, sceneId: string): ViewerEngine | undefined {
  if (owner.sceneId !== sceneId || owner.busy || owner.rendererSwitching) return undefined;
  return owner.engine?.isSceneSnapshotReady(sceneId) ? owner.engine : undefined;
}
