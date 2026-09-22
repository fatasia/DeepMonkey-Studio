import type { CameraState, NavigationSettingsState } from "@bim-studio/contracts";

export type NativeCameraFallbackReason = "avatar" | "ground-solver";

export interface NativeCameraCompatibility {
  readonly mode: CameraState["mode"];
  readonly fallback: boolean;
  readonly reasons: readonly NativeCameraFallbackReason[];
}

/**
 * Native can consume first/third-person locomotion only while its ground
 * solver fields stay disabled. Avatar rendering is also a Web-only concern;
 * dropping it from the payload must remain visible through deferred evidence.
 */
export function resolveNativeCameraCompatibility(
  camera: Pick<CameraState, "mode"> & Partial<Pick<CameraState, "avatarVisible">>,
  navigation: Pick<NavigationSettingsState, "stepHeight" | "maxSlopeAngle">,
): NativeCameraCompatibility {
  const reasons: NativeCameraFallbackReason[] = [];
  if (camera.avatarVisible === true) reasons.push("avatar");
  if (camera.mode !== "orbit"
    && (navigation.stepHeight > 0 || navigation.maxSlopeAngle > 0)) reasons.push("ground-solver");
  return { mode: reasons.length ? "orbit" : camera.mode, fallback: reasons.length > 0, reasons };
}
