import type { CameraState } from "@bim-studio/contracts";

/**
 * Editing always starts from a predictable orbit camera. Experience navigation is
 * still preserved in the saved scene and restored by read-only preview runtimes.
 */
export function resolveSceneEntryCamera(
  camera: CameraState,
  options: { readOnly: boolean; safeAuthoringEntry: boolean },
): CameraState {
  if (options.readOnly || !options.safeAuthoringEntry) return camera;
  return { ...camera, mode: "orbit", avatarVisible: false };
}
