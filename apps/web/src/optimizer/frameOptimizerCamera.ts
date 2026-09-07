import * as THREE from "three";
import { fitPerspectiveBox, resolveOrbitCameraRange } from "../viewer/cameraFraming";
import { DEFAULT_CAMERA_CONSTRAINTS } from "../viewer/viewerEngineTypes";

export function frameOptimizerCamera(runtime: {
  modelBounds?: THREE.Box3;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; update: () => unknown };
}): void {
  if (!runtime.modelBounds) return;
  const direction = runtime.camera.position.clone().sub(runtime.controls.target);
  if (direction.lengthSq() < 0.0001) direction.set(1, 0.7, 1);
  direction.normalize();
  const frame = fitPerspectiveBox(runtime.modelBounds, runtime.camera, DEFAULT_CAMERA_CONSTRAINTS, direction, runtime.camera.up);
  if (!frame) return;
  const range = resolveOrbitCameraRange(DEFAULT_CAMERA_CONSTRAINTS, frame.distance);
  runtime.controls.target.copy(frame.center);
  runtime.camera.position.copy(frame.center).addScaledVector(direction, frame.distance);
  runtime.camera.near = range.nearClip;
  runtime.camera.far = range.farClip;
  runtime.camera.updateProjectionMatrix();
  runtime.controls.update();
}
