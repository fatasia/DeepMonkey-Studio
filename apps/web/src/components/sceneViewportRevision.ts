import type { SceneDocument } from "@bim-studio/contracts";

/** Stable for equivalent 3D content even when a 2D command recreates parent objects. */
export function sceneViewportRevision(scene: SceneDocument): string {
  return JSON.stringify(scene);
}
