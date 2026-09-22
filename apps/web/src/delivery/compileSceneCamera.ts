import type { SceneSnapshot } from "@bim-studio/contracts";
import { validateRuntimeSceneCamera, type RuntimeSceneCamera, type RuntimeCoordinateFrame } from "@bim-studio/deep-engine/runtime-package";
import { DEFAULT_CAMERA_CONSTRAINTS, normalizeCameraConstraints } from "../appDefaults";
import { resolveOrbitCameraRange } from "../viewer/cameraFraming";
import { DEFAULT_NAVIGATION_SETTINGS, normalizeNavigationSettings } from "../navigationSettings";
import { resolveNativeCameraCompatibility } from "./cameraFallback";

/** Match the published viewer's selected initial camera and clipping calculation. */
export function compileSceneCamera(scene: SceneSnapshot, coordinateFrame?: RuntimeCoordinateFrame): RuntimeSceneCamera {
  const source = scene.cameraViews?.find(view => view.id === scene.defaultCameraViewId)?.camera ?? scene.camera;
  const position = [source.position.x, source.position.y, source.position.z] as const;
  const target = [source.target.x, source.target.y, source.target.z] as const;
  const constraints = normalizeCameraConstraints({ ...DEFAULT_CAMERA_CONSTRAINTS, ...scene.cameraConstraints });
  const distance = Math.hypot(...position.map((value, index) => value - target[index]!));
  const range = source.mode === "orbit" ? resolveOrbitCameraRange(constraints, distance) : constraints;
  const navigation = normalizeNavigationSettings(scene.navigationSettings ?? DEFAULT_NAVIGATION_SETTINGS);
  const compatibility = resolveNativeCameraCompatibility(source, navigation);
  const hasAuthoredControls = scene.cameraConstraints !== undefined
    || scene.navigationSettings !== undefined || source.mode !== "orbit";
  const cameraViews = scene.cameraViews?.length && typeof scene.defaultCameraViewId === "string"
    && scene.cameraViews.some(view => view.id === scene.defaultCameraViewId)
    && scene.cameraViews.every(view => {
      const viewNavigation = navigation;
      return !resolveNativeCameraCompatibility(view.camera, viewNavigation).fallback;
    })
    ? scene.cameraViews.map(view => ({ id: view.id, name: view.name,
      position: [view.camera.position.x, view.camera.position.y, view.camera.position.z] as const,
      target: [view.camera.target.x, view.camera.target.y, view.camera.target.z] as const }))
    : undefined;
  // v4 freezes author navigation behavior with the camera. Older schemas stay
  // reader-only so a Native package never has to infer controls from defaults.
  return validateRuntimeSceneCamera({ schema: "deep-engine.scene-camera",
    schemaVersion: cameraViews ? 5 : hasAuthoredControls ? 4 : coordinateFrame ? 3 : 1,
    ...(coordinateFrame ? { coordinateFrame } : {}),
    id: "scene.camera", revision: 1, position, target,
    verticalFovDegrees: 50, near: range.nearClip, far: range.farClip,
    ...(hasAuthoredControls || cameraViews ? { controls: { mode: compatibility.mode, minDistance: range.minDistance, maxDistance: range.maxDistance,
      minPolarAngleDegrees: range.minPolarAngle, maxPolarAngleDegrees: range.maxPolarAngle,
      collisionEnabled: range.collisionEnabled, collisionRadius: range.collisionRadius,
      walkSpeed: navigation.walkSpeed, flySpeed: navigation.flySpeed,
      sprintMultiplier: navigation.sprintMultiplier, eyeHeight: navigation.eyeHeight,
      gravity: navigation.gravity, jumpSpeed: navigation.jumpSpeed, stepHeight: navigation.stepHeight,
      maxSlopeAngleDegrees: navigation.maxSlopeAngle } } : {}),
    ...(cameraViews ? { cameraViews, defaultCameraViewId: scene.defaultCameraViewId } : {}) });
}

export { hasOnlyCompiledCameraFields } from "./sceneInactiveFields";
