import * as THREE from "three";
import type { CameraConstraintsState } from "@bim-studio/contracts";
import { isFiniteBox } from "./sceneObjectUtils";
import { DEFAULT_CAMERA_CONSTRAINTS } from "./viewerEngineTypes";

const RANGE_KEYS = ["minDistance", "maxDistance", "nearClip", "farClip"] as const;
const MIN_RADIUS = 1e-8;
const FRAME_PADDING = 1.15;

/** Only the untouched default range adapts. Any authored range remains a hard limit. */
export function resolveOrbitCameraRange(state: CameraConstraintsState, targetDistance: number): CameraConstraintsState {
  if (!RANGE_KEYS.every(key => state[key] === DEFAULT_CAMERA_CONSTRAINTS[key])
    || !Number.isFinite(targetDistance) || targetDistance <= 0) return { ...state };
  return {
    ...state,
    minDistance: Math.min(state.minDistance, Math.max(MIN_RADIUS, targetDistance * 0.1)),
    maxDistance: Math.max(state.maxDistance, targetDistance * 2),
    nearClip: Math.min(state.nearClip, Math.max(MIN_RADIUS, targetDistance * 0.01)),
    farClip: Math.max(state.farClip, targetDistance * 100),
  };
}

/** Fit all eight world-space corners, using both viewport axes and the camera's zoom. */
export function fitPerspectiveBox(
  box: THREE.Box3,
  camera: Pick<THREE.PerspectiveCamera, "fov" | "aspect" | "zoom">,
  constraints: CameraConstraintsState,
  direction: THREE.Vector3,
  up = new THREE.Vector3(0, 1, 0),
): { center: THREE.Vector3; distance: number } | undefined {
  if (!isFiniteBox(box) || box.isEmpty() || box.getSize(new THREE.Vector3()).length() <= MIN_RADIUS
    || ![camera.fov, camera.aspect, camera.zoom, ...direction.toArray(), ...up.toArray()].every(Number.isFinite)
    || camera.fov <= 0 || camera.fov >= 180 || camera.aspect <= 0 || camera.zoom <= 0
    || direction.lengthSq() === 0 || up.lengthSq() === 0) return undefined;
  const forward = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(up, forward).normalize();
  if (right.lengthSq() === 0) return undefined;
  const vertical = new THREE.Vector3().crossVectors(forward, right);
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom;
  const tanX = tanY * camera.aspect;
  const center = box.getCenter(new THREE.Vector3());
  const corner = new THREE.Vector3();
  let distance = 0;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corner.set(x, y, z).sub(center);
    const depth = corner.dot(forward);
    distance = Math.max(distance, depth + FRAME_PADDING * Math.abs(corner.dot(right)) / tanX,
      depth + FRAME_PADDING * Math.abs(corner.dot(vertical)) / tanY);
  }
  const range = resolveOrbitCameraRange(constraints, distance);
  return { center, distance: THREE.MathUtils.clamp(distance, range.minDistance, range.maxDistance) };
}
