import type { SceneInteractionScriptState } from "@bim-studio/contracts";

/** Event actions invalidate through the viewer API; only trusted code may own an untracked loop. */
export function interactionRenderActivity(scripts: readonly SceneInteractionScriptState[]): boolean {
  return scripts.some(script => script.enabled && script.code.trim().length > 0);
}
