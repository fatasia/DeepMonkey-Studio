import * as THREE from "three";
import type { MeasureMode } from "./ViewerEngine";

export function constrainMeasurementEnd(start: THREE.Vector3, end: THREE.Vector3, kind: MeasureMode): THREE.Vector3 {
  if (kind === "horizontal") return new THREE.Vector3(end.x, start.y, end.z);
  if (kind === "vertical") return new THREE.Vector3(start.x, end.y, start.z);
  return end.clone();
}

export function measurementAngle(vertex: THREE.Vector3, firstArm: THREE.Vector3, secondArm: THREE.Vector3): number {
  const first = firstArm.clone().sub(vertex);
  const second = secondArm.clone().sub(vertex);
  if (first.lengthSq() < 1e-12 || second.lengthSq() < 1e-12) return 0;
  return first.angleTo(second);
}

export function elevationSegment(point: THREE.Vector3, datum = 0): [THREE.Vector3, THREE.Vector3] {
  return [new THREE.Vector3(point.x, datum, point.z), point.clone()];
}

export function projectRayToVerticalAxis(ray: THREE.Ray, start: THREE.Vector3): THREE.Vector3 {
  const bottom = start.clone().add(new THREE.Vector3(0, -100_000, 0));
  const top = start.clone().add(new THREE.Vector3(0, 100_000, 0));
  const projected = new THREE.Vector3();
  ray.distanceSqToSegment(bottom, top, undefined, projected);
  return projected;
}
