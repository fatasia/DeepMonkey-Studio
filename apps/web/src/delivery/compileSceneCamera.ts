import type { SceneSnapshot } from "@bim-studio/contracts";
import { validateRuntimeSceneCamera, type RuntimeSceneCamera, type RuntimeCoordinateFrame } from "@bim-studio/deep-engine/runtime-package";
import { DEFAULT_CAMERA_CONSTRAINTS, normalizeCameraConstraints } from "../appDefaults";
import { resolveOrbitCameraRange } from "../viewer/cameraFraming";

/** Match the published viewer's selected initial camera and clipping calculation. */
export function compileSceneCamera(scene: SceneSnapshot, coordinateFrame?: RuntimeCoordinateFrame): RuntimeSceneCamera {
  const source = scene.cameraViews?.find(view => view.id === scene.defaultCameraViewId)?.camera ?? scene.camera;
  const position = [source.position.x, source.position.y, source.position.z] as const;
  const target = [source.target.x, source.target.y, source.target.z] as const;
  const constraints = normalizeCameraConstraints({ ...DEFAULT_CAMERA_CONSTRAINTS, ...scene.cameraConstraints });
  const distance = Math.hypot(...position.map((value, index) => value - target[index]!));
  const range = source.mode === "orbit" ? resolveOrbitCameraRange(constraints, distance) : constraints;
  return validateRuntimeSceneCamera({ schema: "deep-engine.scene-camera", schemaVersion: coordinateFrame ? 2 : 1,
    ...(coordinateFrame ? { coordinateFrame } : {}),
    id: "scene.camera", revision: 1, position, target,
    verticalFovDegrees: 50, near: range.nearClip, far: range.farClip });
}

export { hasOnlyCompiledCameraFields } from "./sceneInactiveFields";
